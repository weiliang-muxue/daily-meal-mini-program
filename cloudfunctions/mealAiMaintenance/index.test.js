'use strict'

const assert = require('assert')
const Module = require('module')
const {
  AI_DATA_CONSENT_VERSION,
  AI_CONTRACT_VERSION,
  AI_PLANNER_VERSION,
  TASK_SCHEMA_VERSION,
} = require('./core')

assert.strictEqual(AI_DATA_CONSENT_VERSION, 2)
assert.strictEqual(AI_CONTRACT_VERSION, 2)
assert.strictEqual(AI_PLANNER_VERSION, '7')
assert.strictEqual(TASK_SCHEMA_VERSION, 3)

const CURRENT_AI_VERSIONS = Object.freeze({
  taskSchemaVersion: TASK_SCHEMA_VERSION,
  contractVersion: AI_CONTRACT_VERSION,
  plannerVersion: AI_PLANNER_VERSION,
  aiDataConsentVersion: AI_DATA_CONSENT_VERSION,
  providerRevision: 7,
  providerConfigVersion: 'c'.repeat(64),
})

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

const stores = new Map()
const queryLog = []
let source = 'wx_trigger'
let failRemoveOnce = ''
const CACHE_NAMESPACE = 'a'.repeat(32)

function store(name) {
  if (!stores.has(name)) stores.set(name, new Map())
  return stores.get(name)
}

function reference(name, id) {
  return {
    async get() {
      const value = store(name).get(id)
      return { data: value === undefined ? null : clone(value) }
    },
    async set({ data }) {
      store(name).set(id, clone(data))
      return { stats: { updated: 1 } }
    },
    async update({ data }) {
      const current = store(name).get(id) || {}
      store(name).set(id, { ...clone(current), ...clone(data) })
      return { stats: { updated: 1 } }
    },
    async remove() {
      if (failRemoveOnce === `${name}/${id}`) {
        failRemoveOnce = ''
        const error = new Error('private provider detail must never be logged')
        error.code = 'DATABASE_TIMEOUT'
        throw error
      }
      const deleted = store(name).delete(id)
      return { stats: { removed: deleted ? 1 : 0 } }
    },
  }
}

function matches(value, condition) {
  if (condition && condition.$operator === 'lte') return Number(value) <= condition.value
  return value === condition
}

function query(name, criteria = {}) {
  const state = { orderField: '', orderDirection: 'asc', limit: 100 }
  return {
    orderBy(field, direction) {
      state.orderField = field
      state.orderDirection = direction
      return this
    },
    limit(value) { state.limit = value; return this },
    async get() {
      queryLog.push({ name, criteria: clone(criteria), ...state })
      let values = [...store(name).entries()].map(([id, value]) => ({ _id: id, ...clone(value) }))
        .filter((item) => Object.entries(criteria).every(([field, condition]) => matches(item[field], condition)))
      if (state.orderField) {
        const direction = state.orderDirection === 'desc' ? -1 : 1
        values.sort((a, b) => (Number(a[state.orderField]) - Number(b[state.orderField])) * direction)
      }
      return { data: values.slice(0, state.limit) }
    },
  }
}

function collection(name) {
  return {
    doc(id) { return reference(name, id) },
    where(criteria) { return query(name, criteria) },
  }
}

const database = {
  command: { lte(value) { return { $operator: 'lte', value } } },
  collection,
  async runTransaction(callback) { return callback({ collection }) },
}

const cloudStub = {
  DYNAMIC_CURRENT_ENV: 'dynamic-current-env',
  init() {},
  database() { return database },
  getWXContext() { return { SOURCE: source } },
}

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloudStub
  return originalLoad.call(this, request, parent, isMain)
}
let maintenance
try { maintenance = require('./index') } finally { Module._load = originalLoad }

function reset() {
  stores.clear()
  queryLog.length = 0
  source = 'wx_trigger'
  failRemoveOnce = ''
}

