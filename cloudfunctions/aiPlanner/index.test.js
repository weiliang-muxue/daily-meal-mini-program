'use strict'

const assert = require('assert')
const Module = require('module')
const { CONTRACT_VERSION, PLANNER_VERSION, expectedMealKeys, normalizeRequest, normalizePlan } = require('./lib')
const { defaults, sanitizeState, sanitizePlan, confirmDraft, restoreHistory } = require('./user-state')
const {
  createTask, generateTaskId, generateLeaseToken, claimNext, completeClaim, AI_DATA_CONSENT_VERSION,
  RETENTION_SCHEMA_VERSION,
} = require('./task-core')
const {
  PROFILE_FULL, PROFILE_NO_MAX_TOKENS, PROFILE_NO_MAX_TOKENS_OR_REASONING,
} = require('./provider-compat')
const { PROVIDER_CONTRACT_REVISION } = require('./provider-config')
const { configuration } = require('./provider-config')

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

const stores = new Map()
const updateCalls = []
const databaseCalls = []
const readFailures = new Map()
const setFailures = new Map()
let transactionFailure = null
let transactionCommitFailure = null

function atomicSet(value) { return { $testAtomicSet: true, value: clone(value) } }
function isAtomicSet(value) { return value && value.$testAtomicSet === true }

function collectionStore(name) {
  if (!stores.has(name)) stores.set(name, new Map())
  return stores.get(name)
}

function reference(name, id) {
  return {
    async get() {
      databaseCalls.push({ operation: 'get', name, id })
      if (readFailures.has(name)) {
        const configuredFailure = readFailures.get(name)
        const failure = typeof configuredFailure === 'function' ? configuredFailure() : configuredFailure
        if (failure) throw failure
      }
      const value = collectionStore(name).get(id)
      return { data: value === undefined ? null : clone(value) }
    },
    async set({ data }) {
      databaseCalls.push({ operation: 'set', name, id })
      if (setFailures.has(name)) throw setFailures.get(name)
      collectionStore(name).set(id, clone(data))
      return { stats: { updated: 1 } }
    },
    async update({ data }) {
      databaseCalls.push({ operation: 'update', name, id })
      const current = collectionStore(name).get(id) || {}
      updateCalls.push({ name, id, data: clone(data) })
      const next = { ...clone(current) }
      Object.entries(data).forEach(([key, value]) => {
        next[key] = isAtomicSet(value) ? clone(value.value) : clone(value)
      })
      collectionStore(name).set(id, next)
      return { stats: { updated: 1 } }
    },
  }
}

function collection(name) {
  return { doc(id) { return reference(name, id) } }
}

const database = {
  collection,
  command: { set: atomicSet },
  serverDate() { return { $serverDate: true } },
  async runTransaction(callback) {
    if (transactionFailure) throw transactionFailure
    const result = await callback({ collection })
    if (transactionCommitFailure) throw transactionCommitFailure
    return result
  },
}

let wxContext = {}
const cloudStub = {
  DYNAMIC_CURRENT_ENV: 'dynamic-current-env',
  init() {},
  database() { return database },
  getWXContext() { return wxContext },
}

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloudStub
  return originalLoad.call(this, request, parent, isMain)
}
let planner
try { planner = require('./index') } finally { Module._load = originalLoad }

const owner = 'openid-owner'
const otherOwner = 'openid-other'
const cacheNamespace = 'a'.repeat(32)
const otherCacheNamespace = 'b'.repeat(32)
// Tests use a synthetic runtime identity. Production endpoint, display name,
// revision and key are supplied only by the cloud-function environment.
const providerConfig = configuration({
  AI_API_KEY: 'TEST_PLACEHOLDER_ONLY',
  AI_API_BASE_URL: 'https://example.invalid',
  AI_PROVIDER_DISPLAY_NAME: 'Synthetic AI',
  AI_PROVIDER_REVISION: '1',
})
const input = {
  contractVersion: CONTRACT_VERSION,
  durationDays: 7,
  startDate: '2026-08-31',
  mealTypes: ['breakfast'],
  doubleDinner: false,
  goals: ['均衡饮食'],
  styles: ['清淡'],
  customGoal: '',
  restrictions: '',
  healthNotes: '',
  exerciseIntent: 'none',
  exerciseNotes: '',
  exerciseByDay: [],
}

function namespaceFor(id) { return id === otherOwner ? otherCacheNamespace : cacheNamespace }
function put(name, id, value) {
  const stored = clone(value)
  if (name === 'meal_ai_controls' && stored && !stored.cacheNamespace) {
    stored.cacheNamespace = namespaceFor(id)
  }
  collectionStore(name).set(id, stored)
}
function get(name, id) { return clone(collectionStore(name).get(id)) }
function storesSnapshot() {
  return clone([...stores.entries()].map(([name, values]) => [name, [...values.entries()]]))
}
function assertZeroBusinessWrites(before, message) {
  assert.deepStrictEqual(storesSnapshot(), before, `${message}：数据库内容必须逐字节保持不变`)
  assert.strictEqual(databaseCalls.some((call) => call.operation !== 'get'), false, `${message}：不得发出写操作`)
}
function idempotencyEntry(task) {
  return {
    idempotencyHash: task.idempotencyHash,
    requestFingerprint: task.requestFingerprint,
    taskId: task._id,
    createdAt: task.createdAt,
  }
}
function taskWithStatus(rawTask, status, errorCode = '') {
  const task = clone(rawTask)
  task.status = status
  task.phase = ['queued', 'running', 'finalizing'].includes(status) ? task.phase : 'terminal'
  task.errorCode = errorCode
  task.failureCode = errorCode
  if (!['queued', 'running', 'finalizing'].includes(status)) task.terminalAtMs = task.updatedAtMs
  return task
}
function assertNoForbiddenKeys(value, forbidden, path = 'response') {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, forbidden, `${path}[${index}]`))
    return
  }
  Object.entries(value).forEach(([key, child]) => {
    assert.strictEqual(forbidden.has(key), false, `${path}.${key} 不得出现在公开响应中`)
    assertNoForbiddenKeys(child, forbidden, `${path}.${key}`)
  })
}
function validTaskId(seed) { return generateTaskId(Buffer.alloc(32, seed)) }
function assertShardCleanupPending(taskId, status) {
  const task = get('meal_ai_tasks', taskId)
  assert.strictEqual(task.status, status)
  assert.strictEqual(task.retentionSchemaVersion, RETENTION_SCHEMA_VERSION)
  assert.strictEqual(task.shardCleanupPending, true)
  assert.strictEqual(Number.isSafeInteger(task.shardCleanupUpdatedAtMs), true)
}

function storedTask(taskOwner = owner, epoch = 1, seed = 1, taskInput = input, planState = {}) {
  const task = createTask({
    taskId: validTaskId(seed),
    owner: taskOwner,
    input: taskInput,
    baseStateRevision: 0,
    stateRevision: 0,
    planId: `plan-${seed}`,
    generatedAt: '2026-08-26T00:00:00.000Z',
    clientRequestId: String(seed).padStart(32, '0'),
    contractVersion: CONTRACT_VERSION,
    plannerVersion: PLANNER_VERSION,
    aiDataConsentVersion: AI_DATA_CONSENT_VERSION,
    providerRevision: providerConfig.providerRevision,
    providerConfigVersion: providerConfig.providerConfigVersion,
    activePlan: planState.activePlan ? sanitizePlan(planState.activePlan, 'activePlan') : null,
    draftPlan: planState.draftPlan ? sanitizePlan(planState.draftPlan, 'draftPlan') : null,
    now: Date.now() - 1000,
  })
  task.generationEpoch = epoch
  task.cacheNamespace = namespaceFor(taskOwner)
  return task
}

function legacyActiveTask(seed, epoch, status = 'queued') {
  const task = storedTask(owner, epoch, seed)
  delete task.planStateFingerprint
  task.taskSchemaVersion = 1
  task.status = status
  return task
}

function noConsentActiveTask(seed, epoch, status = 'queued') {
  const task = storedTask(owner, epoch, seed)
  delete task.aiDataConsentVersion
  task.taskSchemaVersion = 2
  task.status = status
  return task
}

const consent = Object.freeze({
  accepted: true,
  version: AI_DATA_CONSENT_VERSION,
  providerRevision: providerConfig.providerRevision,
})

function validPlan(task) {
  const normalized = normalizeRequest(task.input)
  const keys = expectedMealKeys(normalized)
  const raw = {
    title: '事务测试计划',
    rationale: ['依据保存的生成偏好生成'],
    days: Array.from({ length: normalized.durationDays }, (_, dayIndex) => ({
      theme: `主题 ${dayIndex + 1}`,
      meals: keys.map((key, mealIndex) => {
        const [type, scenario] = key.split(':')
        return {
          type, scenario, title: `${type}-${scenario}-${String.fromCharCode(0x3400 + dayIndex * 8 + mealIndex)}`,
          ingredients: [{ name: `食材-${dayIndex}-${mealIndex}`, quantity: 100, unit: 'g', category: '蔬菜' }],
          method: '洗净后煮熟', tag: '清淡调味',
        }
      }),
    })),
  }
  return normalizePlan(raw, normalized, { planId: task.planId, generatedAt: task.generatedAt })
}

function referencePlan(seed) {
  return validPlan(storedTask(owner, 1, seed))
}

function stateWithPlans(overrides = {}) {
  return sanitizeState({
    ...defaults(),
    generationPreferences: input,
    ...overrides,
  }, { preserveUnknownFrom: overrides })
}

async function assertFinalizeConflict(seed, epoch, baselineState, latestState) {
  const { task, claim, leaseToken } = finalClaimTask(seed, epoch, input, {
    activePlan: baselineState.activePlan,
    draftPlan: baselineState.draftPlan,
  })
  put('meal_user_states', owner, latestState)
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, { owner, activeTaskId: task._id, generationEpoch: epoch })
  const before = get('meal_user_states', owner)
  const revision = before.stateRevision

  const outcome = await planner._test.settleSuccess(owner, task._id, claim, leaseToken, validPlan(task))
  assert.strictEqual(outcome.task.status, 'conflict')
  assert.strictEqual(outcome.task.errorCode, 'STATE_REVISION_CONFLICT')
  assert.strictEqual(outcome.result, null)
  assert.deepStrictEqual(get('meal_user_states', owner), before, '冲突 finalize 不能修改任何用户状态字段')
  assert.strictEqual(get('meal_user_states', owner).stateRevision, revision)
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, '')
  return outcome
}

function finalClaimTask(seed, epoch, taskInput = input, planState = {}) {
  let task = storedTask(owner, epoch, seed, taskInput, planState)
  let leaseSeed = seed + 20
  let token = generateLeaseToken(Buffer.alloc(32, leaseSeed))
  let work = claimNext(task, token, Date.now() - 900)
  task = completeClaim(work.task, work.claim, token, { title: '紧凑提纲', rationale: ['测试依据'] }, Date.now() - 800).task
  while (task.chunks.some((chunk) => chunk.status !== 'completed')) {
    leaseSeed += 1
    token = generateLeaseToken(Buffer.alloc(32, leaseSeed))
    work = claimNext(task, token, Date.now() - 700 + leaseSeed)
    assert.strictEqual(work.claim.kind, 'detail')
    task = completeClaim(work.task, work.claim, token, { days: [] }, Date.now() - 600 + leaseSeed).task
  }
  leaseSeed += 1
  token = generateLeaseToken(Buffer.alloc(32, leaseSeed))
  work = claimNext(task, token, Date.now() - 100)
  assert.strictEqual(work.claim.kind, 'finalize')
  return { task: work.task, claim: work.claim, leaseToken: token }
}

function reset() {
  stores.clear()
  updateCalls.length = 0
  databaseCalls.length = 0
  readFailures.clear()
  setFailures.clear()
  transactionFailure = null
  transactionCommitFailure = null
  put('meal_members', owner, { status: 'active', role: 'owner', cacheNamespace })
  put('meal_members', otherOwner, { status: 'active', role: 'member', cacheNamespace: otherCacheNamespace })
  put('meal_user_states', owner, defaults())
  put('meal_user_states', otherOwner, defaults())
  databaseCalls.length = 0
}

