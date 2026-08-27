'use strict'

const assert = require('assert')
const Module = require('module')
const { CONTRACT_VERSION, PLANNER_VERSION, expectedMealKeys, normalizeRequest, normalizePlan } = require('./lib')
const { defaults, sanitizeState, sanitizePlan, confirmDraft, restoreHistory } = require('./user-state')
const { createTask, generateTaskId, generateLeaseToken, claimNext, completeClaim } = require('./task-core')

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

const stores = new Map()

function collectionStore(name) {
  if (!stores.has(name)) stores.set(name, new Map())
  return stores.get(name)
}

function reference(name, id) {
  return {
    async get() {
      const value = collectionStore(name).get(id)
      return { data: value === undefined ? null : clone(value) }
    },
    async set({ data }) {
      collectionStore(name).set(id, clone(data))
      return { stats: { updated: 1 } }
    },
    async update({ data }) {
      const current = collectionStore(name).get(id) || {}
      collectionStore(name).set(id, { ...clone(current), ...clone(data) })
      return { stats: { updated: 1 } }
    },
  }
}

function collection(name) {
  return { doc(id) { return reference(name, id) } }
}

const database = {
  collection,
  serverDate() { return { $serverDate: true } },
  async runTransaction(callback) { return callback({ collection }) },
}

const cloudStub = {
  DYNAMIC_CURRENT_ENV: 'dynamic-current-env',
  init() {},
  database() { return database },
  getWXContext() { return {} },
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
  exerciseNotes: '',
  exerciseByDay: [],
}

function put(name, id, value) { collectionStore(name).set(id, clone(value)) }
function get(name, id) { return clone(collectionStore(name).get(id)) }
function validTaskId(seed) { return generateTaskId(Buffer.alloc(32, seed)) }

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
    activePlan: planState.activePlan ? sanitizePlan(planState.activePlan, 'activePlan') : null,
    draftPlan: planState.draftPlan ? sanitizePlan(planState.draftPlan, 'draftPlan') : null,
    now: Date.now() - 1000,
  })
  task.generationEpoch = epoch
  return task
}

function legacyActiveTask(seed, epoch, status = 'queued') {
  const task = storedTask(owner, epoch, seed)
  delete task.planStateFingerprint
  task.taskSchemaVersion = 1
  task.status = status
  return task
}

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
  put('meal_members', owner, { status: 'active' })
  put('meal_members', otherOwner, { status: 'active' })
  put('meal_user_states', owner, defaults())
  put('meal_user_states', otherOwner, defaults())
}

const tests = []
function test(name, run) { tests.push({ name, run }) }

test('current returns null when there is no active task', async () => {
  reset()
  assert.strictEqual(await planner._test.readCurrentTask(owner), null)
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

test('planner version 4 does not silently resume an older generator task', async () => {
  reset()
  const task = storedTask(owner, 3, 19)
  task.plannerVersion = '2'
  put('meal_ai_tasks', task._id, planner._test.taskData(task))
  put('meal_ai_controls', owner, { owner, activeTaskId: task._id, generationEpoch: 3 })

  const outcome = await planner._test.claimWork(owner, task._id)
  assert.strictEqual(outcome.task.status, 'failed')
  assert.strictEqual(outcome.task.errorCode, 'AI_PLANNER_VERSION_UNSUPPORTED')
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, '')
})

test('completed meal-title context is stable by chunk index and excludes current retry chunk', () => {
  const task = createTask({
    taskId: validTaskId(27), owner,
    input: { ...input, mealTypes: ['breakfast', 'lunch', 'dinner'], doubleDinner: true },
    baseStateRevision: 0, stateRevision: 0, planId: 'plan-27',
    generatedAt: '2026-08-26T00:00:00.000Z', clientRequestId: String(27).padStart(32, '0'),
    contractVersion: CONTRACT_VERSION, plannerVersion: PLANNER_VERSION, now: Date.now() - 1000,
  })
  task.chunks[2].status = 'completed'
  task.chunks[2].result = { days: [{ meals: [{ title: '第三分片餐名' }] }] }
  task.chunks[0].status = 'completed'
  task.chunks[0].result = { days: [{ meals: [{ title: '第一分片餐名' }, { title: '第一分片第二餐' }] }] }
  task.chunks[1].status = 'running'
  task.chunks[1].result = { days: [{ meals: [{ title: '不得读取的当前旧结果' }] }] }

  assert.deepStrictEqual(planner._test.completedMealTitles(task, 2), ['第一分片餐名', '第一分片第二餐'])
  assert.deepStrictEqual(planner._test.completedMealTitles(task, 3), [
    '第一分片餐名', '第一分片第二餐', '第三分片餐名',
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
  assert.strictEqual(get('meal_ai_controls', owner).activeTaskId, '')
  assert.strictEqual(get('meal_ai_tasks', task._id).generationEpoch, 5)
})

test('start is idempotent for the same owner, request id, preferences, and state revision', async () => {
  reset()
  const clientRequestId = '0123456789abcdef0123456789abcdef'
  const first = await planner._test.startTask(owner, input, 0, clientRequestId)
  const replay = await planner._test.startTask(owner, input, 0, clientRequestId)
  assert.strictEqual(replay.task.taskId, first.task.taskId)
  assert.strictEqual(collectionStore('meal_ai_tasks').size, 1)
  assert.strictEqual(get('meal_ai_tasks', first.task.taskId).plannerVersion, '4')
  assert.strictEqual(get('meal_ai_tasks', first.task.taskId).chunks.every((chunk) => chunk.mealSlots <= 4), true)
  assert.strictEqual(get('meal_ai_controls', owner).rateCount, 1)
  await assert.rejects(
    planner._test.startTask(owner, { ...input, goals: ['提高蛋白质'] }, 0, clientRequestId),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT',
  )
  assert.strictEqual(collectionStore('meal_ai_tasks').size, 1)
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
  const replay = await planner._test.startTask(owner, input, 0, String(67).padStart(32, '0'))
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
  const preferences = { ...input, exerciseByDay: [exercise] }
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

test('advance awaits settlement rejection before routing the claim through failure settlement', async () => {
  reset()
  const task = storedTask(owner, 1, 11)
  const claim = { taskId: task._id, kind: 'finalize', index: -1, leaseToken: 'a'.repeat(43) }
  let failurePolicy = null
  const result = await planner._test.advanceTask(owner, task._id, { timeoutMs: 45000 }, {
    async claimWork() { return { task, claim } },
    async executeClaim() { return { generated: true } },
    async settleSuccess() { throw Object.assign(new Error('write failed'), { code: 'AI_UPSTREAM_FAILED' }) },
    async settleFailure(_openid, _taskId, _claim, _leaseToken, policy) {
      failurePolicy = policy
      return { task: { status: 'failed' }, result: null }
    },
  })
  assert.deepStrictEqual(failurePolicy, { code: 'AI_UPSTREAM_FAILED', retryable: true, retryAfterMs: 600 })
  assert.strictEqual(result.task.status, 'failed')
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