function put(name, id, value) { store(name).set(id, clone(value)) }
function get(name, id) { return clone(store(name).get(id)) }
function snapshot(name) {
  return [...store(name).entries()]
    .map(([id, value]) => [id, clone(value)])
    .sort(([left], [right]) => left.localeCompare(right))
}
function task(owner, status, expiresAt, epoch = 1, cacheNamespace = CACHE_NAMESPACE) {
  return {
    taskSchemaVersion: 3, owner, status, expiresAt, generationEpoch: epoch, taskRevision: 2,
    cacheNamespace,
    ...CURRENT_AI_VERSIONS,
    planStateFingerprint: 'a'.repeat(64),
    input: { healthNotes: 'private body' },
    outline: { status: 'completed', result: { title: 'private outline' } },
    chunks: [{ status: 'running', result: { days: ['private chunk'] } }],
    finalize: { status: 'pending' },
    createdAt: 100, createdAtMs: 100, updatedAt: 150, updatedAtMs: 150,
  }
}

async function tests() {
  reset()
  source = 'wx_client'
  const denied = await maintenance.main({ OPENID: 'untrusted' })
  assert.deepStrictEqual(denied, { success: false, errorCode: 'TRIGGER_ONLY' })
  assert.strictEqual(queryLog.length, 0, '非定时调用不能访问任务集合')

  reset()
  const now = Date.now()
  put('meal_ai_tasks', 'task-owner-a', task('owner-a', 'queued', now - 10, 4))
  put('meal_ai_tasks', 'task-owner-b', task('owner-b', 'validating', now - 5, 8))
  put('meal_ai_tasks', 'task-future', task('owner-a', 'running', now + 60_000, 4))
  put('meal_ai_tasks', 'task-terminal', task('owner-a', 'failed', now - 100, 4))
  put('meal_ai_controls', 'owner-a', { owner: 'owner-a', cacheNamespace: CACHE_NAMESPACE, activeTaskId: 'task-owner-a', generationEpoch: 4 })
  put('meal_ai_controls', 'owner-b', { owner: 'owner-b', cacheNamespace: CACHE_NAMESPACE, activeTaskId: 'newer-task', generationEpoch: 9 })
  put('meal_user_states', 'owner-a', { draftPlan: { id: 'draft-kept' }, activePlan: { id: 'active-kept' } })
  put('meal_ai_shards', 'shard-a', { owner: 'owner-a', taskId: 'task-owner-a', cacheNamespace: CACHE_NAMESPACE, body: 'private shard' })
  put('meal_ai_shards', 'shard-cross-owner', { owner: 'owner-b', taskId: 'task-owner-a', cacheNamespace: CACHE_NAMESPACE, body: 'other private shard' })

  const logs = []
  const originalInfo = console.info
  console.info = (...values) => { logs.push(values.join(' ')) }
  let first
  try { first = await maintenance.main({ OPENID: 'must-not-be-used', expiresAt: 0 }) } finally { console.info = originalInfo }
  assert.strictEqual(first.compactedTasks, 2)
  assert.strictEqual(first.controlsCleared, 1)
  assert.strictEqual(first.shardsDeleted, 1)
  assert.strictEqual(first.shardTasksCompleted, 2)
  assert.strictEqual(get('meal_ai_tasks', 'task-owner-a').input, undefined)
  assert.strictEqual(get('meal_ai_tasks', 'task-owner-a').status, 'expired')
  assert.strictEqual(get('meal_ai_tasks', 'task-owner-a').planStateFingerprint, 'a'.repeat(64))
  assert.strictEqual(get('meal_ai_tasks', 'task-owner-a').cacheNamespace, CACHE_NAMESPACE)
  assert.strictEqual(get('meal_ai_tasks', 'task-owner-a').shardCleanupPending, false)
  assert.strictEqual(get('meal_ai_controls', 'owner-a').activeTaskId, '')
  assert.strictEqual(get('meal_ai_controls', 'owner-b').activeTaskId, 'newer-task')
  assert.deepStrictEqual(get('meal_user_states', 'owner-a'), {
    draftPlan: { id: 'draft-kept' }, activePlan: { id: 'active-kept' },
  })
  assert.strictEqual(get('meal_ai_shards', 'shard-a'), undefined)
  assert.strictEqual(get('meal_ai_shards', 'shard-cross-owner').owner, 'owner-b')
  assert(logs.every((line) => !/private|draft-kept|active-kept|owner-a|task-owner-a/.test(line)), '日志不能含任务正文或身份')
  assert(queryLog.some((entry) => entry.name === 'meal_ai_tasks' && entry.criteria.status === 'queued'))
  assert(queryLog.some((entry) => entry.name === 'meal_ai_tasks' && entry.criteria.status === 'validating'))

  const second = await maintenance._test.runMaintenance(database, Date.now())
  assert.strictEqual(second.compactedTasks, 0, '重复投递必须幂等')
  assert.strictEqual(second.shardsDeleted, 0)

  reset()
  const refusedVersions = [
    { name: 'future-task-schema', taskSchemaVersion: TASK_SCHEMA_VERSION + 1, contractVersion: AI_CONTRACT_VERSION, plannerVersion: AI_PLANNER_VERSION },
    { name: 'invalid-task-schema-string', taskSchemaVersion: String(TASK_SCHEMA_VERSION), contractVersion: AI_CONTRACT_VERSION, plannerVersion: AI_PLANNER_VERSION },
    { name: 'invalid-task-schema-zero', taskSchemaVersion: 0, contractVersion: AI_CONTRACT_VERSION, plannerVersion: AI_PLANNER_VERSION },
    { name: 'future-contract', contractVersion: AI_CONTRACT_VERSION + 1, plannerVersion: AI_PLANNER_VERSION },
    { name: 'future-planner', contractVersion: AI_CONTRACT_VERSION, plannerVersion: String(Number(AI_PLANNER_VERSION) + 1) },
  ]
  refusedVersions.forEach((version, index) => {
    const activeId = `task-active-${version.name}`
    const terminalId = `task-terminal-${version.name}`
    const activeOwner = `owner-active-${version.name}`
    const terminalOwner = `owner-terminal-${version.name}`
    put('meal_ai_tasks', activeId, {
      ...task(activeOwner, 'queued', now - 1, index + 20),
      ...version,
      retentionSchemaVersion: 1,
      shardCleanupPending: true,
      shardCleanupUpdatedAtMs: now - 1,
    })
    put('meal_ai_controls', activeOwner, {
      owner: activeOwner,
      cacheNamespace: CACHE_NAMESPACE,
      activeTaskId: activeId,
      generationEpoch: index + 20,
    })
    put('meal_ai_shards', `shard-active-${version.name}`, {
      owner: activeOwner,
      taskId: activeId,
      cacheNamespace: CACHE_NAMESPACE,
      body: 'private active body',
    })
    put('meal_ai_tasks', terminalId, {
      ...task(terminalOwner, 'failed', now - 1, index + 30),
      ...version,
      retentionSchemaVersion: 1,
      shardCleanupPending: true,
      shardCleanupUpdatedAtMs: now - 1,
    })
    put('meal_ai_shards', `shard-terminal-${version.name}`, {
      owner: terminalOwner,
      taskId: terminalId,
      cacheNamespace: CACHE_NAMESPACE,
      body: 'private terminal body',
    })
  })
  const refusedBefore = {
    tasks: snapshot('meal_ai_tasks'),
    controls: snapshot('meal_ai_controls'),
    shards: snapshot('meal_ai_shards'),
  }
  const refusedSummary = await maintenance._test.runMaintenance(database, now)
  assert.strictEqual(refusedSummary.scannedTasks, refusedVersions.length)
  assert.strictEqual(refusedSummary.compactedTasks, 0)
  assert.strictEqual(refusedSummary.controlsCleared, 0)
  assert.strictEqual(refusedSummary.pendingShardTasks, refusedVersions.length * 2)
  assert.strictEqual(refusedSummary.shardsDeleted, 0)
  assert.strictEqual(refusedSummary.shardTasksCompleted, 0)
  assert.strictEqual(refusedSummary.skippedTasks, refusedVersions.length * 3)
  assert.deepStrictEqual(snapshot('meal_ai_tasks'), refusedBefore.tasks,
    '未来或非法契约不能改写任务，包含清理时间戳')
  assert.deepStrictEqual(snapshot('meal_ai_controls'), refusedBefore.controls,
    '未来或非法契约不能清除活动任务指针')
  assert.deepStrictEqual(snapshot('meal_ai_shards'), refusedBefore.shards,
    '未来或非法契约不能删除任何活动或终态分片')

  reset()
  const oldNamespace = 'b'.repeat(32)
  const newNamespace = 'c'.repeat(32)
  put('meal_ai_tasks', 'task-old-generation', task(
    'owner-generation', 'queued', now - 1, 7, oldNamespace,
  ))
  put('meal_ai_controls', 'owner-generation', {
    owner: 'owner-generation', cacheNamespace: newNamespace,
    activeTaskId: 'task-old-generation', generationEpoch: 7,
  })
  const oldGenerationCompaction = await maintenance._test.compactCandidate(
    database, 'task-old-generation', now,
  )
  assert.strictEqual(oldGenerationCompaction.state, 'compacted')
  assert.strictEqual(oldGenerationCompaction.controlCleared, false,
    '旧代际任务即使 owner、taskId 和 epoch 相同也不能清除新代际 control')
  assert.strictEqual(get('meal_ai_tasks', 'task-old-generation').cacheNamespace, oldNamespace,
    '过期任务压缩必须保留原代际，供同代客户端读取终态')
  assert.strictEqual(get('meal_ai_controls', 'owner-generation').activeTaskId, 'task-old-generation')

  reset()
  const staleTaskSnapshot = {
    _id: 'task-generation-race', owner: 'owner-generation-race', cacheNamespace: oldNamespace,
    ...CURRENT_AI_VERSIONS,
    status: 'expired', retentionSchemaVersion: 1,
    shardCleanupPending: true, shardCleanupUpdatedAtMs: now - 1,
  }
  put('meal_ai_tasks', staleTaskSnapshot._id, {
    ...staleTaskSnapshot, _id: undefined, cacheNamespace: newNamespace,
  })
  put('meal_ai_shards', 'shard-generation-race', {
    owner: staleTaskSnapshot.owner, taskId: staleTaskSnapshot._id,
    cacheNamespace: newNamespace, body: 'new generation private body',
  })
  const staleShardCleanup = await maintenance._test.cleanShardTask(
    database, staleTaskSnapshot, now, maintenance._test.MAX_SHARDS_PER_TASK,
  )
  assert.strictEqual(staleShardCleanup.deleted, 0,
    '查询后的旧代际任务快照不能删除新代际分片')
  assert.strictEqual(staleShardCleanup.completed, false,
    '旧代际任务快照不能更新新代际任务的清理进度')
  assert.strictEqual(get('meal_ai_shards', 'shard-generation-race').cacheNamespace, newNamespace)
  assert.strictEqual(get('meal_ai_tasks', staleTaskSnapshot._id).shardCleanupPending, true)

  reset()
  const legacy = task('owner-legacy', 'queued', now - 1, 11)
  legacy.contractVersion = AI_CONTRACT_VERSION - 1
  legacy.taskSchemaVersion = 2
  put('meal_ai_tasks', 'task-legacy', legacy)
  put('meal_ai_controls', 'owner-legacy', {
    owner: 'owner-legacy', cacheNamespace: CACHE_NAMESPACE, activeTaskId: 'task-legacy', generationEpoch: 11,
  })
  put('meal_user_states', 'owner-legacy', {
    stateRevision: 7,
    draftPlan: { id: 'draft-must-remain' },
    activePlan: { id: 'active-must-remain' },
    customReminders: [{ id: 'reminder-must-remain' }],
  })
  put('meal_ai_shards', 'legacy-shard', {
    owner: 'owner-legacy', taskId: 'task-legacy', cacheNamespace: CACHE_NAMESPACE, body: 'private legacy shard',
  })
  const legacyStateBefore = get('meal_user_states', 'owner-legacy')
  const legacySummary = await maintenance._test.runMaintenance(database, now)
  const legacyStored = get('meal_ai_tasks', 'task-legacy')
  assert.strictEqual(legacySummary.compactedTasks, 1)
  assert.strictEqual(legacySummary.controlsCleared, 1)
  assert.strictEqual(legacySummary.shardsDeleted, 1)
  assert.strictEqual(legacySummary.shardTasksCompleted, 1)
  assert.strictEqual(legacyStored.status, 'failed')
  assert.strictEqual(legacyStored.errorCode, 'AI_PLANNER_VERSION_UNSUPPORTED')
  assert.strictEqual(legacyStored.contractVersion, AI_CONTRACT_VERSION - 1)
  assert.strictEqual(legacyStored.plannerVersion, AI_PLANNER_VERSION)
  assert.strictEqual(legacyStored.planStateFingerprint, 'a'.repeat(64))
  assert.strictEqual(legacyStored.input, undefined)
  assert.strictEqual(legacyStored.shardCleanupPending, false)
  assert.strictEqual(get('meal_ai_controls', 'owner-legacy').activeTaskId, '')
  assert.strictEqual(get('meal_ai_shards', 'legacy-shard'), undefined)
  assert.deepStrictEqual(get('meal_user_states', 'owner-legacy'), legacyStateBefore)

  reset()
  const stale = task('owner-race', 'failed', now - 1, 1)
  put('meal_ai_tasks', 'task-reread', stale)
  const reread = await maintenance._test.compactCandidate(database, 'task-reread', now)
  assert.strictEqual(reread.state, 'skipped', '事务必须依据重读状态而非查询快照')
  assert.strictEqual(get('meal_ai_tasks', 'task-reread').input.healthNotes, 'private body')

  reset()
  put('meal_ai_tasks', 'task-retry', {
    owner: 'owner-retry', status: 'expired', expiresAt: now - 1,
    cacheNamespace: CACHE_NAMESPACE,
    ...CURRENT_AI_VERSIONS,
    retentionSchemaVersion: 1, shardCleanupPending: true, shardCleanupUpdatedAtMs: now - 1,
  })
  put('meal_ai_shards', 'retry-shard', { owner: 'owner-retry', taskId: 'task-retry', cacheNamespace: CACHE_NAMESPACE, body: 'private body' })
  failRemoveOnce = 'meal_ai_shards/retry-shard'
  const failed = await maintenance._test.runMaintenance(database, now)
  assert.strictEqual(failed.success, false)
  assert.deepStrictEqual(failed.errors, { DATABASE_TIMEOUT: 1 })
  assert.strictEqual(get('meal_ai_tasks', 'task-retry').shardCleanupPending, true)
  assert.strictEqual(get('meal_ai_tasks', 'task-retry').shardCleanupUpdatedAtMs, now)
  const retried = await maintenance._test.runMaintenance(database, now + 1)
  assert.strictEqual(retried.success, true)
  assert.strictEqual(retried.shardsDeleted, 1)
  assert.strictEqual(get('meal_ai_tasks', 'task-retry').shardCleanupPending, false)

  reset()
  ;['succeeded', 'cancelled'].forEach((status) => {
    put('meal_ai_tasks', `task-${status}`, {
      owner: `owner-${status}`, status, expiresAt: now + 60_000,
      cacheNamespace: CACHE_NAMESPACE,
      ...CURRENT_AI_VERSIONS,
      retentionSchemaVersion: 1, shardCleanupPending: true, shardCleanupUpdatedAtMs: now - 1,
    })
    put('meal_ai_shards', `shard-${status}`, {
      owner: `owner-${status}`, taskId: `task-${status}`, cacheNamespace: CACHE_NAMESPACE, body: 'private terminal body',
    })
  })
  put('meal_ai_shards', 'shard-cancelled-foreign-owner', {
    owner: 'owner-foreign', taskId: 'task-cancelled', cacheNamespace: CACHE_NAMESPACE, body: 'other owner private body',
  })
  put('meal_ai_tasks', 'task-active-pending-cleanup', {
    owner: 'owner-active', status: 'running', expiresAt: now + 60_000,
    cacheNamespace: CACHE_NAMESPACE,
    ...CURRENT_AI_VERSIONS,
    retentionSchemaVersion: 1, shardCleanupPending: true, shardCleanupUpdatedAtMs: now - 1,
  })
  put('meal_ai_shards', 'shard-active', {
    owner: 'owner-active', taskId: 'task-active-pending-cleanup', cacheNamespace: CACHE_NAMESPACE, body: 'active private body',
  })
  const terminalCleanup = await maintenance._test.runMaintenance(database, now)
  assert.strictEqual(terminalCleanup.shardsDeleted, 2)
  assert.strictEqual(get('meal_ai_tasks', 'task-succeeded').shardCleanupPending, false)
  assert.strictEqual(get('meal_ai_tasks', 'task-cancelled').shardCleanupPending, false)
  assert.strictEqual(get('meal_ai_shards', 'shard-succeeded'), undefined)
  assert.strictEqual(get('meal_ai_shards', 'shard-cancelled'), undefined)
  assert.strictEqual(get('meal_ai_shards', 'shard-cancelled-foreign-owner').owner, 'owner-foreign')
  assert.strictEqual(get('meal_ai_tasks', 'task-active-pending-cleanup').shardCleanupPending, true)
  assert.strictEqual(get('meal_ai_shards', 'shard-active').owner, 'owner-active')
  const terminalCleanupReplay = await maintenance._test.runMaintenance(database, now + 1)
  assert.strictEqual(terminalCleanupReplay.shardsDeleted, 0, '终态分片清理重复执行必须幂等')
  assert.strictEqual(get('meal_ai_shards', 'shard-cancelled-foreign-owner').owner, 'owner-foreign')
  assert.strictEqual(get('meal_ai_shards', 'shard-active').owner, 'owner-active')

  reset()
  put('meal_ai_tasks', 'task-shard-pages', {
    owner: 'owner-pages', status: 'expired', expiresAt: now - 1,
    cacheNamespace: CACHE_NAMESPACE,
    ...CURRENT_AI_VERSIONS,
    retentionSchemaVersion: 1, shardCleanupPending: true, shardCleanupUpdatedAtMs: now - 1,
  })
  for (let index = 0; index < maintenance._test.MAX_SHARDS_PER_TASK + 2; index += 1) {
    put('meal_ai_shards', `page-shard-${index}`, {
      owner: 'owner-pages', taskId: 'task-shard-pages', cacheNamespace: CACHE_NAMESPACE, body: 'private body',
    })
  }
  const firstShardPage = await maintenance._test.runMaintenance(database, now)
  assert.strictEqual(firstShardPage.shardsDeleted, maintenance._test.MAX_SHARDS_PER_TASK)
  assert.strictEqual(get('meal_ai_tasks', 'task-shard-pages').shardCleanupPending, true)
  const secondShardPage = await maintenance._test.runMaintenance(database, now + 1)
  assert.strictEqual(secondShardPage.shardsDeleted, 2)
  assert.strictEqual(get('meal_ai_tasks', 'task-shard-pages').shardCleanupPending, false)

  reset()
  for (let index = 0; index < maintenance._test.TASKS_PER_STATUS + 2; index += 1) {
    put('meal_ai_tasks', `task-batch-${index}`, task('owner-batch', 'queued', now - 100 + index, index))
  }
  const batchOne = await maintenance._test.runMaintenance(database, now)
  assert.strictEqual(batchOne.compactedTasks, maintenance._test.TASKS_PER_STATUS)
  const batchTwo = await maintenance._test.runMaintenance(database, now + 1)
  assert.strictEqual(batchTwo.compactedTasks, 2)
}

tests().then(() => console.log('mealAiMaintenance index tests passed')).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