const rawPlannerTest = { ...planner._test }
planner._test.startTask = (openid, preferences, revision, requestId, aiConsent) => (
  rawPlannerTest.startTask(openid, preferences, revision, requestId, aiConsent, namespaceFor(openid), providerConfig)
)
planner._test.readTaskStatus = (openid, taskId) => (
  rawPlannerTest.readTaskStatus(openid, taskId, namespaceFor(openid), providerConfig)
)
planner._test.readCurrentTask = (openid) => rawPlannerTest.readCurrentTask(openid, namespaceFor(openid), providerConfig)
planner._test.readRecentFailure = (openid) => rawPlannerTest.readRecentFailure(openid, namespaceFor(openid))
planner._test.claimWork = (openid, taskId) => rawPlannerTest.claimWork(openid, taskId, namespaceFor(openid), providerConfig)
planner._test.settleSuccess = (openid, taskId, claim, token, result) => (
  rawPlannerTest.settleSuccess(openid, taskId, claim, token, result, namespaceFor(openid), undefined, providerConfig)
)
planner._test.settleFailure = (openid, taskId, claim, token, failure) => (
  rawPlannerTest.settleFailure(openid, taskId, claim, token, failure, namespaceFor(openid), providerConfig)
)
planner._test.advanceTask = (openid, taskId, config, operations) => (
  rawPlannerTest.advanceTask(openid, taskId, config, namespaceFor(openid), operations)
)
planner._test.cancelGeneration = (openid, taskId, revision) => (
  rawPlannerTest.cancelGeneration(openid, taskId, revision, namespaceFor(openid))
)

const tests = []
function test(name, run) { tests.push({ name, run }) }

