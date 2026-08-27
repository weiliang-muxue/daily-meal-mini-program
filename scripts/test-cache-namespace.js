const assert = require('assert')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const cloudModulePath = path.join(projectRoot, 'miniprogram', 'utils', 'cloud.js')
const membershipModulePath = path.join(projectRoot, 'miniprogram', 'services', 'membership-store.js')
const authModulePath = path.join(projectRoot, 'miniprogram', 'services', 'auth-store.js')
const healthModulePath = path.join(projectRoot, 'miniprogram', 'services', 'health-store.js')
const userModulePath = path.join(projectRoot, 'miniprogram', 'services', 'user-store.js')

const namespaceA = 'a'.repeat(32)
const namespaceB = 'b'.repeat(32)
const storage = new Map()
const storageReads = []
const storageWrites = []
let cloudHandler = async () => { throw new Error('offline') }
let loginHandler = async () => ({ code: 'mock-login-code' })

global.wx = {
  getStorageSync(key) {
    storageReads.push(key)
    return storage.get(key)
  },
  setStorageSync(key, value) {
    storageWrites.push(key)
    storage.set(key, value)
  },
  removeStorageSync() {
    throw new Error('Tests must not delete another account cache')
  },
}

require.cache[cloudModulePath] = {
  id: cloudModulePath,
  filename: cloudModulePath,
  loaded: true,
  exports: {
    callFunction: (...args) => cloudHandler(...args),
    wxLogin: (...args) => loginHandler(...args),
  },
}

delete require.cache[membershipModulePath]
delete require.cache[authModulePath]
delete require.cache[healthModulePath]
delete require.cache[userModulePath]

const { MembershipStore } = require(membershipModulePath)
const { AuthStore } = require(authModulePath)
const { HealthStore } = require(healthModulePath)
const { UserStore, defaults } = require(userModulePath)

function userPlan(id, shoppingId) {
  return {
    id,
    planVersion: 1,
    contractVersion: 1,
    source: 'ai',
    title: `Plan ${id}`,
    durationDays: 7,
    startDate: '2026-09-01',
    generatedAt: '2026-08-26T00:00:00.000Z',
    generationBasis: { mealTypes: ['breakfast'], doubleDinner: false },
    rationale: ['Test'],
    days: Array.from({ length: 7 }, (_, index) => ({
      id: `${id}-day-${index + 1}`,
      date: `2026-09-${String(index + 1).padStart(2, '0')}`,
      short: String(index + 1),
      name: `Day ${index + 1}`,
      theme: 'Test',
      exercise: { dayIndex: index, planned: false },
      meals: [{
        id: `${id}-meal-${index + 1}`,
        type: 'breakfast',
        scenario: 'default',
        label: 'Breakfast',
        title: `Meal ${index + 1}`,
        ingredients: [{ name: 'Ingredient', quantity: 1, unit: 'item', category: '其他' }],
        method: 'Prepare',
        tag: 'Test',
      }],
    })),
    shoppingGroups: [{
      id: `${id}-shopping`,
      name: 'Food',
      items: [{ id: shoppingId, name: shoppingId, amount: '1 item' }],
    }],
  }
}

function stateWithPlan(activePlan, history = []) {
  return {
    ...defaults(),
    activePlan,
    activePlanId: activePlan.id,
    selectedDayId: activePlan.days[0].id,
    planHistory: history,
  }
}

class FakeMembershipStore {
  constructor(namespace = '') {
    this.cacheNamespace = namespace
    this.listeners = new Set()
  }

