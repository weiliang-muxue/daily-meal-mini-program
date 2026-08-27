'use strict'

const assert = require('assert')
const Module = require('module')

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

const stores = new Map()
const queryLog = []
let source = 'wx_trigger'
let failRemoveOnce = ''

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
function task(owner, status, expiresAt, epoch = 1) {
  return {
    taskSchemaVersion: 2, owner, status, expiresAt, generationEpoch: epoch, taskRevision: 2,
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
  put('meal_ai_controls', 'owner-a', { owner: 'owner-a', activeTaskId: 'task-owner-a', generationEpoch: 4 })
  put('meal_ai_controls', 'owner-b', { owner: 'owner-b', activeTaskId: 'newer-task', generationEpoch: 9 })
  put('meal_user_states', 'owner-a', { draftPlan: { id: 'draft-kept' }, activePlan: { id: 'active-kept' } })
  put('meal_ai_shards', 'shard-a', { owner: 'owner-a', taskId: 'task-owner-a', body: 'private shard' })
  put('meal_ai_shards', 'shard-cross-owner', { owner: 'owner-b', taskId: 'task-owner-a', body: 'other private shard' })

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
  const legacy = task('owner-legacy', 'queued', now - 1, 11)
  delete legacy.planStateFingerprint
  legacy.taskSchemaVersion = 1
  put('meal_ai_tasks', 'task-legacy', legacy)
  put('meal_ai_controls', 'owner-legacy', {
    owner: 'owner-legacy', activeTaskId: 'task-legacy', generationEpoch: 11,
  })
  put('meal_user_states', 'owner-legacy', {
    stateRevision: 7,
    draftPlan: { id: 'draft-must-remain' },
    activePlan: { id: 'active-must-remain' },
    customReminders: [{ id: 'reminder-must-remain' }],
  })
  put('meal_ai_shards', 'legacy-shard', {
    owner: 'owner-legacy', taskId: 'task-legacy', body: 'private legacy shard',
  })
  const legacyStateBefore = get('meal_user_states', 'owner-legacy')
  const legacySummary = await maintenance._test.runMaintenance(database, now)
  const legacyStored = get('meal_ai_tasks', 'task-legacy')
  assert.strictEqual(legacySummary.compactedTasks, 1)
  assert.strictEqual(legacySummary.controlsCleared, 1)
  assert.strictEqual(legacySummary.shardsDeleted, 1)
  assert.strictEqual(legacySummary.shardTasksCompleted, 1)
  assert.strictEqual(legacyStored.status, 'conflict')
  assert.strictEqual(legacyStored.errorCode, 'STATE_REVISION_CONFLICT')
  assert.strictEqual(legacyStored.planStateFingerprint, undefined)
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
    retentionSchemaVersion: 1, shardCleanupPending: true, shardCleanupUpdatedAtMs: now - 1,
  })
  put('meal_ai_shards', 'retry-shard', { owner: 'owner-retry', taskId: 'task-retry', body: 'private body' })
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
  put('meal_ai_tasks', 'task-shard-pages', {
    owner: 'owner-pages', status: 'expired', expiresAt: now - 1,
    retentionSchemaVersion: 1, shardCleanupPending: true, shardCleanupUpdatedAtMs: now - 1,
  })
  for (let index = 0; index < maintenance._test.MAX_SHARDS_PER_TASK + 2; index += 1) {
    put('meal_ai_shards', `page-shard-${index}`, {
      owner: 'owner-pages', taskId: 'task-shard-pages', body: 'private body',
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