test('aiPlanner transactions do not issue parallel database reads', () => {
  const source = require('fs').readFileSync(require.resolve('./index'), 'utf8')
  assert.strictEqual(/Promise\.all\s*\(/.test(source), false)
})

test('planner reads schema v7 in memory while older and future schemas fail closed', () => {
  const legacy = {
    ...defaults(),
    schemaVersion: 7,
    customReminders: [{ id: 'schema-7-reminder', text: '保留旧提醒', done: false }],
  }
  delete legacy.waterReminder
  const before = clone(legacy)
  const migrated = planner._test.currentStateForPlanning(legacy, { preserveUnknownFrom: legacy })
  assert.strictEqual(migrated.schemaVersion, 8)
  assert.strictEqual(migrated.waterReminder.enabled, false)
  assert.deepStrictEqual(migrated.customReminders, legacy.customReminders)
  assert.deepStrictEqual(legacy, before, '兼容读取只能在内存迁移，不能改写原始 v7 对象')
  assert.throws(
    () => planner._test.currentStateForPlanning({ ...legacy, schemaVersion: 6 }),
    (error) => error.code === 'STATE_SCHEMA_UPGRADE_REQUIRED',
  )
  assert.throws(
    () => planner._test.currentStateForPlanning({ ...legacy, schemaVersion: 9 }),
    (error) => error.code === 'STATE_SCHEMA_UNSUPPORTED',
  )
})

test('readiness status probes only reserved documents and performs no business writes', async () => {
  reset()
  wxContext = { OPENID: owner }
  try {
    const response = await planner.main({ action: 'status', expectedCacheNamespace: cacheNamespace })
    assert.strictEqual(response.success, true)
    assert.strictEqual(typeof response.data.configured, 'boolean')
    assert.strictEqual(response.data.storageReady, true)
    assert.strictEqual(response.data.plannerVersion, PLANNER_VERSION)
    assert.strictEqual(response.data.providerContractRevision, PROVIDER_CONTRACT_REVISION)
    assert(Number.isSafeInteger(response.data.providerContractRevision))
    // A test process without cloud runtime identity must remain explicitly
    // unconfigured. Production values are supplied only by cloud env vars.
    assert.strictEqual(response.data.configured, false)
    assert.strictEqual(response.data.providerRevision, 0)
    assert.strictEqual(response.data.providerConfigVersion, '')
    assert.deepStrictEqual(databaseCalls, [
      { operation: 'get', name: 'meal_members', id: owner },
      { operation: 'get', name: 'meal_ai_tasks', id: planner._test.STORAGE_PROBE_DOCUMENT_ID },
      { operation: 'get', name: 'meal_ai_controls', id: planner._test.STORAGE_PROBE_DOCUMENT_ID },
    ])
    assert.strictEqual(databaseCalls.some((call) => call.name === 'meal_user_states'), false)
    assert.strictEqual(databaseCalls.some((call) => call.operation !== 'get'), false)
  } finally {
    wxContext = {}
  }
})

test('retired provider diagnostic actions remain unsupported and cannot write business data', async () => {
  const apiKeyName = ['AI', 'API', 'KEY'].join('_')
  const previousKey = process.env[apiKeyName]
  process.env[apiKeyName] = 'TEST_PLACEHOLDER_ONLY'
  try {
    for (const retiredAction of [
      ['provider', 'Diagnostic'].join(''),
      ['provider', 'CapabilityV1'].join(''),
      ['provider', 'StreamCapabilityV1'].join(''),
    ]) {
      reset()
      wxContext = { OPENID: owner }
      const before = storesSnapshot()
      const response = await planner.main({ action: retiredAction, expectedCacheNamespace: cacheNamespace })
      assert.deepStrictEqual(response, {
        success: false,
        code: 'UNSUPPORTED_ACTION',
        message: '不支持的计划操作',
      })
      assertZeroBusinessWrites(before, `已退役 provider 探针 action ${retiredAction}`)
    }
  } finally {
    if (previousKey === undefined) delete process.env[apiKeyName]
    else process.env[apiKeyName] = previousKey
    wxContext = {}
  }
})

test('readiness status maps missing AI collections to a sanitized storage error without writes', async () => {
  const failures = [
    ['meal_ai_tasks', { code: -502005, message: 'PRIVATE_TASK_COLLECTION_DETAIL' }],
    ['meal_ai_controls', { errCode: 'DATABASE_COLLECTION_NOT_FOUND', message: 'PRIVATE_CONTROL_COLLECTION_DETAIL' }],
  ]
  for (const [collectionName, failure] of failures) {
    reset()
    wxContext = { OPENID: owner }
    readFailures.set(collectionName, failure)
    const logs = []
    const originalError = console.error
    console.error = (...values) => logs.push(values)
    try {
      const response = await planner.main({ action: 'status', expectedCacheNamespace: cacheNamespace })
      assert.deepStrictEqual(response, {
        success: false,
        code: 'AI_STORAGE_NOT_READY',
        message: 'AI 存储服务尚未准备好，请稍后再试',
        stage: 'STORAGE_PROBE',
      })
      assert.strictEqual(databaseCalls.some((call) => call.operation !== 'get'), false)
      assert.deepStrictEqual(logs, [[{ code: 'AI_STORAGE_NOT_READY', stage: 'STORAGE_PROBE' }]])
      const publicSurface = JSON.stringify({ response, logs })
      assert.strictEqual(publicSurface.includes(failure.message), false)
      assert.strictEqual(publicSurface.includes(collectionName), false)
    } finally {
      console.error = originalError
      wxContext = {}
    }
  }
})

test('readiness status maps transaction infrastructure failure without exposing metadata', async () => {
  reset()
  wxContext = { OPENID: owner }
  transactionFailure = Object.assign(new Error('PRIVATE_TRANSACTION_METADATA'), {
    code: 'DATABASE_TRANSACTION_ERROR',
  })
  const logs = []
  const originalError = console.error
  console.error = (...values) => logs.push(values)
  try {
    const response = await planner.main({ action: 'status', expectedCacheNamespace: cacheNamespace })
    assert.strictEqual(response.success, false)
    assert.strictEqual(response.code, 'AI_STORAGE_NOT_READY')
    assert.strictEqual(JSON.stringify({ response, logs }).includes('PRIVATE_TRANSACTION_METADATA'), false)
    assert.strictEqual(databaseCalls.some((call) => call.operation !== 'get'), false)
    assert.deepStrictEqual(logs, [[{ code: 'AI_STORAGE_NOT_READY', stage: 'STORAGE_PROBE' }]])
  } finally {
    console.error = originalError
    wxContext = {}
  }
})

test('public error mapping recognizes storage infrastructure codes and keeps unknown failures generic', () => {
  const storageFailures = [
    { code: -502005, message: 'PRIVATE_COLLECTION_DETAIL' },
    { code: -1, errCode: '-502005', errMsg: 'PRIVATE_COLLECTION_DETAIL' },
    { code: 'DATABASE_COLLECTION_NOT_EXIST', message: 'PRIVATE_METADATA_DETAIL' },
    { code: 'DATABASE_TIMEOUT', message: 'PRIVATE_DATABASE_DETAIL' },
    { errCode: 'DATABASE_SERVICE_UNAVAILABLE', message: 'PRIVATE_DATABASE_DETAIL' },
    { errCode: 'DATABASE_TRANSACTION_FAILED', message: 'PRIVATE_TRANSACTION_DETAIL' },
    { code: 'TRANSACTION_CONFLICT', message: 'PRIVATE_TRANSACTION_DETAIL' },
  ]
  storageFailures.forEach((failure) => {
    assert.deepStrictEqual(planner._test.publicError(failure), {
      code: 'AI_STORAGE_NOT_READY',
      message: 'AI 存储服务尚未准备好，请稍后再试',
    })
  })
  assert.deepStrictEqual(
    planner._test.publicError({ code: 'PRIVATE_DATABASE_FAILURE', message: 'PRIVATE_DATABASE_DETAIL' }),
    { code: 'AI_GENERATION_FAILED', message: 'AI 没能生成合格计划，请重试；当前计划未改变' },
  )
})

test('unknown public failures log only the generic public code', async () => {
  reset()
  wxContext = { OPENID: owner }
  readFailures.set('meal_members', Object.assign(new Error('PRIVATE_USER_DATABASE_DETAIL'), {
    code: 'PRIVATE_DATABASE_FAILURE',
  }))
  const logs = []
  const originalError = console.error
  console.error = (...values) => logs.push(values)
  try {
    const response = await planner.main({ action: 'status', expectedCacheNamespace: cacheNamespace })
    assert.strictEqual(response.code, 'AI_GENERATION_FAILED')
    assert.deepStrictEqual(logs, [[{ code: 'AI_GENERATION_FAILED', stage: 'STORAGE_PROBE' }]])
    assert.strictEqual(JSON.stringify({ response, logs }).includes('PRIVATE_USER_DATABASE_DETAIL'), false)
  } finally {
    console.error = originalError
    wxContext = {}
  }
})

test('current returns null when there is no active task', async () => {
  reset()
  assert.strictEqual(await planner._test.readCurrentTask(owner), null)
})

test('recent failure returns only the uniquely bound latest generation and performs no writes', async () => {
  reset()
  const older = taskWithStatus(storedTask(owner, 2, 72), 'failed', 'AI_NETWORK_ERROR')
  const latest = taskWithStatus(storedTask(owner, 3, 73), 'failed', 'AI_TIMEOUT')
  latest.createdAt = older.createdAt - 5000
  latest.createdAtMs = older.createdAtMs - 5000
  put('meal_ai_tasks', older._id, planner._test.taskData(older))
  put('meal_ai_tasks', latest._id, planner._test.taskData(latest))
  put('meal_ai_controls', owner, {
    owner, activeTaskId: '', generationEpoch: 3,
    idempotencyEntries: [idempotencyEntry(older), idempotencyEntry(latest)],
  })
  databaseCalls.length = 0
  const before = storesSnapshot()

  const outcome = await planner._test.readRecentFailure(owner)

  assert.deepStrictEqual(outcome, {
    failure: {
      status: 'failed', phase: 'terminal', errorCode: 'AI_TIMEOUT', progressPercent: 0,
      retryable: true, category: 'transient',
    },
  })
  assert.deepStrictEqual(Object.keys(outcome.failure).sort(), [
    'category', 'errorCode', 'phase', 'progressPercent', 'retryable', 'status',
  ])
  assertZeroBusinessWrites(before, 'recentFailure 只读诊断')
})

test('oversized request failure requires condition adjustment instead of blind retry', () => {
  assert.deepStrictEqual(planner._test.failurePolicy('AI_REQUEST_TOO_LARGE', 'failed'), {
    errorCode: 'AI_REQUEST_TOO_LARGE', retryable: false, category: 'response_review',
  })
  assert.deepStrictEqual(planner._test.failurePolicy('AI_UPSTREAM_FORBIDDEN', 'failed'), {
    errorCode: 'AI_UPSTREAM_FORBIDDEN', retryable: false, category: 'provider_configuration',
  })
})

test('new active, succeeded, or cancelled generations suppress every older failure', async () => {
  for (const status of ['queued', 'succeeded', 'cancelled']) {
    reset()
    const older = taskWithStatus(storedTask(owner, 2, 74), 'failed', 'AI_TIMEOUT')
    const latest = taskWithStatus(
      storedTask(owner, 3, status === 'queued' ? 75 : status === 'succeeded' ? 76 : 77),
      status,
      status === 'cancelled' ? 'AI_TASK_CANCELLED' : '',
    )
    put('meal_ai_tasks', older._id, planner._test.taskData(older))
    put('meal_ai_tasks', latest._id, planner._test.taskData(latest))
    put('meal_ai_controls', owner, {
      owner, activeTaskId: '', generationEpoch: 3,
      idempotencyEntries: [idempotencyEntry(older), idempotencyEntry(latest)],
    })
    databaseCalls.length = 0
    const before = storesSnapshot()

    assert.deepStrictEqual(await planner._test.readRecentFailure(owner), { failure: null }, status)
    assertZeroBusinessWrites(before, `较新的 ${status} 任务压住旧失败`)
  }

  reset()
  const oldFailure = taskWithStatus(storedTask(owner, 2, 78), 'failed', 'AI_TIMEOUT')
  put('meal_ai_tasks', oldFailure._id, planner._test.taskData(oldFailure))
  put('meal_ai_controls', owner, {
    owner, activeTaskId: validTaskId(79), generationEpoch: 3,
    idempotencyEntries: [idempotencyEntry(oldFailure)],
  })
  databaseCalls.length = 0
  assert.deepStrictEqual(await planner._test.readRecentFailure(owner), { failure: null })
  assert.strictEqual(databaseCalls.some((call) => call.name === 'meal_ai_tasks'), false,
    '活动任务指针存在时不得扫描旧任务')
})

test('recent failure fails closed for an untrusted control owner without reading tasks', async () => {
  reset()
  const failure = taskWithStatus(storedTask(owner, 3, 80), 'failed', 'AI_TIMEOUT')
  put('meal_ai_tasks', failure._id, planner._test.taskData(failure))
  put('meal_ai_controls', owner, {
    owner: otherOwner, activeTaskId: '', generationEpoch: 3,
    idempotencyEntries: [idempotencyEntry(failure)],
  })
  databaseCalls.length = 0
  const before = storesSnapshot()

  assert.deepStrictEqual(await planner._test.readRecentFailure(owner), { failure: null })
  assert.strictEqual(databaseCalls.some((call) => call.name === 'meal_ai_tasks'), false)
  assertZeroBusinessWrites(before, '跨用户控制记录')
})

test('recent failure isolates callers and expected cache namespaces', async () => {
  reset()
  const failure = taskWithStatus(storedTask(owner, 3, 102), 'failed', 'AI_TIMEOUT')
  put('meal_ai_tasks', failure._id, planner._test.taskData(failure))
  put('meal_ai_controls', otherOwner, {
    owner: otherOwner, cacheNamespace: otherCacheNamespace, activeTaskId: '', generationEpoch: 3,
    idempotencyEntries: [idempotencyEntry(failure)],
  })
  databaseCalls.length = 0
  const before = storesSnapshot()

  assert.deepStrictEqual(await planner._test.readRecentFailure(otherOwner), { failure: null },
    '另一用户不能读取任务所有者的失败摘要')
  assertZeroBusinessWrites(before, '跨用户 recentFailure 查询')

  reset()
  await assert.rejects(
    rawPlannerTest.readRecentFailure(owner, otherCacheNamespace),
    (error) => error && error.code === 'STALE_DATA_GENERATION',
  )
  assert.strictEqual(databaseCalls.some((call) => call.name === 'meal_ai_tasks'), false,
    '期望 namespace 不匹配时不得读取任务')
})

test('recent failure never falls back when the latest generation is missing or untrusted', async () => {
  const cases = [
    ['missing', (task) => ({ entry: idempotencyEntry(task), store: false })],
    ['foreign owner', (task) => ({ task: { ...task, owner: otherOwner } })],
    ['wrong namespace', (task) => ({ task: { ...task, cacheNamespace: otherCacheNamespace } })],
    ['future task version', (task) => ({ task: { ...task, taskSchemaVersion: 999 } })],
    ['idempotency binding mismatch', (task) => ({ entry: { ...idempotencyEntry(task), idempotencyHash: 'mismatch' } })],
    ['request binding mismatch', (task) => ({ entry: { ...idempotencyEntry(task), requestFingerprint: 'mismatch' } })],
  ]
  for (let index = 0; index < cases.length; index += 1) {
    const [label, mutate] = cases[index]
    reset()
    const older = taskWithStatus(storedTask(owner, 2, 81), 'failed', 'AI_NETWORK_ERROR')
    const originalLatest = taskWithStatus(storedTask(owner, 3, 82 + index), 'failed', 'AI_TIMEOUT')
    const changed = mutate(originalLatest)
    const latest = changed.task || originalLatest
    const latestEntry = changed.entry || idempotencyEntry(originalLatest)
    put('meal_ai_tasks', older._id, planner._test.taskData(older))
    if (changed.store !== false) put('meal_ai_tasks', originalLatest._id, planner._test.taskData(latest))
    put('meal_ai_controls', owner, {
      owner, activeTaskId: '', generationEpoch: 3,
      idempotencyEntries: [idempotencyEntry(older), latestEntry],
    })
    databaseCalls.length = 0
    const before = storesSnapshot()

    assert.deepStrictEqual(await planner._test.readRecentFailure(owner), { failure: null }, label)
    assertZeroBusinessWrites(before, label)
  }

  reset()
  const onlyOld = taskWithStatus(storedTask(owner, 2, 89), 'failed', 'AI_TIMEOUT')
  put('meal_ai_tasks', onlyOld._id, planner._test.taskData(onlyOld))
  put('meal_ai_controls', owner, {
    owner, activeTaskId: '', generationEpoch: 3, idempotencyEntries: [idempotencyEntry(onlyOld)],
  })
  databaseCalls.length = 0
  assert.deepStrictEqual(await planner._test.readRecentFailure(owner), { failure: null })
})

test('recent failure rejects duplicate current-generation candidates and reads at most five entries', async () => {
  reset()
  const currentA = taskWithStatus(storedTask(owner, 3, 90), 'failed', 'AI_TIMEOUT')
  const currentB = taskWithStatus(storedTask(owner, 3, 91), 'failed', 'AI_NETWORK_ERROR')
  put('meal_ai_tasks', currentA._id, planner._test.taskData(currentA))
  put('meal_ai_tasks', currentB._id, planner._test.taskData(currentB))
  put('meal_ai_controls', owner, {
    owner, activeTaskId: '', generationEpoch: 3,
    idempotencyEntries: [idempotencyEntry(currentA), idempotencyEntry(currentB)],
  })
  databaseCalls.length = 0
  assert.deepStrictEqual(await planner._test.readRecentFailure(owner), { failure: null })

  reset()
  const candidates = Array.from({ length: 6 }, (_, index) => (
    taskWithStatus(storedTask(owner, index + 1, 92 + index), 'failed', 'AI_TIMEOUT')
  ))
  candidates.forEach((task) => put('meal_ai_tasks', task._id, planner._test.taskData(task)))
  put('meal_ai_controls', owner, {
    owner, activeTaskId: '', generationEpoch: 6,
    idempotencyEntries: candidates.map(idempotencyEntry),
  })
  databaseCalls.length = 0
  assert.deepStrictEqual(await planner._test.readRecentFailure(owner), { failure: null })
  assert.strictEqual(databaseCalls.filter((call) => call.name === 'meal_ai_tasks').length, 5)
})

test('public recent failure response recursively excludes identifiers and private source values', async () => {
  reset()
  const failure = taskWithStatus(storedTask(owner, 4, 101), 'failed', 'AI_RESPONSE_INVALID')
  failure.idempotencyHash = 'PRIVATE_IDEMPOTENCY_SENTINEL'
  failure.requestFingerprint = 'PRIVATE_REQUEST_SENTINEL'
  failure.preferencesHash = 'PRIVATE_PREFERENCES_SENTINEL'
  failure.planId = 'PRIVATE_PLAN_SENTINEL'
  failure.planStateFingerprint = 'PRIVATE_PLAN_STATE_SENTINEL'
  failure.input.healthNotes = 'PRIVATE_HEALTH_SENTINEL'
  const entry = idempotencyEntry(failure)
  put('meal_ai_tasks', failure._id, planner._test.taskData(failure))
  put('meal_ai_controls', owner, {
    owner, activeTaskId: '', generationEpoch: 4, idempotencyEntries: [entry],
  })
  databaseCalls.length = 0
  wxContext = { OPENID: owner }
  try {
    const before = storesSnapshot()
    const response = await planner.main({ action: 'recentFailure', expectedCacheNamespace: cacheNamespace })
    assert.strictEqual(response.success, true)
    assert.deepStrictEqual(Object.keys(response).sort(), ['data', 'success'])
    assertNoForbiddenKeys(response, new Set([
      '_id', 'taskId', 'owner', 'cacheNamespace', 'generationEpoch', 'idempotencyHash',
      'requestFingerprint', 'preferencesHash', 'planId', 'planStateFingerprint',
      'createdAt', 'updatedAt', 'terminalAtMs',
    ]))
    const serialized = JSON.stringify(response)
    ;[
      failure._id, owner, cacheNamespace, failure.idempotencyHash, failure.requestFingerprint,
      failure.preferencesHash, failure.planId, failure.planStateFingerprint, failure.input.healthNotes,
    ].forEach((privateValue) => assert.strictEqual(serialized.includes(privateValue), false, privateValue))
    assertZeroBusinessWrites(before, '公开 recentFailure 响应')
  } finally {
    wxContext = {}
  }
})

test('missing or stale cache namespace cannot create an AI task', async () => {
  for (const expectedCacheNamespace of [undefined, 'c'.repeat(32)]) {
    reset()
    const beforeState = get('meal_user_states', owner)
    await assert.rejects(
      rawPlannerTest.startTask(
        owner, input, 0, '10101010101010101010101010101010', consent, expectedCacheNamespace,
        providerConfig,
      ),
      (error) => error && error.code === 'STALE_DATA_GENERATION',
    )
    assert.strictEqual(collectionStore('meal_ai_tasks').size, 0)
    assert.strictEqual(get('meal_ai_controls', owner), undefined)
    assert.deepStrictEqual(get('meal_user_states', owner), beforeState)
  }
})

test('late AI settlement from a cleared identity cannot write into the new generation', async () => {
  reset()
  const { task, claim, leaseToken } = finalClaimTask(91, 31)
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, { owner, activeTaskId: task._id, generationEpoch: 31 })

  const newNamespace = 'd'.repeat(32)
  const newState = stateWithPlans({
    stateRevision: 7,
    customReminders: [{ id: 'new-generation', text: 'new identity state', done: false }],
  })
  put('meal_members', owner, { status: 'active', cacheNamespace: newNamespace })
  put('meal_user_states', owner, newState)
  const beforeTask = get('meal_ai_tasks', task._id)
  const beforeControl = get('meal_ai_controls', owner)

  await assert.rejects(
    rawPlannerTest.settleSuccess(owner, task._id, claim, leaseToken, validPlan(task), cacheNamespace),
    (error) => error && error.code === 'STALE_DATA_GENERATION',
  )
  assert.deepStrictEqual(get('meal_user_states', owner), newState)
  assert.deepStrictEqual(get('meal_ai_tasks', task._id), beforeTask)
  assert.deepStrictEqual(get('meal_ai_controls', owner), beforeControl)
})