  onCacheNamespaceChange(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  switchTo(namespace) {
    const previous = this.cacheNamespace
    this.cacheNamespace = namespace
    this.listeners.forEach((listener) => listener(namespace, previous))
  }
}

async function expectReject(promise, pattern) {
  let error
  try { await promise } catch (caught) { error = caught }
  assert(error, 'Expected promise to reject')
  assert(pattern.test(error.message), `Unexpected error: ${error.message}`)
}

async function testColdStartRequiresOnlineStatus() {
  storage.set('meal_membership_v1', { status: 'active', cacheNamespace: namespaceA })
  storageReads.length = 0
  storageWrites.length = 0
  loginHandler = async () => { throw new Error('network unavailable') }

  const store = new MembershipStore()
  await expectReject(store.init(), /network unavailable/)
  assert.strictEqual(store.member, null)
  assert.strictEqual(store.cacheNamespace, '')
  assert.deepStrictEqual(storageReads, [], 'Cold start must not read a fixed membership cache')
  assert.deepStrictEqual(storageWrites, [], 'Cold start must not write membership identity locally')

  let statusCalls = 0
  loginHandler = async () => ({ code: 'mock-login-code' })
  cloudHandler = async (name, action) => {
    assert.strictEqual(name, 'membership')
    assert.strictEqual(action, 'status')
    statusCalls += 1
    return { status: 'active', role: 'member', cacheNamespace: namespaceA }
  }
  const member = await store.init()
  assert.strictEqual(member.cacheNamespace, namespaceA)
  assert.strictEqual(statusCalls, 1)
  await store.init()
  assert.strictEqual(statusCalls, 1, 'A verified identity may be reused during the same runtime')

  cloudHandler = async () => { throw new Error('offline after verification') }
  const offlineMember = await store.init({ force: true })
  assert.strictEqual(offlineMember.cacheNamespace, namespaceA)
  assert.strictEqual(store.state, 'offline')
}

async function testLatestIdentityResponseWins() {
  const store = new MembershipStore()
  const pending = []
  loginHandler = async () => ({ code: 'mock-login-code' })
  cloudHandler = () => new Promise((resolve) => pending.push(resolve))

  const first = store.init({ force: true })
  await new Promise((resolve) => setImmediate(resolve))
  const second = store.init({ force: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.strictEqual(pending.length, 2)

  pending[1]({ status: 'active', role: 'member', cacheNamespace: namespaceB })
  assert.strictEqual((await second).cacheNamespace, namespaceB)
  pending[0]({ status: 'active', role: 'member', cacheNamespace: namespaceA })
  await expectReject(first, /结果已过期/)
  assert.strictEqual(store.cacheNamespace, namespaceB)
  assert.strictEqual(store.member.cacheNamespace, namespaceB)
}

async function testResetInvalidatesIdentityResponse() {
  const store = new MembershipStore()
  const namespaceChanges = []
  store.save({ status: 'active', role: 'member', cacheNamespace: namespaceA })
  store.onCacheNamespaceChange((next, previous) => namespaceChanges.push([next, previous]))
  let resolveRequest
  loginHandler = async () => ({ code: 'mock-login-code' })
  cloudHandler = () => new Promise((resolve) => { resolveRequest = resolve })

  const request = store.init({ force: true })
  await new Promise((resolve) => setImmediate(resolve))
  store.reset()
  resolveRequest({ status: 'active', role: 'member', cacheNamespace: namespaceB })
  await expectReject(request, /结果已过期/)
  assert.strictEqual(store.member, null)
  assert.strictEqual(store.cacheNamespace, '')
  assert.strictEqual(store.verifiedInRuntime, false)
  assert.deepStrictEqual(namespaceChanges, [['', namespaceA]])
}

async function testAuthCachesAreNamespaced() {
  const keyA = `meal_auth_profile_v1_${namespaceA}`
  const keyB = `meal_auth_profile_v1_${namespaceB}`
  storage.set('meal_auth_profile_v1', { nickname: 'legacy-global-profile' })
  storage.set(keyA, { nickname: 'account-a' })
  storage.set(keyB, { nickname: 'account-b' })
  storageReads.length = 0
  storageWrites.length = 0
  loginHandler = async () => ({ code: 'mock-login-code' })
  cloudHandler = async () => { throw new Error('offline') }

  const memberStore = new FakeMembershipStore(namespaceA)
  const store = new AuthStore(memberStore)
  assert.deepStrictEqual(await store.init(), { nickname: 'account-a' })
  assert.strictEqual(store.profile.nickname, 'account-a')

  memberStore.switchTo(namespaceB)
  assert.strictEqual(store.profile, null, 'Namespace change must clear the profile in memory immediately')
  assert.deepStrictEqual(await store.init(), { nickname: 'account-b' })
  assert.strictEqual(store.profile.nickname, 'account-b')
  assert(storageReads.includes(keyA))
  assert(storageReads.includes(keyB))
  assert.strictEqual(storageReads.includes('meal_auth_profile_v1'), false, 'Legacy global auth cache must not be read')

  cloudHandler = async (name, action) => {
    assert.strictEqual(name, 'auth')
    assert.strictEqual(action, 'updateProfile')
    return { nickname: 'account-b-updated' }
  }
  await store.updateProfile({ nickname: 'ignored-by-mock' })
  assert.deepStrictEqual(storage.get(keyB), { nickname: 'account-b-updated' })
  assert.deepStrictEqual(storage.get(keyA), { nickname: 'account-a' }, 'Account A cache must remain untouched')

  const readsBeforeMissingNamespace = storageReads.length
  const writesBeforeMissingNamespace = storageWrites.length
  memberStore.switchTo('')
  assert.strictEqual(store.profile, null)
  await expectReject(store.init(), /先联网确认微信身份/)
  assert.strictEqual(storageReads.length, readsBeforeMissingNamespace)
  assert.strictEqual(storageWrites.length, writesBeforeMissingNamespace)
}

async function testStaleAuthRequestCannotCrossNamespace() {
  const memberStore = new FakeMembershipStore(namespaceA)
  const store = new AuthStore(memberStore)
  let resolveRequest
  loginHandler = async () => ({ code: 'mock-login-code' })
  cloudHandler = () => new Promise((resolve) => { resolveRequest = resolve })

  const keyB = `meal_auth_profile_v1_${namespaceB}`
  const before = storage.get(keyB)
  const writesBefore = storageWrites.filter((key) => key === keyB).length
  const request = store.init({ force: true })
  await new Promise((resolve) => setImmediate(resolve))
  memberStore.switchTo(namespaceB)
  resolveRequest({ nickname: 'stale-account-a-profile' })
  await expectReject(request, /身份已变化/)
  assert.strictEqual(store.profile, null)
  assert.deepStrictEqual(storage.get(keyB), before)
  assert.strictEqual(storageWrites.filter((key) => key === keyB).length, writesBefore)
}

async function testHealthCachesAreNamespaced() {
  const month = '2026-08'
  const emptyMonth = '2026-11'
  const keyA = `meal_health_month_v1_${namespaceA}_${month}`
  const keyB = `meal_health_month_v1_${namespaceB}_${month}`
  storage.set(`meal_health_month_v1_${month}`, [{ date: '2026-08-03', note: 'legacy-global-health' }])
  storage.set(keyA, [{ date: '2026-08-01', note: 'account-a' }])
  storage.set(`meal_health_month_v1_${namespaceA}_${emptyMonth}`, [])
  storage.set(keyB, [{ date: '2026-08-02', note: 'account-b' }])
  storageReads.length = 0
  storageWrites.length = 0
  cloudHandler = async () => { throw new Error('offline') }

  const memberStore = new FakeMembershipStore(namespaceA)
  const store = new HealthStore(memberStore)
  assert.strictEqual(store.hasCachedMonth(month), true, '已有本机月份快照必须可识别')
  assert.strictEqual(store.hasCachedMonth(emptyMonth), true, '明确缓存过的空月份也必须视为有效快照')
  assert.strictEqual(store.hasCachedMonth('2026-10'), false, '从未缓存的月份不能伪装成合法空月份')
  assert.deepStrictEqual(await store.getMonth(month), [{ date: '2026-08-01', note: 'account-a', recordRevision: 0 }],
    '旧缓存没有 recordRevision 时必须兼容为 0')

  memberStore.switchTo(namespaceB)
  assert.deepStrictEqual(store.months, {}, 'Namespace change must clear health records in memory immediately')
  assert.deepStrictEqual(await store.getMonth(month), [{ date: '2026-08-02', note: 'account-b', recordRevision: 0 }])
  assert(storageReads.includes(keyA))
  assert(storageReads.includes(keyB))
  assert.strictEqual(storageReads.includes(`meal_health_month_v1_${month}`), false, 'Legacy global health cache must not be read')
  assert.deepStrictEqual(storage.get(keyA), [{ date: '2026-08-01', note: 'account-a' }])
  assert.deepStrictEqual(storage.get(keyB), [{ date: '2026-08-02', note: 'account-b' }])

  cloudHandler = async (name, action, payload) => {
    assert.strictEqual(name, 'health')
    assert.strictEqual(action, 'saveDaily')
    assert.strictEqual(payload.record.expectedRecordRevision, 0)
    return { date: '2026-08-04', note: 'account-b-new', recordRevision: 1, photoUrl: 'temporary-url' }
  }
  await store.saveDaily({ date: '2026-08-04', expectedRecordRevision: 0 })
  assert.deepStrictEqual(storage.get(keyA), [{ date: '2026-08-01', note: 'account-a' }], 'Account A health cache must remain untouched')
  assert.deepStrictEqual(storage.get(keyB), [
    { date: '2026-08-02', note: 'account-b', recordRevision: 0, photoUrl: '' },
    { date: '2026-08-04', note: 'account-b-new', recordRevision: 1, photoUrl: '' },
  ])

  let conflictSaveCalls = 0
  cloudHandler = async (_name, action) => {
    assert.strictEqual(action, 'saveDaily')
    conflictSaveCalls += 1
    const error = new Error('这一天已在其他设备更新，请刷新后重新确认')
    error.code = 'HEALTH_RECORD_REVISION_CONFLICT'
    throw error
  }
  await assert.rejects(
    () => store.saveDaily({ date: '2026-08-02', note: '旧设备备注', expectedRecordRevision: 0 }),
    (error) => error.code === 'HEALTH_RECORD_REVISION_CONFLICT',
  )
  assert.strictEqual(conflictSaveCalls, 1, '健康记录冲突不得由 Store 自动重试覆盖')
  assert.strictEqual(store.state, 'conflict')
  assert.strictEqual(store.months[month].find((item) => item.date === '2026-08-02').note, 'account-b',
    '冲突响应不能修改本地月份快照')

  const readsBeforeMissingNamespace = storageReads.length
  const writesBeforeMissingNamespace = storageWrites.length
  memberStore.switchTo('')
  await expectReject(store.getMonth(month), /先联网确认微信身份/)
  assert.strictEqual(storageReads.length, readsBeforeMissingNamespace)
  assert.strictEqual(storageWrites.length, writesBeforeMissingNamespace)
}

async function testStaleRequestCannotCrossNamespace() {
  const memberStore = new FakeMembershipStore(namespaceA)
  const store = new HealthStore(memberStore)
  let resolveRequest
  cloudHandler = () => new Promise((resolve) => { resolveRequest = resolve })

  const request = store.getMonth('2026-09')
  memberStore.switchTo(namespaceB)
  resolveRequest([{ date: '2026-09-01', note: 'stale-account-a-response' }])
  assert.deepStrictEqual(await request, [])
  assert.deepStrictEqual(store.months, {})
  assert.strictEqual(storage.has(`meal_health_month_v1_${namespaceB}_2026-09`), false)
}

async function testPlanCachesAreNamespaced() {
  const keyA = `meal_user_state_v3_${namespaceA}`
  const keyB = `meal_user_state_v3_${namespaceB}`
  storage.set('meal_user_state_v2', { selectedDay: 6 })
  storage.set(keyA, { ...defaults(), selectedDay: 1 })
  storage.set(keyB, { ...defaults(), selectedDay: 4 })
  storageReads.length = 0
  storageWrites.length = 0

  const memberStore = new FakeMembershipStore(namespaceA)
  const store = new UserStore(memberStore)
  store.bindNamespace()
  assert.strictEqual(store.data.selectedDay, 1)
  assert.strictEqual(storageReads.includes('meal_user_state_v2'), false, 'Legacy global plan cache must not be read')

  memberStore.switchTo(namespaceB)
  assert.strictEqual(store.state, 'idle')
  assert.strictEqual(store.data.selectedDay, defaults().selectedDay, 'Namespace change must clear plan state in memory immediately')
  store.bindNamespace()
  assert.strictEqual(store.data.selectedDay, 4)
  assert(storageReads.includes(keyA))
  assert(storageReads.includes(keyB))

  await store.patch({ selectedDay: 5 }, { localOnly: true })
  assert.strictEqual(storage.get(keyB).selectedDay, 5)
  assert.strictEqual(storage.get(keyA).selectedDay, 1, 'Account A plan cache must remain untouched')

  const readsBeforeMissingNamespace = storageReads.length
  const writesBeforeMissingNamespace = storageWrites.length
  memberStore.switchTo('')
  await expectReject(store.patch({ selectedDay: 2 }, { localOnly: true }), /先在线确认微信身份/)
  assert.strictEqual(storageReads.length, readsBeforeMissingNamespace)
  assert.strictEqual(storageWrites.length, writesBeforeMissingNamespace)
}

async function testStalePlanRequestCannotCrossNamespace() {
  const memberStore = new FakeMembershipStore(namespaceA)
  const store = new UserStore(memberStore)
  let resolveRequest
  cloudHandler = () => new Promise((resolve) => { resolveRequest = resolve })

  const keyB = `meal_user_state_v3_${namespaceB}`
  const before = storage.get(keyB)
  const writesBefore = storageWrites.filter((key) => key === keyB).length
  const request = store.init({ force: true })
  memberStore.switchTo(namespaceB)
  resolveRequest({ ...defaults(), selectedDay: 3 })
  await expectReject(request, /身份已变化/)
  assert.strictEqual(store.data.selectedDay, defaults().selectedDay)
  assert.deepStrictEqual(storage.get(keyB), before)
  assert.strictEqual(storageWrites.filter((key) => key === keyB).length, writesBefore)
}

async function testStalePlanSaveCannotCrossNamespace() {
  const memberStore = new FakeMembershipStore(namespaceA)
  const store = new UserStore(memberStore)
  store.bindNamespace()
  await store.patch({ selectedDay: 2 }, { localOnly: true })
  let resolveRequest
  cloudHandler = () => new Promise((resolve) => { resolveRequest = resolve })

  const keyB = `meal_user_state_v3_${namespaceB}`
  const before = storage.get(keyB)
  const writesBefore = storageWrites.filter((key) => key === keyB).length
  const request = store.flush()
  memberStore.switchTo(namespaceB)
  resolveRequest({ ...defaults(), selectedDay: 2 })
  await expectReject(request, /身份已变化/)
  assert.strictEqual(store.state, 'idle')
  assert.deepStrictEqual(storage.get(keyB), before)
  assert.strictEqual(storageWrites.filter((key) => key === keyB).length, writesBefore)
}

async function testImmediateSaveWaitsForItsOwnRevision() {
  const key = `meal_user_state_v3_${namespaceA}`
  storage.set(key, { ...defaults(), stateRevision: 0, selectedDay: 0 })
  storage.delete(`meal_user_pending_v1_${namespaceA}`)
  const memberStore = new FakeMembershipStore(namespaceA)
  const store = new UserStore(memberStore)
  store.bindNamespace()

  const saves = []
  cloudHandler = (name, action, payload) => {
    assert.strictEqual(name, 'userData')
    assert.strictEqual(action, 'saveState')
    return new Promise((resolve) => saves.push({ payload, resolve }))
  }

  await store.patch({ selectedDay: 1 }, { localOnly: true })
  const first = store.flush()
  await new Promise((resolve) => setImmediate(resolve))
  assert.strictEqual(saves.length, 1)
  assert.strictEqual(saves[0].payload.state.selectedDay, 1)

  let immediateSettled = false
  const immediate = store.patch({ defaultDinnerMode: 'workout' }, { immediate: true })
    .then((value) => { immediateSettled = true; return value })
  saves[0].resolve({ ...defaults(), stateRevision: 1, selectedDay: 1 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.strictEqual(immediateSettled, false, 'Immediate save must wait for the revision created by its own patch')
  assert.strictEqual(saves.length, 2)
  assert.strictEqual(saves[1].payload.expectedStateRevision, 1)
  assert.strictEqual(saves[1].payload.state.defaultDinnerMode, 'workout')

  saves[1].resolve({ ...defaults(), stateRevision: 2, selectedDay: 1, defaultDinnerMode: 'workout' })
  const saved = await immediate
  await first
  assert.strictEqual(saved.stateRevision, 2)
  assert.strictEqual(store.confirmedLocalRevision, 2)
}

async function testColdStartReplaysPersistedShoppingOperations() {
  const key = `meal_user_state_v3_${namespaceA}`
  const pendingKey = `meal_user_pending_v1_${namespaceA}`
  storage.set(key, { ...defaults(), stateRevision: 2, checkedShoppingIds: ['cloud-item'] })
  storage.set(pendingKey, {
    version: 1,
    revision: 7,
    fields: {},
    fieldRevisions: {},
    checkedOperations: {
      'cloud-item': { checked: false, revision: 6 },
      'offline-item': { checked: true, revision: 7 },
    },
  })
  const memberStore = new FakeMembershipStore(namespaceA)
  const store = new UserStore(memberStore)
  store.bindNamespace()
  assert.deepStrictEqual(store.data.checkedShoppingIds, ['offline-item'])

  const calls = []
  cloudHandler = async (name, action, payload) => {
    calls.push({ name, action, payload })
    if (action === 'bootstrap') return { ...defaults(), stateRevision: 3, checkedShoppingIds: ['cloud-item', 'other-device-item'] }
    assert.strictEqual(action, 'saveState')
    assert.deepStrictEqual(new Set(payload.state.checkedShoppingIds), new Set(['other-device-item', 'offline-item']))
    return { ...defaults(), stateRevision: 4, checkedShoppingIds: payload.state.checkedShoppingIds }
  }

  const state = await store.init({ force: true })
  assert.strictEqual(state.stateRevision, 4)
  assert.deepStrictEqual(new Set(state.checkedShoppingIds), new Set(['other-device-item', 'offline-item']))
  assert.strictEqual(calls.filter((item) => item.action === 'saveState').length, 1)
  assert.deepStrictEqual(storage.get(pendingKey).planUiByPlan, {})
  assert.deepStrictEqual(storage.get(pendingKey).unscopedPlanUi.checkedOperations, {})
}

async function testPlanScopedPendingDoesNotMoveAcrossConflict() {
  const key = `meal_user_state_v3_${namespaceA}`
  const pendingStorageKey = `meal_user_pending_v1_${namespaceA}`
  const planA = userPlan('plan-a', 'item-a')
  const planB = userPlan('plan-b', 'item-b')
  storage.set(key, { ...stateWithPlan(planA, [planB]), stateRevision: 2 })
  storage.delete(pendingStorageKey)
  const memberStore = new FakeMembershipStore(namespaceA)
  const store = new UserStore(memberStore)
  store.bindNamespace()
  await store.patch({
    dinnerModeByDay: { [planA.days[1].id]: 'workout' },
    checkedShoppingIds: ['item-a'],
  }, { localOnly: true })

  let saveCount = 0
  const cloudPlanB = {
    ...stateWithPlan(planB, [planA]),
    stateRevision: 3,
    checkedShoppingIds: [],
  }
  cloudHandler = async (_name, action, payload) => {
    if (action === 'bootstrap') return cloudPlanB
    saveCount += 1
    if (saveCount === 1) {
      const error = new Error('state changed')
      error.code = 'STATE_REVISION_CONFLICT'
      throw error
    }
    assert.strictEqual(payload.state.checkedShoppingIds.length, 0,
      'plan A shopping operations must not be replayed onto active plan B')
    assert.deepStrictEqual(payload.state.dinnerModeByDay, {},
      'plan A dinner choices must not be replayed onto active plan B')
    assert.deepStrictEqual(payload.state.planUiStateByPlan['plan-a'].checkedShoppingIds, ['item-a'])
    assert.strictEqual(payload.state.planUiStateByPlan['plan-a'].dinnerModeByDay[planA.days[1].id], 'workout')
    return { ...cloudPlanB, stateRevision: 4, planUiStateByPlan: payload.state.planUiStateByPlan }
  }

  const saved = await store.flush()
  assert.strictEqual(saved.activePlan.id, 'plan-b')
  assert.deepStrictEqual(saved.checkedShoppingIds, [])
  assert.deepStrictEqual(saved.planUiStateByPlan['plan-a'].checkedShoppingIds, ['item-a'])
  assert.strictEqual(saved.planUiStateByPlan['plan-a'].dinnerModeByDay[planA.days[1].id], 'workout')
  assert.deepStrictEqual(storage.get(pendingStorageKey).planUiByPlan, {})
}

async function testLegacyFlatPendingMigratesToCachedPlan() {
  const key = `meal_user_state_v3_${namespaceA}`
  const pendingStorageKey = `meal_user_pending_v1_${namespaceA}`
  const planA = userPlan('legacy-pending-a', 'legacy-item-a')
  const planB = userPlan('legacy-pending-b', 'legacy-item-b')
  storage.set(key, { ...stateWithPlan(planA, [planB]), stateRevision: 6 })
  storage.set(pendingStorageKey, {
    version: 1,
    revision: 8,
    fields: { dinnerModeByDay: { [planA.days[2].id]: 'workout' } },
    fieldRevisions: { dinnerModeByDay: 7 },
    checkedOperations: { 'legacy-item-a': { checked: true, revision: 8 } },
  })
  const store = new UserStore(new FakeMembershipStore(namespaceA))
  store.bindNamespace()
  assert.deepStrictEqual(store.data.checkedShoppingIds, ['legacy-item-a'])

  const cloudPlanB = { ...stateWithPlan(planB, [planA]), stateRevision: 7 }
  let savedPayload
  cloudHandler = async (_name, action, payload) => {
    if (action === 'bootstrap') return cloudPlanB
    savedPayload = payload
    return { ...cloudPlanB, stateRevision: 8, planUiStateByPlan: payload.state.planUiStateByPlan }
  }
  const saved = await store.init({ force: true })
  assert.deepStrictEqual(saved.checkedShoppingIds, [])
  assert.deepStrictEqual(savedPayload.state.checkedShoppingIds, [])
  assert.deepStrictEqual(saved.planUiStateByPlan['legacy-pending-a'].checkedShoppingIds, ['legacy-item-a'])
  assert.strictEqual(saved.planUiStateByPlan['legacy-pending-a'].dinnerModeByDay[planA.days[2].id], 'workout')
}

async function testRevisionConflictRebasesPendingChangesOnce() {
  const key = `meal_user_state_v3_${namespaceA}`
  storage.set(key, { ...defaults(), stateRevision: 2, selectedDay: 0, defaultDinnerMode: 'rest' })
  storage.delete(`meal_user_pending_v1_${namespaceA}`)
  const memberStore = new FakeMembershipStore(namespaceA)
  const store = new UserStore(memberStore)
  store.bindNamespace()
  await store.patch({ selectedDay: 2 }, { localOnly: true })

  let saveCount = 0
  cloudHandler = async (_name, action, payload) => {
    if (action === 'bootstrap') {
      return { ...defaults(), stateRevision: 5, selectedDay: 4, defaultDinnerMode: 'workout' }
    }
    saveCount += 1
    if (saveCount === 1) {
      const error = new Error('another device changed the state')
      error.code = 'STATE_REVISION_CONFLICT'
      throw error
    }
    assert.strictEqual(payload.expectedStateRevision, 5)
    assert.strictEqual(payload.state.selectedDay, 2)
    assert.strictEqual(payload.state.defaultDinnerMode, 'workout')
    return { ...defaults(), stateRevision: 6, selectedDay: 2, defaultDinnerMode: 'workout' }
  }

  const saved = await store.flush()
  assert.strictEqual(saveCount, 2)
  assert.strictEqual(saved.stateRevision, 6)
  assert.strictEqual(saved.selectedDay, 2)
  assert.strictEqual(saved.defaultDinnerMode, 'workout')
}

async function testLateBootstrapCannotRollBackSuccessfulSave() {
  const key = `meal_user_state_v3_${namespaceA}`
  storage.set(key, { ...defaults(), stateRevision: 5, selectedDay: 0 })
  storage.delete(`meal_user_pending_v1_${namespaceA}`)
  const memberStore = new FakeMembershipStore(namespaceA)
  const store = new UserStore(memberStore)
  store.bindNamespace()
  let resolveBootstrap
  cloudHandler = async (_name, action, payload) => {
    if (action === 'bootstrap') return new Promise((resolve) => { resolveBootstrap = resolve })
    assert.strictEqual(payload.expectedStateRevision, 5)
    return { ...defaults(), stateRevision: 6, selectedDay: 1 }
  }

  const loading = store.init({ force: true })
  await new Promise((resolve) => setImmediate(resolve))
  const saved = await store.patch({ selectedDay: 1 }, { immediate: true })
  assert.strictEqual(saved.stateRevision, 6)
  resolveBootstrap({ ...defaults(), stateRevision: 5, selectedDay: 0 })
  await loading
  assert.strictEqual(store.data.stateRevision, 6)
  assert.strictEqual(store.data.selectedDay, 1)
  assert.strictEqual(storage.get(key).stateRevision, 6)
}

async function main() {
  await testColdStartRequiresOnlineStatus()
  await testLatestIdentityResponseWins()
  await testResetInvalidatesIdentityResponse()
  await testAuthCachesAreNamespaced()
  await testStaleAuthRequestCannotCrossNamespace()
  await testHealthCachesAreNamespaced()
  await testStaleRequestCannotCrossNamespace()
  await testPlanCachesAreNamespaced()
  await testStalePlanRequestCannotCrossNamespace()
  await testStalePlanSaveCannotCrossNamespace()
  await testImmediateSaveWaitsForItsOwnRevision()
  await testColdStartReplaysPersistedShoppingOperations()
  await testPlanScopedPendingDoesNotMoveAcrossConflict()
  await testLegacyFlatPendingMigratesToCachedPlan()
  await testRevisionConflictRebasesPendingChangesOnce()
  await testLateBootstrapCannotRollBackSuccessfulSave()
  console.log('cache namespace tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