test('current restores an active task on another device', async () => {
  reset()
  const task = storedTask(owner, 3, 2)
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, { owner, activeTaskId: task._id, generationEpoch: 3 })

  const current = await planner._test.readCurrentTask(owner)
  assert.strictEqual(current.task.taskId, task._id)
  assert.strictEqual(current.task.status, 'queued')
  assert.strictEqual(current.result, null)
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, task._id)
})

test('legacy active tasks without a plan baseline fail closed on status, current, and claim', async () => {
  reset()
  let task = legacyActiveTask(64, 15, 'pending')
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, { owner, activeTaskId: task._id, generationEpoch: 15 })
  const beforeStatus = get('meal_user_states', owner)
  const status = await planner._test.readTaskStatus(owner, task._id)
  assert.strictEqual(status.task.status, 'conflict')
  assert.strictEqual(status.task.errorCode, 'STATE_REVISION_CONFLICT')
  assert.strictEqual(get('meal_ai_tasks', task._id).input, undefined)
  assertShardCleanupPending(task._id, 'conflict')
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, '')
  assert.deepStrictEqual(get('meal_user_states', owner), beforeStatus)

  reset()
  task = legacyActiveTask(65, 16, 'processing')
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, { owner, activeTaskId: task._id, generationEpoch: 16 })
  const beforeCurrent = get('meal_user_states', owner)
  const current = await planner._test.readCurrentTask(owner)
  assert.strictEqual(current.task.status, 'conflict')
  assert.strictEqual(current.task.errorCode, 'STATE_REVISION_CONFLICT')
  assertShardCleanupPending(task._id, 'conflict')
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, '')
  assert.deepStrictEqual(get('meal_user_states', owner), beforeCurrent)

  reset()
  task = legacyActiveTask(66, 17, 'validating')
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, { owner, activeTaskId: task._id, generationEpoch: 17 })
  const beforeClaim = get('meal_user_states', owner)
  const claimed = await planner._test.claimWork(owner, task._id)
  assert.strictEqual(claimed.task.status, 'conflict')
  assert.strictEqual(claimed.claim, null)
  assertShardCleanupPending(task._id, 'conflict')
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, '')
  assert.deepStrictEqual(get('meal_user_states', owner), beforeClaim)
})

test('current self-heals invalid, missing, and cross-owner control pointers without disclosure', async () => {
  reset()
  put('meal_ai_controls', owner, { owner, activeTaskId: 'invalid-task-id', generationEpoch: 1 })
  assert.strictEqual(await planner._test.readCurrentTask(owner), null)
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, '')

  const missingId = validTaskId(3)
  put('meal_ai_controls', owner, { owner, activeTaskId: missingId, generationEpoch: 2 })
  assert.strictEqual(await planner._test.readCurrentTask(owner), null)
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, '')

  const foreign = storedTask(otherOwner, 3, 4)
  put('meal_ai_tasks', foreign._id, planner._test.taskData(foreign))
  put('meal_ai_controls', owner, { owner, activeTaskId: foreign._id, generationEpoch: 3 })
  assert.strictEqual(await planner._test.readCurrentTask(owner), null)
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, '')
  await assert.rejects(
    planner._test.readTaskStatus(owner, foreign._id),
    (error) => error.code === 'TASK_NOT_FOUND' && error.message === '任务不存在',
  )
  await assert.rejects(
    planner._test.readTaskStatus(owner, validTaskId(5)),
    (error) => error.code === 'TASK_NOT_FOUND' && error.message === '任务不存在',
  )
  await assert.rejects(
    planner._test.claimWork(owner, foreign._id),
    (error) => error.code === 'TASK_NOT_FOUND' && error.message === '任务不存在',
  )
  await assert.rejects(
    planner._test.cancelGeneration(owner, foreign._id, 0),
    (error) => error.code === 'TASK_NOT_FOUND' && error.message === '任务不存在',
  )
})

test('current expires and compacts stale work while clearing its control pointer', async () => {
  reset()
  const task = storedTask(owner, 4, 6)
  task.expiresAt = Date.now()
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, { owner, activeTaskId: task._id, generationEpoch: 4 })

  const current = await planner._test.readCurrentTask(owner)
  assert.strictEqual(current.task.status, 'expired')
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, '')
  const stored = get('meal_ai_tasks', task._id)
  assert.strictEqual(stored.generationEpoch, 4)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(stored, 'input'), false)
})

test('current self-heals generation conflicts and already-terminal task pointers', async () => {
  reset()
  const mismatched = storedTask(owner, 4, 12)
  put('meal_ai_tasks', mismatched._id, planner._test.taskData(mismatched))
  put('meal_ai_controls', owner, { owner, activeTaskId: mismatched._id, generationEpoch: 5 })
  const conflicted = await planner._test.readCurrentTask(owner)
  assert.strictEqual(conflicted.task.status, 'conflict')
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, '')

  reset()
  const terminal = storedTask(owner, 6, 13)
  terminal.status = 'cancelled'
  terminal.phase = 'terminal'
  terminal.errorCode = 'AI_TASK_CANCELLED'
  terminal.failureCode = 'AI_TASK_CANCELLED'
  terminal.terminalAtMs = Date.now() - 500
  put('meal_ai_tasks', terminal._id, planner._test.taskData(terminal))
  put('meal_ai_controls', owner, { owner, activeTaskId: terminal._id, generationEpoch: 6 })
  const recovered = await planner._test.readCurrentTask(owner)
  assert.strictEqual(recovered.task.status, 'cancelled')
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, '')
  assert.strictEqual(await planner._test.readCurrentTask(owner), null)
})

test('claim conflict writes a terminal task and only clears control when it points to that task', async () => {
  reset()
  const task = storedTask(owner, 1, 7)
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, { owner, activeTaskId: task._id, generationEpoch: 2 })

  const conflicted = await planner._test.claimWork(owner, task._id)
  assert.strictEqual(conflicted.task.status, 'conflict')
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, '')
  assert.strictEqual(get('meal_ai_tasks', task._id).generationEpoch, 1)

  reset()
  const superseded = storedTask(owner, 1, 8)
  const newerId = validTaskId(9)
  put('meal_ai_tasks', superseded._id, planner._test.taskData(superseded))
  put('meal_ai_controls', owner, { owner, activeTaskId: newerId, generationEpoch: 2 })
  await planner._test.claimWork(owner, superseded._id)
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, newerId)
})

test('planner version 7 explicitly fails an active version 6 task and requires regeneration', async () => {
  reset()
  const task = storedTask(owner, 3, 19)
  task.plannerVersion = '6'
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, { owner, activeTaskId: task._id, generationEpoch: 3 })

  const outcome = await planner._test.claimWork(owner, task._id)
  assert.strictEqual(outcome.task.status, 'failed')
  assert.strictEqual(outcome.task.errorCode, 'AI_PLANNER_VERSION_UNSUPPORTED')
  assertShardCleanupPending(task._id, 'failed')
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, '')
})

test('future or invalid task versions are rejected without writes across every task entry point', async () => {
  async function rejectsWithoutWrites({ seed, mutate, action, expectedCode }) {
    reset()
    let task = storedTask(owner, 70 + seed, 150 + seed)
    if (action === 'settleSuccess' || action === 'settleFailure') {
      const leaseToken = generateLeaseToken(Buffer.alloc(32, 180 + seed))
      const work = claimNext(task, leaseToken, Date.now() - 100)
      task = work.task
      task.__testClaim = work.claim
      task.__testLeaseToken = leaseToken
    }
    mutate(task)
    const claim = task.__testClaim
    const leaseToken = task.__testLeaseToken
    delete task.__testClaim
    delete task.__testLeaseToken
    put('meal_ai_tasks', task._id, planner._test.taskData(task))
    put('meal_ai_controls', owner, {
      owner, cacheNamespace, activeTaskId: task._id, generationEpoch: task.generationEpoch,
      idempotencyEntries: [{
        idempotencyHash: task.idempotencyHash,
        requestFingerprint: task.requestFingerprint,
        taskId: task._id,
        createdAt: task.createdAt,
      }],
    })
    databaseCalls.length = 0
    const before = storesSnapshot()
    let executeCalled = false
    const operations = {
      async executeClaim() { executeCalled = true; return { title: '不得执行' } },
    }
    const invoke = {
      status: () => planner._test.readTaskStatus(owner, task._id),
      current: () => planner._test.readCurrentTask(owner),
      claim: () => planner._test.claimWork(owner, task._id),
      settleSuccess: () => planner._test.settleSuccess(
        owner, task._id, claim, leaseToken, { title: '不得写入' },
      ),
      settleFailure: () => planner._test.settleFailure(owner, task._id, claim, leaseToken, {
        code: 'AI_NETWORK_ERROR', retryable: true, retryAfterMs: 600,
      }),
      cancel: () => planner._test.cancelGeneration(owner, task._id, task.taskRevision),
      advance: () => planner._test.advanceTask(owner, task._id, { timeoutMs: 45000 }, operations),
      replayStart: () => planner._test.startTask(
        owner, input, 0, String(150 + seed).padStart(32, '0'), consent,
      ),
    }[action]
    await assert.rejects(invoke, (error) => error && error.code === expectedCode, `${action} 必须拒绝不受支持版本`)
    assert.strictEqual(executeCalled, false, `${action} 不得执行上游 AI 请求`)
    assertZeroBusinessWrites(before, action)
  }

  const scenarios = [
    { action: 'status', mutate: (task) => { task.taskSchemaVersion = 4 }, expectedCode: 'AI_TASK_SCHEMA_VERSION_UNSUPPORTED' },
    { action: 'current', mutate: (task) => { task.taskSchemaVersion = 4 }, expectedCode: 'AI_TASK_SCHEMA_VERSION_UNSUPPORTED' },
    { action: 'claim', mutate: (task) => { task.taskSchemaVersion = 4 }, expectedCode: 'AI_TASK_SCHEMA_VERSION_UNSUPPORTED' },
    { action: 'settleSuccess', mutate: (task) => { task.taskSchemaVersion = 4 }, expectedCode: 'AI_TASK_SCHEMA_VERSION_UNSUPPORTED' },
    { action: 'settleFailure', mutate: (task) => { task.taskSchemaVersion = 4 }, expectedCode: 'AI_TASK_SCHEMA_VERSION_UNSUPPORTED' },
    { action: 'cancel', mutate: (task) => { task.taskSchemaVersion = 4 }, expectedCode: 'AI_TASK_SCHEMA_VERSION_UNSUPPORTED' },
    { action: 'advance', mutate: (task) => { task.taskSchemaVersion = 4 }, expectedCode: 'AI_TASK_SCHEMA_VERSION_UNSUPPORTED' },
    { action: 'replayStart', mutate: (task) => { task.taskSchemaVersion = 4 }, expectedCode: 'AI_TASK_SCHEMA_VERSION_UNSUPPORTED' },
    { action: 'status', mutate: (task) => { task.taskSchemaVersion = '3' }, expectedCode: 'AI_TASK_VERSION_INVALID' },
    { action: 'current', mutate: (task) => { delete task.taskSchemaVersion }, expectedCode: 'AI_TASK_VERSION_INVALID' },
    { action: 'status', mutate: (task) => { task.contractVersion = CONTRACT_VERSION + 1 }, expectedCode: 'AI_CONTRACT_VERSION_UNSUPPORTED' },
    { action: 'current', mutate: (task) => { task.plannerVersion = String(Number(PLANNER_VERSION) + 1) }, expectedCode: 'AI_CONTRACT_VERSION_UNSUPPORTED' },
    { action: 'claim', mutate: (task) => { task.contractVersion = CONTRACT_VERSION + 1 }, expectedCode: 'AI_CONTRACT_VERSION_UNSUPPORTED' },
    { action: 'settleSuccess', mutate: (task) => { task.plannerVersion = String(Number(PLANNER_VERSION) + 1) }, expectedCode: 'AI_CONTRACT_VERSION_UNSUPPORTED' },
    { action: 'settleFailure', mutate: (task) => { task.contractVersion = CONTRACT_VERSION + 1 }, expectedCode: 'AI_CONTRACT_VERSION_UNSUPPORTED' },
    { action: 'cancel', mutate: (task) => { task.plannerVersion = String(Number(PLANNER_VERSION) + 1) }, expectedCode: 'AI_CONTRACT_VERSION_UNSUPPORTED' },
    { action: 'advance', mutate: (task) => { task.contractVersion = CONTRACT_VERSION + 1 }, expectedCode: 'AI_CONTRACT_VERSION_UNSUPPORTED' },
    { action: 'replayStart', mutate: (task) => { task.contractVersion = CONTRACT_VERSION + 1 }, expectedCode: 'AI_CONTRACT_VERSION_UNSUPPORTED' },
    { action: 'status', mutate: (task) => { task.contractVersion = '2' }, expectedCode: 'AI_TASK_VERSION_INVALID' },
    { action: 'status', mutate: (task) => { task.plannerVersion = '7.1.0' }, expectedCode: 'AI_TASK_VERSION_INVALID' },
  ]
  for (const [index, scenario] of scenarios.entries()) {
    await rejectsWithoutWrites({ seed: index, ...scenario })
  }

  reset()
  const terminalFuture = storedTask(owner, 91, 171)
  terminalFuture.status = 'cancelled'
  terminalFuture.phase = 'terminal'
  terminalFuture.errorCode = 'AI_TASK_CANCELLED'
  terminalFuture.contractVersion = CONTRACT_VERSION + 1
  put('meal_ai_tasks', terminalFuture._id, planner._test.taskData(terminalFuture))
  put('meal_ai_controls', owner, {
    owner, cacheNamespace, activeTaskId: terminalFuture._id, generationEpoch: terminalFuture.generationEpoch,
  })
  databaseCalls.length = 0
  const terminalBefore = storesSnapshot()
  await assert.rejects(
    planner._test.readTaskStatus(owner, terminalFuture._id),
    (error) => error && error.code === 'AI_CONTRACT_VERSION_UNSUPPORTED',
  )
  assertZeroBusinessWrites(terminalBefore, 'future terminal status')

  reset()
  const activeFuture = storedTask(owner, 92, 172)
  activeFuture.plannerVersion = String(Number(PLANNER_VERSION) + 1)
  put('meal_ai_tasks', activeFuture._id, planner._test.taskData(activeFuture))
  put('meal_ai_controls', owner, {
    owner, cacheNamespace, activeTaskId: activeFuture._id, generationEpoch: activeFuture.generationEpoch,
  })
  databaseCalls.length = 0
  const activeBefore = storesSnapshot()
  await assert.rejects(
    planner._test.startTask(owner, input, 0, '9'.repeat(32), consent),
    (error) => error && error.code === 'AI_CONTRACT_VERSION_UNSUPPORTED',
  )
  assertZeroBusinessWrites(activeBefore, 'start with future active task')
})

test('completed meal-title context is stable by chunk index and excludes current retry chunk', () => {
  const task = createTask({
    taskId: validTaskId(27), owner,
    input: { ...input, mealTypes: ['breakfast', 'lunch', 'dinner'], doubleDinner: true },
    baseStateRevision: 0, stateRevision: 0, planId: 'plan-27',
    generatedAt: '2026-08-26T00:00:00.000Z', clientRequestId: String(27).padStart(32, '0'),
    contractVersion: CONTRACT_VERSION, plannerVersion: PLANNER_VERSION, now: Date.now() - 1000,
    aiDataConsentVersion: AI_DATA_CONSENT_VERSION,
    providerRevision: providerConfig.providerRevision,
    providerConfigVersion: providerConfig.providerConfigVersion,
  })
  task.chunks[2].status = 'completed'
  task.chunks[2].result = { days: [{ meals: [{ title: '第三分片餐名' }] }] }
  task.chunks[0].status = 'completed'
  task.chunks[0].result = { days: [{ meals: [{ title: '第一分片餐名' }] }] }
  task.chunks[1].status = 'running'
  task.chunks[1].result = { days: [{ meals: [{ title: '不得读取的当前旧结果' }] }] }

  assert.deepStrictEqual(planner._test.completedMealTitles(task, 2), ['第一分片餐名'])
  assert.deepStrictEqual(planner._test.completedMealTitles(task, 3), [
    '第一分片餐名', '第三分片餐名',
  ])
  assert.deepStrictEqual(planner._test.completedMealTitles({ chunks: null }, 1), [])
})

test('cancel requires an explicit task revision and preserves CAS on conflict', async () => {
  reset()
  const task = storedTask(owner, 5, 10)
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, { owner, activeTaskId: task._id, generationEpoch: 5 })

  await assert.rejects(
    planner._test.cancelGeneration(owner, task._id),
    (error) => error.code === 'INVALID_TASK_REVISION',
  )
  await assert.rejects(
    planner._test.cancelGeneration(owner, task._id, 1),
    (error) => error.code === 'TASK_REVISION_CONFLICT',
  )
  assert.strictEqual(get('meal_ai_tasks', task._id).status, 'queued')
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, task._id)

  const cancelled = await planner._test.cancelGeneration(owner, task._id, 0)
  assert.strictEqual(cancelled.task.status, 'cancelled')
  assertShardCleanupPending(task._id, 'cancelled')
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, '')
  assert.strictEqual(get('meal_ai_tasks', task._id).generationEpoch, 5)
})

test('start is idempotent for the same owner, request id, preferences, and state revision', async () => {
  reset()
  const clientRequestId = '0123456789abcdef0123456789abcdef'
  const first = await planner._test.startTask(owner, input, 0, clientRequestId, consent)
  const replay = await planner._test.startTask(owner, input, 0, clientRequestId, consent)
  assert.strictEqual(replay.task.taskId, first.task.taskId)
  assert.strictEqual(collectionStore('meal_ai_tasks').size, 1)
  assert.strictEqual(get('meal_ai_tasks', first.task.taskId).plannerVersion, '7')
  assert.strictEqual(get('meal_ai_tasks', first.task.taskId).chunks.every((chunk) => chunk.mealSlots === 1), true)
  assert.strictEqual(get('meal_ai_controls', owner).rateCount, 1)
  await assert.rejects(
    planner._test.startTask(owner, { ...input, goals: ['提高蛋白质'] }, 0, clientRequestId, consent),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT',
  )
  assert.strictEqual(collectionStore('meal_ai_tasks').size, 1)
})

test('schema v7 remains usable across start, claim, finalize, and status without an implicit state rewrite', async () => {
  reset()
  const legacyStartState = {
    ...get('meal_user_states', owner),
    schemaVersion: 7,
    customReminders: [{ id: 'schema-7-start', text: '启动期间保留', done: false }],
  }
  delete legacyStartState.waterReminder
  put('meal_user_states', owner, legacyStartState)

  const started = await planner._test.startTask(
    owner, input, legacyStartState.stateRevision, 'a'.repeat(32), consent,
  )
  const startedTaskId = started.task.taskId
  assert.strictEqual(started.task.status, 'queued')
  assert.deepStrictEqual(get('meal_user_states', owner), legacyStartState,
    'start must only migrate schema v7 in memory')

  const claimed = await planner._test.claimWork(owner, startedTaskId)
  assert(claimed.claim, 'schema v7 task must remain claimable')
  assert.deepStrictEqual(get('meal_user_states', owner), legacyStartState,
    'claim must not rewrite schema v7 user state')

  reset()
  const final = finalClaimTask(108, 41)
  const legacyFinalizeState = {
    ...stateWithPlans({
      stateRevision: 4,
      customReminders: [{ id: 'schema-7-finalize', text: '写回期间保留', done: true }],
    }),
    schemaVersion: 7,
  }
  delete legacyFinalizeState.waterReminder
  put('meal_user_states', owner, legacyFinalizeState)
  put('meal_ai_tasks', final.task._id, planner._test.taskData(final.task))
  put('meal_ai_controls', owner, { owner, activeTaskId: final.task._id, generationEpoch: 41 })

  const finalized = await planner._test.settleSuccess(
    owner, final.task._id, final.claim, final.leaseToken, validPlan(final.task),
  )
  assert.strictEqual(finalized.task.status, 'succeeded')
  const stored = get('meal_user_states', owner)
  assert.strictEqual(stored.schemaVersion, 7,
    'aiPlanner must leave the persisted schema migration to userData')
  assert.strictEqual(Object.prototype.hasOwnProperty.call(stored, 'waterReminder'), false)
  assert.deepStrictEqual(stored.customReminders, legacyFinalizeState.customReminders)
  assert.strictEqual(stored.draftPlan.id, final.task.planId)
  assert.strictEqual(stored.stateRevision, 5)

  const status = await planner._test.readTaskStatus(owner, final.task._id)
  assert.strictEqual(status.task.status, 'succeeded')
  assert.strictEqual(status.result.draftPlan.id, final.task.planId)
  assert.strictEqual(status.result.stateRevision, 5)
  assert.strictEqual(get('meal_user_states', owner).schemaVersion, 7,
    'status must only migrate schema v7 in memory')
})

test('future user-state schemas fail closed before start or finalize can write', async () => {
  reset()
  const futureStartState = { ...get('meal_user_states', owner), schemaVersion: 9 }
  put('meal_user_states', owner, futureStartState)
  collectionStore('meal_ai_controls')
  const beforeStart = storesSnapshot()
  await assert.rejects(
    planner._test.startTask(owner, input, futureStartState.stateRevision, 'b'.repeat(32), consent),
    (error) => error.code === 'STATE_SCHEMA_UNSUPPORTED',
  )
  assertZeroBusinessWrites(beforeStart, 'future schema start')

  reset()
  const final = finalClaimTask(109, 42)
  const futureFinalizeState = { ...stateWithPlans({ stateRevision: 4 }), schemaVersion: 9 }
  put('meal_user_states', owner, futureFinalizeState)
  put('meal_ai_tasks', final.task._id, planner._test.taskData(final.task))
  put('meal_ai_controls', owner, { owner, activeTaskId: final.task._id, generationEpoch: 42 })
  const beforeFinalize = storesSnapshot()
  await assert.rejects(
    planner._test.settleSuccess(owner, final.task._id, final.claim, final.leaseToken, validPlan(final.task)),
    (error) => error.code === 'STATE_SCHEMA_UNSUPPORTED',
  )
  assertZeroBusinessWrites(beforeFinalize, 'future schema finalize')
})

test('start rejects malformed consent before any database write', async () => {
  const invalidValues = [
    undefined,
    null,
    { accepted: false, version: AI_DATA_CONSENT_VERSION },
    { accepted: true, version: AI_DATA_CONSENT_VERSION + 1 },
    { accepted: true, version: AI_DATA_CONSENT_VERSION, extra: true },
    ['accepted', AI_DATA_CONSENT_VERSION],
  ]
  for (const [index, invalid] of invalidValues.entries()) {
    reset()
    const beforeState = get('meal_user_states', owner)
    await assert.rejects(
      planner._test.startTask(owner, input, 0, String(80 + index).padStart(32, '0'), invalid),
      (error) => error.code === 'AI_DATA_CONSENT_REQUIRED',
    )
    assert.strictEqual(collectionStore('meal_ai_tasks').size, 0)
    assert.strictEqual(get('meal_ai_controls', owner), undefined)
    assert.deepStrictEqual(get('meal_user_states', owner), beforeState)
  }
})

test('start rejects invalid duration before any business write', async () => {
  const invalidDurationDays = [0, -1, 1.5, 15, '7']
  for (const [index, durationDays] of invalidDurationDays.entries()) {
    reset()
    const before = storesSnapshot()
    await assert.rejects(
      planner._test.startTask(
        owner,
        { ...input, durationDays },
        0,
        String(90 + index).padStart(32, '0'),
        consent,
      ),
      /1–14 天的整数/,
    )
    assertZeroBusinessWrites(before, `invalid duration ${String(durationDays)}`)
  }
})

test('start rejects missing diet or exercise intent before any business write', async () => {
  const cases = [
    [{ ...input, goals: [], styles: [], customGoal: '' }, 'DIET_INTENT_REQUIRED'],
    [{ ...input, exerciseIntent: undefined }, 'EXERCISE_INTENT_REQUIRED'],
    [{ ...input, exerciseIntent: 'daily', exerciseByDay: [] }, 'EXERCISE_PLAN_REQUIRED'],
    [{
      ...input,
      exerciseIntent: 'none',
      exerciseByDay: [{ dayIndex: 0, planned: true, type: '快走', durationMinutes: 30, intensity: 'medium' }],
    }, 'EXERCISE_PLAN_INVALID'],
  ]
  for (const [index, [preferences, expectedCode]] of cases.entries()) {
    reset()
    const before = storesSnapshot()
    await assert.rejects(
      planner._test.startTask(
        owner,
        preferences,
        0,
        String(96 + index).padStart(32, '0'),
        consent,
      ),
      (error) => error.code === expectedCode,
    )
    assertZeroBusinessWrites(before, `missing explicit intent ${expectedCode}`)
  }
})

test('public start exposes a fixed intent error without creating a task', async () => {
  reset()
  wxContext = { OPENID: owner }
  const apiKeyName = ['AI', 'API', 'KEY'].join('_')
  process.env[apiKeyName] = 'TEST_PLACEHOLDER_ONLY'
  process.env.AI_API_BASE_URL = 'https://example.invalid'
  process.env.AI_PROVIDER_DISPLAY_NAME = 'Synthetic AI'
  process.env.AI_PROVIDER_REVISION = '1'
  const logs = []
  const originalError = console.error
  console.error = (...values) => logs.push(values)
  try {
    const response = await planner.main({
      action: 'start',
      expectedCacheNamespace: cacheNamespace,
      preferences: { ...input, exerciseIntent: undefined },
      expectedStateRevision: 0,
      clientRequestId: '95959595959595959595959595959595',
      aiDataConsent: consent,
    })
    assert.deepStrictEqual(response, {
      success: false,
      code: 'EXERCISE_INTENT_REQUIRED',
      message: '请明确选择本周期是否安排运动',
      stage: 'PREFLIGHT',
    })
    assert.strictEqual(collectionStore('meal_ai_tasks').size, 0)
    assert.strictEqual(get('meal_ai_controls', owner), undefined)
    assert.deepStrictEqual(logs, [[{ code: 'EXERCISE_INTENT_REQUIRED', stage: 'PREFLIGHT' }]])
  } finally {
    console.error = originalError
    wxContext = {}
    delete process.env[apiKeyName]
    delete process.env.AI_API_BASE_URL
    delete process.env.AI_PROVIDER_DISPLAY_NAME
    delete process.env.AI_PROVIDER_REVISION
  }
})

test('public start rejects missing consent without task writes or private logging', async () => {
  reset()
  wxContext = { OPENID: owner }
  const apiKeyName = ['AI', 'API', 'KEY'].join('_')
  process.env[apiKeyName] = 'TEST_PLACEHOLDER_ONLY'
  process.env.AI_API_BASE_URL = 'https://example.invalid'
  process.env.AI_PROVIDER_DISPLAY_NAME = 'Synthetic AI'
  process.env.AI_PROVIDER_REVISION = '1'
  const logs = []
  const originalError = console.error
  console.error = (...values) => logs.push(values)
  try {
    const marker = 'PRIVATE_HEALTH_MARKER_MUST_NOT_LOG'
    const response = await planner.main({
      action: 'start',
      expectedCacheNamespace: cacheNamespace,
      preferences: { ...input, healthNotes: marker },
      expectedStateRevision: 0,
      clientRequestId: '99999999999999999999999999999999',
    })
    assert.strictEqual(response.success, false)
    assert.strictEqual(response.code, 'AI_DATA_CONSENT_REQUIRED')
    assert.strictEqual(response.stage, 'PREFLIGHT')
    assert.strictEqual(collectionStore('meal_ai_tasks').size, 0)
    assert.strictEqual(get('meal_ai_controls', owner), undefined)
    assert.strictEqual(JSON.stringify(logs).includes(marker), false)
    assert.strictEqual(JSON.stringify(logs).includes('healthNotes'), false)
  } finally {
    console.error = originalError
    wxContext = {}
    delete process.env[apiKeyName]
    delete process.env.AI_API_BASE_URL
    delete process.env.AI_PROVIDER_DISPLAY_NAME
    delete process.env.AI_PROVIDER_REVISION
  }
})

test('public start reports only fixed transaction stages and never exposes private failures', async () => {
  const failures = [
    {
      install(error) { transactionFailure = error },
      expectedStage: 'START_TRANSACTION_BEGIN',
    },
    {
      install(error) { readFailures.set('meal_user_states', error) },
      expectedStage: 'START_TRANSACTION_READ',
    },
    {
      install(error) { setFailures.set('meal_ai_tasks', error) },
      expectedStage: 'START_TRANSACTION_WRITE',
    },
    {
      install(error) { transactionCommitFailure = error },
      expectedStage: 'START_TRANSACTION_COMMIT',
    },
  ]
  for (const [index, scenario] of failures.entries()) {
    reset()
    wxContext = { OPENID: owner }
    const privateMarker = `PRIVATE_START_FAILURE_${index}_openid_env_request_key_meal`
    const error = Object.assign(new Error(privateMarker), {
      code: 'PRIVATE_DATABASE_FAILURE', errCode: 'PRIVATE_SDK_CODE',
      stack: `PRIVATE_STACK_${privateMarker}`, requestId: `PRIVATE_REQUEST_${index}`,
    })
    scenario.install(error)
    const apiKeyName = ['AI', 'API', 'KEY'].join('_')
    process.env[apiKeyName] = 'TEST_PLACEHOLDER_ONLY'
    process.env.AI_API_BASE_URL = 'https://example.invalid'
    process.env.AI_PROVIDER_DISPLAY_NAME = 'Synthetic AI'
    process.env.AI_PROVIDER_REVISION = '1'
    const logs = []
    const originalError = console.error
    console.error = (...values) => logs.push(values)
    try {
      const response = await planner.main({
        action: 'start',
        expectedCacheNamespace: cacheNamespace,
        preferences: input,
        expectedStateRevision: 0,
        clientRequestId: String(index + 300).padStart(32, '0'),
        aiDataConsent: consent,
      })
      assert.deepStrictEqual(response, {
        success: false,
        code: 'AI_GENERATION_FAILED',
        message: 'AI 没能生成合格计划，请重试；当前计划未改变',
        stage: scenario.expectedStage,
      })
      assert.deepStrictEqual(logs, [[{
        code: 'AI_GENERATION_FAILED', stage: scenario.expectedStage,
      }]])
      const publicSurface = JSON.stringify({ response, logs })
      assert.strictEqual(publicSurface.includes(privateMarker), false)
      assert.strictEqual(publicSurface.includes('PRIVATE_SDK_CODE'), false)
      assert.strictEqual(publicSurface.includes('PRIVATE_REQUEST'), false)
    } finally {
      console.error = originalError
      wxContext = {}
      delete process.env[apiKeyName]
      delete process.env.AI_API_BASE_URL
      delete process.env.AI_PROVIDER_DISPLAY_NAME
      delete process.env.AI_PROVIDER_REVISION
    }
  }
})

test('public task status reports only fixed transaction stages and never exposes private failures', async () => {
  const failures = [
    {
      install(error) { transactionFailure = error },
      expectedStage: 'STATUS_TRANSACTION_BEGIN',
    },
    ...[
      ['meal_ai_tasks', 'STATUS_READ_TASK'],
      ['meal_ai_controls', 'STATUS_READ_CONTROL'],
    ].map(([collectionName, expectedStage]) => ({
      install(error) { readFailures.set(collectionName, error) }, expectedStage,
    })),
    {
      install(error) {
        let memberReads = 0
        readFailures.set('meal_members', () => {
          memberReads += 1
          return memberReads === 2 ? error : null
        })
      },
      expectedStage: 'STATUS_READ_MEMBER',
    },
    {
      install(error) { transactionCommitFailure = error },
      expectedStage: 'STATUS_TRANSACTION_COMMIT',
    },
  ]
  for (const [index, scenario] of failures.entries()) {
    reset()
    wxContext = { OPENID: owner }
    const task = storedTask(owner, 31 + index, 90 + index)
    put('meal_ai_tasks', task._id, planner._test.taskData(task))
    put('meal_ai_controls', owner, {
      owner, cacheNamespace, activeTaskId: task._id, generationEpoch: task.generationEpoch,
    })
    const privateMarker = `PRIVATE_STATUS_FAILURE_${index}_identity_request_key_meal`
    const error = Object.assign(new Error(privateMarker), {
      code: 'PRIVATE_DATABASE_FAILURE', errCode: 'PRIVATE_SDK_CODE',
    })
    scenario.install(error)
    const logs = []
    const originalError = console.error
    console.error = (...values) => logs.push(values)
    try {
      const response = await planner.main({
        action: 'status', taskId: task._id, expectedCacheNamespace: cacheNamespace,
      })
      assert.deepStrictEqual(response, {
        success: false,
        code: 'AI_GENERATION_FAILED',
        message: 'AI 没能生成合格计划，请重试；当前计划未改变',
        stage: scenario.expectedStage,
      })
      assert.deepStrictEqual(logs, [[{
        code: 'AI_GENERATION_FAILED', stage: scenario.expectedStage,
      }]])
      assert.strictEqual(JSON.stringify({ response, logs }).includes(privateMarker), false)
    } finally {
      console.error = originalError
      wxContext = {}
    }
  }
})

test('queued task status does not read the full user state', async () => {
  reset()
  wxContext = { OPENID: owner }
  const runtimeEnv = {
    AI_API_KEY: process.env.AI_API_KEY,
    AI_API_BASE_URL: process.env.AI_API_BASE_URL,
    AI_PROVIDER_DISPLAY_NAME: process.env.AI_PROVIDER_DISPLAY_NAME,
    AI_PROVIDER_REVISION: process.env.AI_PROVIDER_REVISION,
  }
  process.env.AI_API_KEY = 'TEST_PLACEHOLDER_ONLY'
  process.env.AI_API_BASE_URL = 'https://example.invalid'
  process.env.AI_PROVIDER_DISPLAY_NAME = 'Synthetic AI'
  process.env.AI_PROVIDER_REVISION = '1'
  const task = storedTask(owner, 41, 101)
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, {
    owner, cacheNamespace, activeTaskId: task._id, generationEpoch: task.generationEpoch,
  })
  readFailures.set('meal_user_states', Object.assign(new Error('QUEUED_STATE_MUST_NOT_BE_READ'), {
    code: 'PRIVATE_DATABASE_FAILURE',
  }))
  try {
    const response = await planner.main({
      action: 'status', taskId: task._id, expectedCacheNamespace: cacheNamespace,
    })
    assert.strictEqual(response.success, true)
    assert.strictEqual(response.data.task.status, 'queued')
    assert.strictEqual(response.data.result, null)
    assert.strictEqual(databaseCalls.some((call) => (
      call.collection === 'meal_user_states' && call.operation === 'get'
    )), false)
  } finally {
    wxContext = {}
    Object.entries(runtimeEnv).forEach(([name, value]) => {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    })
  }
})

test('outline and detail settlement do not read the full user state', async () => {
  for (const kind of ['outline', 'detail']) {
    reset()
    const task = storedTask(owner, 51, kind === 'outline' ? 111 : 112)
    const leaseToken = generateLeaseToken(Buffer.alloc(32, kind === 'outline' ? 111 : 112))
    if (kind === 'detail') {
      task.outline.status = 'completed'
      task.outline.result = { title: '提纲', rationale: ['依据'] }
      task.outlineHash = 'c'.repeat(64)
      task.chunks.forEach((chunk) => { chunk.outlineHash = task.outlineHash })
    }
    const claimed = claimNext(task, leaseToken, Date.now() - 100)
    put('meal_ai_tasks', task._id, planner._test.taskData(claimed.task))
    put('meal_ai_controls', owner, {
      owner, cacheNamespace, activeTaskId: task._id, generationEpoch: task.generationEpoch,
    })
    readFailures.set('meal_user_states', Object.assign(new Error('NON_FINAL_STATE_MUST_NOT_BE_READ'), {
      code: 'PRIVATE_DATABASE_FAILURE',
    }))
    const result = kind === 'outline'
      ? { title: '新提纲', rationale: ['依据'] }
      : { days: [] }
    const response = await planner._test.settleSuccess(
      owner, task._id, claimed.claim, leaseToken, result,
    )
    assert(response.task)
    assert.strictEqual(databaseCalls.some((call) => (
      call.name === 'meal_user_states' && call.operation === 'get'
    )), false)
  }
})

test('provider compatibility profile is persisted once and can only move toward a weaker request', async () => {
  reset()
  let task = storedTask(owner, 52, 113)
  task.providerRequestProfile = PROFILE_FULL
  const outlineToken = generateLeaseToken(Buffer.alloc(32, 113))
  const outlineWork = claimNext(task, outlineToken, Date.now() - 100)
  put('meal_ai_tasks', task._id, planner._test.taskData(outlineWork.task))
  put('meal_ai_controls', owner, {
    owner, cacheNamespace, activeTaskId: task._id, generationEpoch: task.generationEpoch,
  })
  await rawPlannerTest.settleSuccess(
    owner, task._id, outlineWork.claim, outlineToken,
    { title: '兼容提纲', rationale: ['合成测试依据'] }, cacheNamespace,
    PROFILE_NO_MAX_TOKENS, providerConfig,
  )
  const afterOutline = { ...get('meal_ai_tasks', task._id), _id: task._id }
  assert.strictEqual(afterOutline.providerRequestProfile, PROFILE_NO_MAX_TOKENS)

  const detailToken = generateLeaseToken(Buffer.alloc(32, 114))
  const detailWork = claimNext(afterOutline, detailToken, Date.now() - 50)
  put('meal_ai_tasks', task._id, planner._test.taskData(detailWork.task))
  await assert.rejects(rawPlannerTest.settleSuccess(
    owner, task._id, detailWork.claim, detailToken, { days: [] }, cacheNamespace,
    PROFILE_FULL, providerConfig,
  ), (error) => error.code === 'AI_REQUEST_INVALID')
  assert.strictEqual(get('meal_ai_tasks', task._id).providerRequestProfile, PROFILE_NO_MAX_TOKENS)

  await rawPlannerTest.settleSuccess(
    owner, task._id, detailWork.claim, detailToken, { days: [] }, cacheNamespace,
    PROFILE_NO_MAX_TOKENS_OR_REASONING, providerConfig,
  )
  assert.strictEqual(
    get('meal_ai_tasks', task._id).providerRequestProfile,
    PROFILE_NO_MAX_TOKENS_OR_REASONING,
  )
})

test('known public codes use fixed messages instead of untrusted error text', () => {
  const privateMarker = 'PRIVATE_KNOWN_CODE_MESSAGE_WITH_IDENTITY_AND_KEY'
  assert.deepStrictEqual(
    planner._test.publicError({ code: 'AI_DATA_CONSENT_REQUIRED', message: privateMarker }),
    { code: 'AI_DATA_CONSENT_REQUIRED', message: '请重新确认本次 AI 数据发送范围' },
  )
  assert.strictEqual(
    JSON.stringify(planner._test.publicError({ code: 'TASK_NOT_FOUND', message: privateMarker }))
      .includes(privateMarker),
    false,
  )
  assert.deepStrictEqual(
    planner._test.publicError({ code: 'AI_TASK_SCHEMA_VERSION_UNSUPPORTED', message: privateMarker }),
    { code: 'AI_TASK_SCHEMA_VERSION_UNSUPPORTED', message: '生成任务来自更新版本，请升级小程序后重试' },
  )
})

test('idempotent replay closes an active task without consent before comparing new fingerprints', async () => {
  reset()
  const task = noConsentActiveTask(78, 22, 'active')
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, {
    owner,
    activeTaskId: task._id,
    generationEpoch: 22,
    idempotencyEntries: [{
      idempotencyHash: task.idempotencyHash,
      requestFingerprint: task.requestFingerprint,
      taskId: task._id,
      createdAt: task.createdAt,
    }],
  })
  const replay = await planner._test.startTask(
    owner, { ...input, goals: ['提高蛋白质'] }, 0, String(78).padStart(32, '0'), consent,
  )
  assert.strictEqual(replay.task.status, 'failed')
  assert.strictEqual(replay.task.errorCode, 'AI_DATA_CONSENT_REQUIRED')
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, '')
  assert.strictEqual(get('meal_ai_tasks', task._id).input, undefined)
})

test('idempotent replay fails closed when the legacy active task has no plan baseline', async () => {
  reset()
  const task = legacyActiveTask(67, 18, 'active')
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, {
    owner,
    activeTaskId: task._id,
    generationEpoch: 18,
    idempotencyEntries: [{
      idempotencyHash: task.idempotencyHash,
      requestFingerprint: task.requestFingerprint,
      taskId: task._id,
      createdAt: task.createdAt,
    }],
  })
  const before = get('meal_user_states', owner)
  const replay = await planner._test.startTask(owner, input, 0, String(67).padStart(32, '0'), consent)
  assert.strictEqual(replay.task.status, 'conflict')
  assert.strictEqual(replay.result, null)
  assert.strictEqual(get('meal_ai_tasks', task._id).input, undefined)
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, '')
  assert.deepStrictEqual(get('meal_user_states', owner), before)
})

test('late workers cannot settle success or failure into a legacy task without a plan baseline', async () => {
  reset()
  let task = storedTask(owner, 19, 68)
  let leaseToken = generateLeaseToken(Buffer.alloc(32, 100))
  let work = claimNext(task, leaseToken, Date.now() - 500)
  task = work.task
  delete task.planStateFingerprint
  task.taskSchemaVersion = 1
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, { owner, activeTaskId: task._id, generationEpoch: 19 })
  const beforeSuccess = get('meal_user_states', owner)
  const succeeded = await planner._test.settleSuccess(
    owner, task._id, work.claim, leaseToken, { title: '不得写入的旧 worker 结果' },
  )
  assert.strictEqual(succeeded.task.status, 'conflict')
  assert.strictEqual(succeeded.result, null)
  assert.deepStrictEqual(get('meal_user_states', owner), beforeSuccess)
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, '')

  reset()
  task = storedTask(owner, 20, 69)
  leaseToken = generateLeaseToken(Buffer.alloc(32, 101))
  work = claimNext(task, leaseToken, Date.now() - 500)
  task = work.task
  delete task.planStateFingerprint
  task.taskSchemaVersion = 1
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, { owner, activeTaskId: task._id, generationEpoch: 20 })
  const beforeFailure = get('meal_user_states', owner)
  const failed = await planner._test.settleFailure(owner, task._id, work.claim, leaseToken, {
    code: 'AI_NETWORK_ERROR', retryable: true, retryAfterMs: 600,
  })
  assert.strictEqual(failed.task.status, 'conflict')
  assert.strictEqual(failed.result, null)
  assert.deepStrictEqual(get('meal_user_states', owner), beforeFailure)
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, '')
})

test('old tasks without consent fail closed on status, current, claim, and late settlement', async () => {
  reset()
  let task = noConsentActiveTask(72, 23, 'pending')
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, { owner, activeTaskId: task._id, generationEpoch: 23 })
  const status = await planner._test.readTaskStatus(owner, task._id)
  assert.strictEqual(status.task.status, 'failed')
  assert.strictEqual(status.task.errorCode, 'AI_DATA_CONSENT_REQUIRED')
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, '')

  reset()
  task = noConsentActiveTask(73, 24, 'processing')
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, { owner, activeTaskId: task._id, generationEpoch: 24 })
  const current = await planner._test.readCurrentTask(owner)
  assert.strictEqual(current.task.status, 'failed')
  assert.strictEqual(current.task.errorCode, 'AI_DATA_CONSENT_REQUIRED')

  reset()
  task = noConsentActiveTask(74, 25, 'validating')
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, { owner, activeTaskId: task._id, generationEpoch: 25 })
  const claimed = await planner._test.claimWork(owner, task._id)
  assert.strictEqual(claimed.claim, null)
  assert.strictEqual(claimed.task.status, 'failed')
  assert.strictEqual(claimed.task.errorCode, 'AI_DATA_CONSENT_REQUIRED')

  reset()
  task = storedTask(owner, 26, 75)
  const leaseToken = generateLeaseToken(Buffer.alloc(32, 102))
  const work = claimNext(task, leaseToken, Date.now() - 500)
  task = work.task
  delete task.aiDataConsentVersion
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, { owner, activeTaskId: task._id, generationEpoch: 26 })
  const succeeded = await planner._test.settleSuccess(owner, task._id, work.claim, leaseToken, { title: 'discard' })
  assert.strictEqual(succeeded.task.status, 'failed')
  assert.strictEqual(succeeded.task.errorCode, 'AI_DATA_CONSENT_REQUIRED')

  reset()
  task = storedTask(owner, 27, 76)
  const failureLeaseToken = generateLeaseToken(Buffer.alloc(32, 103))
  const failureWork = claimNext(task, failureLeaseToken, Date.now() - 500)
  task = failureWork.task
  delete task.aiDataConsentVersion
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, { owner, activeTaskId: task._id, generationEpoch: 27 })
  const failed = await planner._test.settleFailure(owner, task._id, failureWork.claim, failureLeaseToken, {
    code: 'AI_NETWORK_ERROR', retryable: true, retryAfterMs: 600,
  })
  assert.strictEqual(failed.task.status, 'failed')
  assert.strictEqual(failed.task.errorCode, 'AI_DATA_CONSENT_REQUIRED')
})

test('advance does not resolve or execute upstream work for a task without consent', async () => {
  reset()
  const task = noConsentActiveTask(77, 28, 'queued')
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, { owner, activeTaskId: task._id, generationEpoch: 28 })
  let executeCalls = 0
  const outcome = await planner._test.advanceTask(owner, task._id, { timeoutMs: 45000, url: null }, {
    async executeClaim() { executeCalls += 1; throw new Error('must not execute') },
  })
  assert.strictEqual(outcome.task.status, 'failed')
  assert.strictEqual(outcome.task.errorCode, 'AI_DATA_CONSENT_REQUIRED')
  assert.strictEqual(executeCalls, 0)
})

test('legacy finalize without a plan baseline cannot write the generated draft', async () => {
  reset()
  const final = finalClaimTask(70, 21)
  delete final.task.planStateFingerprint
  final.task.taskSchemaVersion = 1
  const latest = stateWithPlans({
    stateRevision: 4,
    selectedDay: 2,
    customReminders: [{ id: 'keep-reminder', text: '保留提醒', done: false }],
  })
  put('meal_user_states', owner, latest)
  put('meal_ai_tasks', final.task._id, planner._test.taskData(final.task))
  put('meal_ai_controls', owner, { owner, activeTaskId: final.task._id, generationEpoch: 21 })
  const before = get('meal_user_states', owner)
  const outcome = await planner._test.settleSuccess(
    owner, final.task._id, final.claim, final.leaseToken, validPlan(final.task),
  )
  assert.strictEqual(outcome.task.status, 'conflict')
  assert.strictEqual(outcome.result, null)
  assert.deepStrictEqual(get('meal_user_states', owner), before)
  assert.strictEqual(get('meal_user_states', owner).stateRevision, 4)
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, '')
})

test('finalize merges into latest state when shopping, reminders, UI, and meal overrides changed', async () => {
  reset()
  const activePlan = referencePlan(40)
  const selectedDayId = activePlan.days[3].id
  const shoppingId = activePlan.shoppingGroups[0].items[0].id
  const mealId = activePlan.days[0].meals[0].id
  const { task, claim, leaseToken } = finalClaimTask(20, 8, input, { activePlan })
  const latest = stateWithPlans({
    stateRevision: 4,
    activePlan,
    selectedDay: 3,
    selectedDayId,
    defaultDinnerMode: 'workout',
    dinnerModeByDay: { [selectedDayId]: 'workout' },
    checkedShoppingIds: [shoppingId],
    customReminders: [{ id: 'reminder-concurrent', text: '并发提醒', done: true }],
    settings: { calciumAnchorReminder: true, vitaminDReminder: true },
    mealOverrides: {
      [mealId]: {
        title: '并发调整餐名', ingredients: '并发调整食材', method: '并发调整做法',
        tag: '并发标签', updatedAt: '2026-08-26T07:59:00.000Z',
      },
    },
  })
  put('meal_user_states', owner, latest)
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, { owner, activeTaskId: task._id, generationEpoch: 8 })

  const outcome = await planner._test.settleSuccess(owner, task._id, claim, leaseToken, validPlan(task))
  assert.strictEqual(outcome.task.status, 'succeeded')
  assertShardCleanupPending(task._id, 'succeeded')
  assert.strictEqual(outcome.result.stateRevision, 5)
  const stored = get('meal_user_states', owner)
  assert.strictEqual(stored.stateRevision, 5)
  assert.strictEqual(stored.draftPlan.id, task.planId)
  assert.strictEqual(stored.selectedDay, 3)
  assert.strictEqual(stored.selectedDayId, selectedDayId)
  assert.strictEqual(stored.defaultDinnerMode, 'workout')
  assert.deepStrictEqual(stored.dinnerModeByDay, { [selectedDayId]: 'workout' })
  assert.deepStrictEqual(stored.checkedShoppingIds, [shoppingId])
  assert.deepStrictEqual(stored.customReminders, latest.customReminders)
  assert.deepStrictEqual(stored.settings, latest.settings)
  assert.deepStrictEqual(stored.mealOverrides, latest.mealOverrides)
  assert.deepStrictEqual(stored.planUiStateByPlan, latest.planUiStateByPlan)
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, '')
})

test('finalize conflicts when the same preferences now point at updated draft content', async () => {
  reset()
  const activePlan = referencePlan(41)
  const draftPlan = referencePlan(42)
  const baseline = stateWithPlans({ activePlan, draftPlan, stateRevision: 0 })
  const updatedDraft = { ...draftPlan, planVersion: draftPlan.planVersion + 1, title: '并发更新候选计划' }
  const latest = stateWithPlans({ ...baseline, draftPlan: updatedDraft, stateRevision: 1 })
  await assertFinalizeConflict(60, 11, baseline, latest)
})

test('finalize conflicts after the baseline draft was confirmed during generation', async () => {
  reset()
  const baseline = stateWithPlans({
    activePlan: referencePlan(43), draftPlan: referencePlan(44), stateRevision: 0,
  })
  const latest = confirmDraft(baseline, baseline.stateRevision)
  await assertFinalizeConflict(61, 12, baseline, latest)
})

test('finalize conflicts after a history plan was restored during generation', async () => {
  reset()
  const historyPlan = referencePlan(47)
  const baseline = stateWithPlans({
    activePlan: referencePlan(45), draftPlan: referencePlan(46),
    planHistory: [historyPlan], stateRevision: 0,
  })
  const latest = restoreHistory(baseline, historyPlan.id, baseline.stateRevision)
  await assertFinalizeConflict(62, 13, baseline, latest)
})

test('finalize conflicts after the baseline draft was discarded during generation', async () => {
  reset()
  const baseline = stateWithPlans({
    activePlan: referencePlan(48), draftPlan: referencePlan(49), stateRevision: 0,
  })
  const latest = sanitizeState({
    ...baseline, draftPlan: null, stateRevision: baseline.stateRevision + 1,
  }, { preserveUnknownFrom: baseline })
  await assertFinalizeConflict(63, 14, baseline, latest)
})

test('finalize preserves trusted future preference fields and rejects unknown task fields', async () => {
  reset()
  const exercise = {
    dayIndex: 0, planned: true, type: '快走', durationMinutes: 30, intensity: 'medium',
  }
  const preferences = { ...input, exerciseIntent: 'daily', exerciseByDay: [exercise] }
  const { task, claim, leaseToken } = finalClaimTask(31, 10, preferences)
  task.input.futureClientPreference = { shouldNotPersist: true }
  task.input.exerciseByDay[0].futureClientExerciseField = 'reject-me'
  put('meal_user_states', owner, {
    ...defaults(), stateRevision: 2,
    generationPreferences: {
      ...preferences,
      futureServerPreference: { cadence: 2, nested: { source: 'stored-state' } },
      exerciseByDay: [{ ...exercise, futureExerciseField: { source: 'stored-state' } }],
    },
  })
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, { owner, activeTaskId: task._id, generationEpoch: 10 })

  const outcome = await planner._test.settleSuccess(owner, task._id, claim, leaseToken, validPlan(task))
  assert.strictEqual(outcome.task.status, 'succeeded')
  const stored = get('meal_user_states', owner)
  assert.deepStrictEqual(stored.generationPreferences.futureServerPreference, {
    cadence: 2, nested: { source: 'stored-state' },
  })
  assert.deepStrictEqual(stored.generationPreferences.exerciseByDay[0].futureExerciseField, {
    source: 'stored-state',
  })
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(stored.generationPreferences, 'futureClientPreference'), false,
  )
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
      stored.generationPreferences.exerciseByDay[0], 'futureClientExerciseField',
    ), false,
  )
  assert.deepStrictEqual(outcome.result.generationPreferences, stored.generationPreferences)
})

test('finalize atomically replaces nested state fields and preserves unknown top-level data', async () => {
  reset()
  const exercise = {
    dayIndex: 0, planned: true, type: '快走', durationMinutes: 30, intensity: 'medium',
  }
  const preferences = { ...input, exerciseIntent: 'daily', exerciseByDay: [exercise] }
  const { task, claim, leaseToken } = finalClaimTask(64, 15, preferences)
  const dynamicPreferenceKey = 'window.2026$08'
  const unknownTopLevel = {
    'server.future$field': { retained: true },
  }
  put('meal_user_states', owner, {
    ...defaults(),
    stateRevision: 3,
    generationPreferences: {
      ...preferences,
      futureServerPreference: { [dynamicPreferenceKey]: { cadence: 2 } },
    },
    futureTopLevelField: unknownTopLevel,
  })
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, { owner, activeTaskId: task._id, generationEpoch: 15 })

  const outcome = await planner._test.settleSuccess(owner, task._id, claim, leaseToken, validPlan(task))
  assert.strictEqual(outcome.task.status, 'succeeded')
  const stateUpdate = updateCalls.find((call) => call.name === 'meal_user_states' && call.id === owner)
  assert(stateUpdate, 'finalize must update the current user state document')
  assert.deepStrictEqual(Object.keys(stateUpdate.data).sort(), [
    'draftPlan', 'generationPreferences', 'stateRevision', 'updatedAt',
  ])
  assert.strictEqual(isAtomicSet(stateUpdate.data.draftPlan), true)
  assert.strictEqual(isAtomicSet(stateUpdate.data.generationPreferences), true)
  assert.strictEqual(isAtomicSet(stateUpdate.data.stateRevision), true)
  assert.deepStrictEqual(
    stateUpdate.data.generationPreferences.value.futureServerPreference[dynamicPreferenceKey],
    { cadence: 2 },
  )
  const stored = get('meal_user_states', owner)
  assert.deepStrictEqual(stored.futureTopLevelField, unknownTopLevel)
  assert.deepStrictEqual(
    stored.generationPreferences.futureServerPreference[dynamicPreferenceKey],
    { cadence: 2 },
  )
})

test('finalize conflicts when the latest generation preferences changed', async () => {
  reset()
  const baseline = stateWithPlans({ stateRevision: 0 })
  const latest = stateWithPlans({
    stateRevision: 1,
    generationPreferences: { ...input, styles: ['高蛋白'] },
    selectedDay: 2, checkedShoppingIds: ['ingredient-keep'],
  })
  await assertFinalizeConflict(30, 9, baseline, latest)
})

test('invalid cancel revision remains a public client error', () => {
  assert.deepStrictEqual(
    planner._test.publicError({ code: 'INVALID_TASK_REVISION', message: '请刷新生成进度后再取消' }),
    { code: 'INVALID_TASK_REVISION', message: '请刷新生成进度后再取消' },
  )
})

test('upstream failure policy separates terminal rejection from bounded retries', () => {
  assert.deepStrictEqual(planner._test.retryPolicy({ code: 'AI_UPSTREAM_AUTH_REJECTED', retryable: false }), {
    code: 'AI_UPSTREAM_AUTH_REJECTED', retryable: false, retryAfterMs: 0,
  })
  assert.deepStrictEqual(planner._test.retryPolicy({ code: 'AI_UPSTREAM_FORBIDDEN', retryable: false }), {
    code: 'AI_UPSTREAM_FORBIDDEN', retryable: false, retryAfterMs: 0,
  })
  assert.deepStrictEqual(planner._test.retryPolicy({ code: 'AI_UPSTREAM_REQUEST_REJECTED', retryable: false }), {
    code: 'AI_UPSTREAM_REQUEST_REJECTED', retryable: false, retryAfterMs: 0,
  })
  assert.deepStrictEqual(planner._test.retryPolicy({
    code: 'AI_UPSTREAM_RATE_LIMITED', retryable: true, retryAfterMs: 999999,
  }), { code: 'AI_UPSTREAM_RATE_LIMITED', retryable: true, retryAfterMs: 30000 })
  assert.deepStrictEqual(planner._test.retryPolicy({ code: 'AI_NETWORK_ERROR', retryable: true }), {
    code: 'AI_NETWORK_ERROR', retryable: true, retryAfterMs: 600,
  })
  assert.deepStrictEqual(planner._test.retryPolicy({ code: 'AI_RESPONSE_REFUSED', retryable: false }), {
    code: 'AI_RESPONSE_REFUSED', retryable: false, retryAfterMs: 0,
  })
  assert.deepStrictEqual(planner._test.retryPolicy(new Error('invalid model output')), {
    code: 'AI_OUTPUT_INVALID', retryable: true, retryAfterMs: 600,
  })
})

test('advance does not overwrite an ambiguously failed success settlement', async () => {
  reset()
  const task = storedTask(owner, 1, 11)
  const claim = { taskId: task._id, kind: 'finalize', index: -1, leaseToken: 'a'.repeat(43) }
  let failureSettlementCalled = false
  await assert.rejects(
    planner._test.advanceTask(owner, task._id, { timeoutMs: 45000 }, {
      async claimWork() { return { task, claim } },
      async executeClaim() { return { generated: true } },
      async settleSuccess() { throw Object.assign(new Error('write failed'), { code: 'DATABASE_TIMEOUT' }) },
      async settleFailure() { failureSettlementCalled = true },
    }),
    (error) => planner._test.publicStage(error) === 'ADVANCE_SETTLE_SUCCESS',
  )
  assert.strictEqual(failureSettlementCalled, false)
})

test('advance reports fixed claim and failure-settlement stages', async () => {
  reset()
  const task = storedTask(owner, 1, 11)
  const claim = { taskId: task._id, kind: 'outline', index: -1, leaseToken: 'b'.repeat(43) }
  await assert.rejects(
    planner._test.advanceTask(owner, task._id, { timeoutMs: 45000 }, {
      async claimWork() { throw Object.assign(new Error('claim failed'), { code: 'DATABASE_TIMEOUT' }) },
    }),
    (error) => planner._test.publicStage(error) === 'ADVANCE_CLAIM',
  )
  await assert.rejects(
    planner._test.advanceTask(owner, task._id, { timeoutMs: 45000 }, {
      async claimWork() { return { task, claim } },
      async executeClaim() { throw Object.assign(new Error('provider failed'), { code: 'AI_NETWORK_ERROR' }) },
      async settleFailure() { throw Object.assign(new Error('settlement failed'), { code: 'DATABASE_TIMEOUT' }) },
    }),
    (error) => planner._test.publicStage(error) === 'ADVANCE_SETTLE_FAILURE',
  )
})

const originalNow = Date.now
Date.now = () => Date.UTC(2026, 7, 26, 8, 0, 0)

;(async () => {
  let passed = 0
  try {
    for (const { name, run } of tests) {
      await run()
      passed += 1
      console.log(`✓ ${name}`)
    }
    console.log(`AI planner wiring tests passed: ${passed}/${tests.length}`)
  } finally {
    Date.now = originalNow
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
