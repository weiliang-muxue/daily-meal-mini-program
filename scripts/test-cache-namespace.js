const assert = require('assert')
const fs = require('fs')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const cloudModulePath = path.join(projectRoot, 'miniprogram', 'utils', 'cloud.js')
const membershipModulePath = path.join(projectRoot, 'miniprogram', 'services', 'membership-store.js')
const authModulePath = path.join(projectRoot, 'miniprogram', 'services', 'auth-store.js')
const healthModulePath = path.join(projectRoot, 'miniprogram', 'services', 'health-store.js')
const userModulePath = path.join(projectRoot, 'miniprogram', 'services', 'user-store.js')

const namespaceA = 'a'.repeat(32)
const namespaceB = 'b'.repeat(32)
const namespaceC = 'c'.repeat(32)
const storage = new Map()
const storageReads = []
const storageWrites = []
const storageRemovals = []
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
  getStorageInfoSync() { return { keys: [...storage.keys()] } },
  removeStorageSync(key) {
    storageRemovals.push(key)
    storage.delete(key)
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

const { MembershipStore, deletionRecoveryState } = require(membershipModulePath)
const { AuthStore } = require(authModulePath)
const { HealthStore } = require(healthModulePath)
const { UserStore, defaults } = require(userModulePath)

function userPlan(id, shoppingId, durationDays = 7) {
  return {
    id,
    planVersion: 1,
    contractVersion: 1,
    source: 'ai',
    title: `Plan ${id}`,
    durationDays,
    startDate: '2026-09-01',
    generatedAt: '2026-08-26T00:00:00.000Z',
    generationBasis: { mealTypes: ['breakfast'], doubleDinner: false },
    rationale: ['Test'],
    days: Array.from({ length: durationDays }, (_, index) => ({
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

async function testVerifiedIdentityReconcilesOnlyStalePrivateCaches() {
  storage.clear()
  storageRemovals.length = 0
  const currentKey = `meal_user_state_v3_${namespaceB}`
  const staleKeys = [
    'meal_membership_v1',
    'meal_auth_profile_v1',
    'meal_user_state_v2',
    'meal_health_month_v1_2026-08',
    `meal_auth_profile_v1_${namespaceA}`,
    `meal_user_pending_v1_${namespaceA}`,
    `meal_ai_task_v2_${namespaceA}`,
    `meal_health_month_v1_${namespaceA}_2026-08`,
  ]
  staleKeys.forEach((key) => storage.set(key, { private: true }))
  storage.set(currentKey, { selectedDay: 2 })
  storage.set('unrelated-setting', { retained: true })
  storage.set('meal_health_month_v1_not-a-month', { retained: true })
  loginHandler = async () => ({ code: 'mock-login-code' })
  cloudHandler = async () => ({ status: 'active', role: 'member', cacheNamespace: namespaceB })

  const store = new MembershipStore()
  await store.init()

  assert.deepStrictEqual(new Set(storageRemovals), new Set(staleKeys))
  assert.strictEqual(storage.has(currentKey), true, '当前在线确认的 namespace 缓存必须保留')
  assert.strictEqual(storage.has('unrelated-setting'), true, '非本项目键不得删除')
  assert.strictEqual(storage.has('meal_health_month_v1_not-a-month'), true, '不匹配的项目样式键也不得猜测删除')

  storageRemovals.length = 0
  cloudHandler = async () => ({ status: 'invite_required', cacheNamespace: '' })
  await store.init({ force: true })
  assert.deepStrictEqual(storageRemovals, [currentKey],
    '在线确认 invite_required 时必须清除本机所有旧私人 namespace 缓存')
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

function testDeletionRecoveryClassification() {
  assert.strictEqual(deletionRecoveryState({
    status: 'deleting', cacheNamespace: namespaceA,
  }, namespaceA), 'pending')
  assert.strictEqual(deletionRecoveryState({
    status: 'invite_required', cacheNamespace: '',
  }, namespaceA), 'completed')
  assert.strictEqual(deletionRecoveryState({
    status: 'active', cacheNamespace: namespaceB,
  }, namespaceA), 'completed')
  assert.strictEqual(deletionRecoveryState({
    status: 'active', cacheNamespace: namespaceA,
  }, namespaceA), 'unknown')
  assert.strictEqual(deletionRecoveryState({
    status: 'deleting', cacheNamespace: namespaceB,
  }, namespaceA), 'unknown')
  assert.strictEqual(deletionRecoveryState(null, namespaceA), 'unknown')
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

  cloudHandler = async (name, action, payload) => {
    assert.strictEqual(name, 'auth')
    assert.strictEqual(action, 'bindPhoneNumber')
    assert.strictEqual(payload.code, 'single-use-test-code')
    return { nickname: 'account-b-updated', phoneBound: true, maskedPhone: '****8000' }
  }
  await store.bindPhoneNumber('single-use-test-code')
  assert.deepStrictEqual(storage.get(keyB), {
    nickname: 'account-b-updated', phoneBound: true, maskedPhone: '****8000',
  })
  assert.strictEqual(JSON.stringify(storage.get(keyB)).includes('single-use-test-code'), false,
    '手机号动态 code 不得进入本地资料缓存')
  assert.deepStrictEqual(storage.get(keyA), { nickname: 'account-a' }, '绑定手机号不能覆盖其他账号缓存')

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

  cloudHandler = async (name, action) => {
    assert.strictEqual(name, 'health')
    assert.strictEqual(action, 'getMonth')
    return [{
      date: '2026-08-05', recordRevision: 4, empty: true,
      note: '不得保留的 tombstone 正文', photoFileId: 'cloud://private/stale-photo',
    }]
  }
  const emptyMarkers = await store.getMonth(month)
  assert.deepStrictEqual(emptyMarkers, [{ date: '2026-08-05', recordRevision: 4, empty: true }],
    '空态标记进入客户端前必须丢弃体重、照片、运动、备注等正文')
  assert.deepStrictEqual(storage.get(keyB), emptyMarkers,
    '本地月份缓存只能保存最小空态版本标记')

  let rebuiltRevision = null
  cloudHandler = async (name, action, payload) => {
    assert.strictEqual(name, 'health')
    assert.strictEqual(action, 'saveDaily')
    rebuiltRevision = payload.record.expectedRecordRevision
    return { date: '2026-08-05', recordRevision: 5, note: '安全重建' }
  }
  await store.saveDaily({ date: '2026-08-05', expectedRecordRevision: 4, note: '安全重建' })
  assert.strictEqual(rebuiltRevision, 4, '客户端必须使用当前空态版本重建，不能退回 revision 0')

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
  assert.deepStrictEqual(store.months[month], [
    { date: '2026-08-05', recordRevision: 5, note: '安全重建' },
  ], '冲突响应不能修改当前月份快照')

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

async function testGenerationIsSentWithEveryDataRequest() {
  const healthCalls = []
  const healthStore = new HealthStore(new FakeMembershipStore(namespaceC))
  cloudHandler = async (name, action, payload) => {
    assert.strictEqual(name, 'health')
    healthCalls.push({ action, payload })
    if (action === 'saveDaily') {
      return { date: '2026-12-01', note: 'saved', recordRevision: 1 }
    }
    return []
  }
  await healthStore.getMonth('2026-12')
  await healthStore.getRange('2026-12-01', '2026-12-07')
  await healthStore.saveDaily({ date: '2026-12-01', expectedRecordRevision: 0, note: 'saved' })
  assert.deepStrictEqual(healthCalls.map((call) => call.action), ['getMonth', 'getRange', 'saveDaily'])
  healthCalls.forEach(({ action, payload }) => {
    assert.strictEqual(payload.expectedCacheNamespace, namespaceC,
      `${action} 必须携带调用开始时的 expectedCacheNamespace`)
  })

  const userCalls = []
  const userStore = new UserStore(new FakeMembershipStore(namespaceC))
  let revision = 0
  cloudHandler = async (name, action, payload) => {
    assert.strictEqual(name, 'userData')
    userCalls.push({ action, payload })
    if (action === 'bootstrap') return { ...defaults(), stateRevision: revision }
    revision += 1
    return { ...defaults(), stateRevision: revision, selectedDay: 1 }
  }
  await userStore.init({ force: true })
  await userStore.patch({ selectedDay: 1 }, { localOnly: true })
  await userStore.flush()
  await userStore.confirmDraft('draft-plan')
  await userStore.discardDraft('draft-plan')
  await userStore.restoreHistory('history-plan')
  assert.deepStrictEqual(userCalls.map((call) => call.action), [
    'bootstrap', 'saveState', 'confirmDraft', 'discardDraft', 'restoreHistory',
  ])
  userCalls.forEach(({ action, payload }) => {
    assert.strictEqual(payload.expectedCacheNamespace, namespaceC,
      `${action} 必须携带调用开始时的 expectedCacheNamespace`)
  })
  assert.strictEqual(userCalls.find((call) => call.action === 'confirmDraft').payload.expectedDraftPlanId, 'draft-plan')
  assert.strictEqual(userCalls.find((call) => call.action === 'discardDraft').payload.expectedDraftPlanId, 'draft-plan')
}

async function testPreferenceOnlyCacheRestoresOfflineWithoutTreatingDefaultsAsCache() {
  const key = `meal_user_state_v3_${namespaceC}`
  const pendingKey = `meal_user_pending_v1_${namespaceC}`
  storage.set(key, {
    ...defaults(),
    generationPreferences: {
      ...defaults().generationPreferences,
      durationDays: 3,
      mealTypes: ['breakfast', 'dinner'],
      goals: ['保留离线选择'],
    },
  })
  storage.delete(pendingKey)
  cloudHandler = async () => { throw new Error('offline preference bootstrap') }

  const cachedStore = new UserStore(new FakeMembershipStore(namespaceC))
  const restored = await cachedStore.init({ force: true })
  assert.strictEqual(cachedStore.state, 'offline')
  assert.strictEqual(restored.activePlan, null)
  assert.strictEqual(restored.draftPlan, null)
  assert.strictEqual(restored.generationPreferences.durationDays, 3)
  assert.deepStrictEqual(restored.generationPreferences.mealTypes, ['breakfast', 'dinner'])
  assert.deepStrictEqual(restored.generationPreferences.goals, ['保留离线选择'])

  storage.delete(key)
  storage.delete(pendingKey)
  const emptyStore = new UserStore(new FakeMembershipStore(namespaceC))
  await assert.rejects(emptyStore.init({ force: true }), /offline preference bootstrap/)
  assert.strictEqual(emptyStore.state, 'error', '规范化生成的默认空对象不能冒充真实命名空间缓存')
}

async function testHealthRangeFallsBackToCompleteOrPartialMonthCaches() {
  const augustKey = `meal_health_month_v1_${namespaceC}_2026-08`
  const septemberKey = `meal_health_month_v1_${namespaceC}_2026-09`
  storage.set(augustKey, [
    { date: '2026-08-20', weight: 70 },
    { date: '2026-08-31', weight: 69.5 },
    { date: '2026-08-30', recordRevision: 8, empty: true },
  ])
  storage.set(septemberKey, [
    { date: '2026-09-01', exercise: { completed: true, durationMinutes: 30 } },
    { date: '2026-09-10', weight: 69 },
  ])
  cloudHandler = async () => { throw new Error('range offline') }

  const completeStore = new HealthStore(new FakeMembershipStore(namespaceC))
  const complete = await completeStore.getRange('2026-08-29', '2026-09-04')
  assert.deepStrictEqual(complete.map((item) => item.date), ['2026-08-31', '2026-09-01'])
  assert.strictEqual(complete.cacheInfo.source, 'cache')
  assert.strictEqual(complete.cacheInfo.complete, true)
  assert.deepStrictEqual(complete.cacheInfo.missingMonths, [])

  storage.delete(septemberKey)
  const partialStore = new HealthStore(new FakeMembershipStore(namespaceC))
  const partial = await partialStore.getRange('2026-08-29', '2026-09-04')
  assert.deepStrictEqual(partial.map((item) => item.date), ['2026-08-31'])
  assert.strictEqual(partial.cacheInfo.source, 'cache')
  assert.strictEqual(partial.cacheInfo.complete, false)
  assert.deepStrictEqual(partial.cacheInfo.missingMonths, ['2026-09'])
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

async function testDiscardDraftKeepsExpectedIdAcrossFlush() {
  const key = `meal_user_state_v3_${namespaceA}`
  const activePlan = userPlan('active-before-discard', 'active-shopping')
  const draftA = userPlan('draft-a', 'draft-a-shopping')
  const draftB = userPlan('draft-b', 'draft-b-shopping')
  storage.set(key, {
    ...stateWithPlan(activePlan),
    draftPlan: draftA,
    stateRevision: 7,
  })
  storage.delete(`meal_user_pending_v1_${namespaceA}`)
  const store = new UserStore(new FakeMembershipStore(namespaceA))
  store.bindNamespace()
  await store.patch({ defaultDinnerMode: 'workout' }, { localOnly: true })

  const calls = []
  cloudHandler = async (name, action, payload) => {
    assert.strictEqual(name, 'userData')
    calls.push({ action, payload })
    if (action === 'saveState') {
      assert.strictEqual(payload.expectedStateRevision, 7)
      return {
        ...stateWithPlan(activePlan),
        draftPlan: draftB,
        defaultDinnerMode: 'workout',
        stateRevision: 8,
      }
    }
    assert.strictEqual(action, 'discardDraft')
    const error = new Error('candidate changed while pending edits flushed')
    error.code = 'STATE_REVISION_CONFLICT'
    throw error
  }

  await assert.rejects(
    store.discardDraft('draft-a'),
    (error) => error && error.code === 'STATE_REVISION_CONFLICT',
  )
  assert.deepStrictEqual(calls.map((call) => call.action), ['saveState', 'discardDraft'])
  const discard = calls[1].payload
  assert.strictEqual(discard.expectedDraftPlanId, 'draft-a',
    'flush must not replace the draft ID captured by the caller')
  assert.strictEqual(discard.expectedStateRevision, 8,
    'discard CAS must use the revision returned by the preceding flush')
  assert.strictEqual(discard.expectedCacheNamespace, namespaceA)
  assert.strictEqual(store.data.draftPlan.id, 'draft-b')
  assert.strictEqual(store.data.stateRevision, 8)
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
  const planB = userPlan('plan-b', 'item-b', 10)
  assert.strictEqual(planB.durationDays, 10, '缓存隔离夹具必须覆盖非 7 天计划')
  assert.strictEqual(planB.days.length, 10)
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

function mealOverride(title) {
  return {
    title,
    ingredients: `${title} ingredients`,
    method: `${title} method`,
    tag: `${title} tag`,
    updatedAt: '2026-08-28T00:00:00.000Z',
  }
}

async function testDifferentMealOverridesMergeAcrossRevisionConflict() {
  const key = `meal_user_state_v3_${namespaceA}`
  const pendingKey = `meal_user_pending_v1_${namespaceA}`
  const plan = userPlan('meal-merge', 'meal-merge-shopping')
  const localMealId = plan.days[0].meals[0].id
  const remoteMealId = plan.days[1].meals[0].id
  storage.set(key, { ...stateWithPlan(plan), stateRevision: 2 })
  storage.delete(pendingKey)
  const store = new UserStore(new FakeMembershipStore(namespaceA))
  store.bindNamespace()
  await store.setMealOverride(localMealId, mealOverride('Local edit'), { localOnly: true })

  const remoteState = {
    ...stateWithPlan(plan),
    stateRevision: 3,
    mealOverrides: { [remoteMealId]: mealOverride('Remote edit') },
  }
  let saveCount = 0
  cloudHandler = async (_name, action, payload) => {
    if (action === 'bootstrap') return remoteState
    saveCount += 1
    if (saveCount === 1) {
      const error = new Error('another device changed a different meal')
      error.code = 'STATE_REVISION_CONFLICT'
      throw error
    }
    assert.deepStrictEqual(payload.state.mealOverrides, {
      [remoteMealId]: mealOverride('Remote edit'),
      [localMealId]: mealOverride('Local edit'),
    }, 'revision rebase must retain the other device edit for a different mealId')
    return { ...remoteState, stateRevision: 4, mealOverrides: payload.state.mealOverrides }
  }

  const saved = await store.flush()
  assert.strictEqual(saveCount, 2)
  assert.strictEqual(saved.mealOverrides[localMealId].title, 'Local edit')
  assert.strictEqual(saved.mealOverrides[remoteMealId].title, 'Remote edit')
  assert.deepStrictEqual(storage.get(pendingKey).mealOverrideOperations, {})
}

async function testSameMealOverrideUsesExplicitLocalOperationOnConflict() {
  const key = `meal_user_state_v3_${namespaceA}`
  const plan = userPlan('same-meal-merge', 'same-meal-shopping')
  const mealId = plan.days[0].meals[0].id
  storage.set(key, { ...stateWithPlan(plan), stateRevision: 2 })
  storage.delete(`meal_user_pending_v1_${namespaceA}`)
  const store = new UserStore(new FakeMembershipStore(namespaceA))
  store.bindNamespace()
  await store.setMealOverride(mealId, mealOverride('Local same-meal edit'), { localOnly: true })

  const remoteState = {
    ...stateWithPlan(plan),
    stateRevision: 3,
    mealOverrides: { [mealId]: mealOverride('Remote same-meal edit') },
  }
  let saveCount = 0
  cloudHandler = async (_name, action, payload) => {
    if (action === 'bootstrap') return remoteState
    saveCount += 1
    if (saveCount === 1) {
      const error = new Error('same meal changed remotely')
      error.code = 'STATE_REVISION_CONFLICT'
      throw error
    }
    assert.strictEqual(payload.state.mealOverrides[mealId].title, 'Local same-meal edit',
      'same mealId conflict policy is explicit local operation wins')
    return { ...remoteState, stateRevision: 4, mealOverrides: payload.state.mealOverrides }
  }

  const saved = await store.flush()
  assert.strictEqual(saved.mealOverrides[mealId].title, 'Local same-meal edit')
}

async function testMealOverrideRemovalTombstoneSurvivesConflict() {
  const key = `meal_user_state_v3_${namespaceA}`
  const plan = userPlan('meal-remove', 'meal-remove-shopping')
  const removedMealId = plan.days[0].meals[0].id
  const remoteMealId = plan.days[1].meals[0].id
  storage.set(key, {
    ...stateWithPlan(plan),
    stateRevision: 2,
    mealOverrides: { [removedMealId]: mealOverride('Old local edit') },
  })
  storage.delete(`meal_user_pending_v1_${namespaceA}`)
  const store = new UserStore(new FakeMembershipStore(namespaceA))
  store.bindNamespace()
  await store.setMealOverride(removedMealId, null, { localOnly: true })

  const remoteState = {
    ...stateWithPlan(plan),
    stateRevision: 3,
    mealOverrides: {
      [removedMealId]: mealOverride('Remote stale edit'),
      [remoteMealId]: mealOverride('Other remote edit'),
    },
  }
  let saveCount = 0
  cloudHandler = async (_name, action, payload) => {
    if (action === 'bootstrap') return remoteState
    saveCount += 1
    if (saveCount === 1) {
      const error = new Error('remote changed before removal')
      error.code = 'STATE_REVISION_CONFLICT'
      throw error
    }
    assert.strictEqual(Object.prototype.hasOwnProperty.call(payload.state.mealOverrides, removedMealId), false,
      'explicit local removal must remain removed after rebase')
    assert.strictEqual(payload.state.mealOverrides[remoteMealId].title, 'Other remote edit')
    return { ...remoteState, stateRevision: 4, mealOverrides: payload.state.mealOverrides }
  }

  const saved = await store.flush()
  assert.strictEqual(Object.prototype.hasOwnProperty.call(saved.mealOverrides, removedMealId), false)
  assert.strictEqual(saved.mealOverrides[remoteMealId].title, 'Other remote edit')
}

async function testColdStartReplaysPersistedMealOverrideOperation() {
  const key = `meal_user_state_v3_${namespaceA}`
  const pendingKey = `meal_user_pending_v1_${namespaceA}`
  const plan = userPlan('meal-cold-start', 'meal-cold-shopping')
  const localMealId = plan.days[0].meals[0].id
  const remoteMealId = plan.days[1].meals[0].id
  const localOverride = mealOverride('Persisted local edit')
  storage.set(key, { ...stateWithPlan(plan), stateRevision: 2 })
  storage.set(pendingKey, {
    version: 3,
    revision: 7,
    fields: {},
    fieldRevisions: {},
    mealOverrideOperations: {
      [localMealId]: { removed: false, value: localOverride, revision: 7 },
    },
    planUiByPlan: {},
    unscopedPlanUi: { fields: {}, fieldRevisions: {}, checkedOperations: {} },
  })
  const store = new UserStore(new FakeMembershipStore(namespaceA))
  store.bindNamespace()
  assert.strictEqual(store.data.mealOverrides[localMealId].title, 'Persisted local edit')

  const remoteState = {
    ...stateWithPlan(plan),
    stateRevision: 3,
    mealOverrides: { [remoteMealId]: mealOverride('Remote while offline') },
  }
  cloudHandler = async (_name, action, payload) => {
    if (action === 'bootstrap') return remoteState
    assert.strictEqual(payload.state.mealOverrides[localMealId].title, 'Persisted local edit')
    assert.strictEqual(payload.state.mealOverrides[remoteMealId].title, 'Remote while offline')
    return { ...remoteState, stateRevision: 4, mealOverrides: payload.state.mealOverrides }
  }
  const saved = await store.init({ force: true })
  assert.strictEqual(saved.mealOverrides[localMealId].title, 'Persisted local edit')
  assert.strictEqual(saved.mealOverrides[remoteMealId].title, 'Remote while offline')
  assert.deepStrictEqual(storage.get(pendingKey).mealOverrideOperations, {})
}

function legacyMealOverridesPending(value, revision = 7, version = 2) {
  return {
    version,
    revision,
    fields: { mealOverrides: value },
    fieldRevisions: { mealOverrides: revision },
    planUiByPlan: {},
    unscopedPlanUi: { fields: {}, fieldRevisions: {}, checkedOperations: {} },
  }
}

async function testLegacyEmptyMealOverridesRemovesCloudOverride() {
  const key = `meal_user_state_v3_${namespaceA}`
  const pendingKey = `meal_user_pending_v1_${namespaceA}`
  const plan = userPlan('legacy-meal-empty', 'legacy-meal-empty-shopping')
  const mealId = plan.days[0].meals[0].id
  storage.set(key, { ...stateWithPlan(plan), stateRevision: 2, mealOverrides: {} })
  storage.set(pendingKey, legacyMealOverridesPending({}))
  const store = new UserStore(new FakeMembershipStore(namespaceA))
  store.bindNamespace()
  assert.deepStrictEqual(store.data.mealOverrides, {})
  assert.strictEqual(store.pending.revision, 7)
  assert.deepStrictEqual(store.pending.legacyMealOverridesReplacement.value, {})

  const remote = {
    ...stateWithPlan(plan),
    stateRevision: 3,
    mealOverrides: { [mealId]: mealOverride('Cloud stale override') },
  }
  let savedPayload
  cloudHandler = async (_name, action, payload) => {
    if (action === 'bootstrap') return remote
    savedPayload = payload
    return { ...remote, stateRevision: 4, mealOverrides: payload.state.mealOverrides }
  }
  const saved = await store.init({ force: true })
  assert.deepStrictEqual(savedPayload.state.mealOverrides, {}, 'legacy empty map must create a cloud tombstone')
  assert.deepStrictEqual(saved.mealOverrides, {})
  assert.strictEqual(storage.get(pendingKey).legacyMealOverridesReplacement, null)
  assert.deepStrictEqual(storage.get(pendingKey).mealOverrideOperations, {})
  assert.strictEqual(storage.get(pendingKey).revision, 0)
}

async function testLegacyMealOverridesMixedReplacementSurvivesConflict() {
  const key = `meal_user_state_v3_${namespaceA}`
  const pendingKey = `meal_user_pending_v1_${namespaceA}`
  const plan = userPlan('legacy-meal-mixed', 'legacy-meal-mixed-shopping')
  const updatedId = plan.days[0].meals[0].id
  const removedId = plan.days[1].meals[0].id
  const addedId = plan.days[2].meals[0].id
  const untouchedId = plan.days[3].meals[0].id
  const conflictAddedId = plan.days[4].meals[0].id
  const desired = {
    [updatedId]: mealOverride('Legacy updated'),
    [addedId]: mealOverride('Legacy added'),
    [untouchedId]: mealOverride('Unchanged'),
  }
  storage.set(key, { ...stateWithPlan(plan), stateRevision: 2, mealOverrides: desired })
  storage.set(pendingKey, legacyMealOverridesPending(desired, 9, 1))
  const store = new UserStore(new FakeMembershipStore(namespaceA))

  const firstRemote = {
    ...stateWithPlan(plan),
    stateRevision: 3,
    mealOverrides: {
      [updatedId]: mealOverride('Cloud old'),
      [removedId]: mealOverride('Cloud remove me'),
      [untouchedId]: mealOverride('Unchanged'),
    },
  }
  const conflictRemote = {
    ...firstRemote,
    stateRevision: 4,
    mealOverrides: {
      ...firstRemote.mealOverrides,
      [removedId]: mealOverride('Cloud changed before delete'),
      [conflictAddedId]: mealOverride('Cloud added during conflict'),
    },
  }
  let bootstrapCount = 0
  let saveCount = 0
  cloudHandler = async (_name, action, payload) => {
    if (action === 'bootstrap') return ++bootstrapCount === 1 ? firstRemote : conflictRemote
    saveCount += 1
    if (saveCount === 1) {
      const error = new Error('legacy replacement revision conflict')
      error.code = 'STATE_REVISION_CONFLICT'
      throw error
    }
    assert.strictEqual(payload.expectedStateRevision, 4)
    assert.deepStrictEqual(payload.state.mealOverrides, desired,
      'legacy full-map intent must remain authoritative for every changed meal after rebase')
    return { ...conflictRemote, stateRevision: 5, mealOverrides: payload.state.mealOverrides }
  }
  const saved = await store.init({ force: true })
  assert.strictEqual(saveCount, 2)
  assert.deepStrictEqual(saved.mealOverrides, desired)
  assert.strictEqual(storage.get(pendingKey).revision, 0)
  assert.deepStrictEqual(storage.get(pendingKey).mealOverrideOperations, {})
}

async function testPersistedLegacyReplacementKeepsNewV3MealOperation() {
  const key = `meal_user_state_v3_${namespaceA}`
  const pendingKey = `meal_user_pending_v1_${namespaceA}`
  const plan = userPlan('legacy-meal-restart', 'legacy-meal-restart-shopping')
  const removedId = plan.days[0].meals[0].id
  const newEditId = plan.days[1].meals[0].id
  storage.set(key, { ...stateWithPlan(plan), stateRevision: 2, mealOverrides: {} })
  storage.set(pendingKey, {
    ...legacyMealOverridesPending({}, 7),
    version: 3,
    revision: 8,
    mealOverrideOperations: {
      [newEditId]: { removed: false, value: mealOverride('New v3 edit'), revision: 8 },
    },
    legacyMealOverridesReplacement: { value: {}, revision: 7 },
  })
  const store = new UserStore(new FakeMembershipStore(namespaceA))
  const remote = {
    ...stateWithPlan(plan),
    stateRevision: 3,
    mealOverrides: { [removedId]: mealOverride('Remove after restart') },
  }
  cloudHandler = async (_name, action, payload) => {
    if (action === 'bootstrap') return remote
    assert.deepStrictEqual(payload.state.mealOverrides, { [newEditId]: mealOverride('New v3 edit') })
    return { ...remote, stateRevision: 4, mealOverrides: payload.state.mealOverrides }
  }
  const saved = await store.init({ force: true })
  assert.deepStrictEqual(saved.mealOverrides, { [newEditId]: mealOverride('New v3 edit') })
  assert.strictEqual(storage.get(pendingKey).revision, 0)
}

function testV3PendingNeverFallsBackToFullMealMap() {
  const plan = userPlan('v3-no-full-map', 'v3-no-full-map-shopping')
  const mealId = plan.days[0].meals[0].id
  const cached = { ...stateWithPlan(plan), mealOverrides: { [mealId]: mealOverride('Cached') } }
  const normalized = require(userModulePath).normalizePending({
    version: 3,
    revision: 7,
    fields: { mealOverrides: {} },
    fieldRevisions: { mealOverrides: 7 },
    mealOverrideOperations: {},
  }, cached)
  assert.strictEqual(normalized.legacyMealOverridesReplacement, null,
    'v3 pending must use per-meal operations and ignore obsolete full-map fields')
  assert.strictEqual(normalized.revision, 0)
}

async function testLegacyMealReplacementCannotCrossNamespace() {
  const keyA = `meal_user_state_v3_${namespaceA}`
  const pendingKeyA = `meal_user_pending_v1_${namespaceA}`
  const keyB = `meal_user_state_v3_${namespaceB}`
  const planA = userPlan('legacy-namespace-a', 'legacy-namespace-a-shopping')
  const planB = userPlan('legacy-namespace-b', 'legacy-namespace-b-shopping')
  storage.set(keyA, { ...stateWithPlan(planA), stateRevision: 2, mealOverrides: {} })
  storage.set(pendingKeyA, legacyMealOverridesPending({}))
  storage.set(keyB, { ...stateWithPlan(planB), stateRevision: 5 })
  storage.delete(`meal_user_pending_v1_${namespaceB}`)
  const memberStore = new FakeMembershipStore(namespaceA)
  const store = new UserStore(memberStore)
  let resolveBootstrap
  let saveCalls = 0
  cloudHandler = async (_name, action) => {
    if (action === 'saveState') {
      saveCalls += 1
      throw new Error('stale namespace must never save')
    }
    return new Promise((resolve) => { resolveBootstrap = resolve })
  }
  const request = store.init({ force: true })
  await new Promise((resolve) => setImmediate(resolve))
  memberStore.switchTo(namespaceB)
  resolveBootstrap({ ...stateWithPlan(planA), stateRevision: 3 })
  await assert.rejects(request, /身份已变化/)
  assert.strictEqual(saveCalls, 0)
  assert.strictEqual(store.namespace, namespaceB)
  assert.strictEqual(store.pending.legacyMealOverridesReplacement, null)
  assert.deepStrictEqual(storage.get(pendingKeyA), legacyMealOverridesPending({}),
    'namespace switch must leave account A pending data under account A key only')
}

function testMealEditUsesSingleMealOperationApi() {
  const source = fs.readFileSync(path.join(projectRoot, 'miniprogram', 'pages', 'meal-edit', 'meal-edit.js'), 'utf8')
  assert(source.includes('userStore.setMealOverride(this.data.mealId, override)'))
  assert(source.includes('userStore.setMealOverride(this.data.mealId, null)'))
  assert(!source.includes('userStore.patch({ mealOverrides'), 'meal editor must not submit a whole override map')
  assert(source.includes('这份餐食已更新或不存在，请返回餐单重新选择'),
    '无效餐食入口必须使用用户可理解的恢复提示')
  assert(!source.includes('餐食标识无效'), '页面不能向用户暴露技术标识术语')
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

function cachedStateWithInvalidDuration(durationDays) {
  const activePlan = userPlan('cached-duration-active', 'cached-duration-item')
  const draftPlan = userPlan('cached-duration-draft', 'cached-duration-draft-item')
  const historyPlan = userPlan('cached-duration-history', 'cached-duration-history-item')
  const activeMealId = activePlan.days[0].meals[0].id
  return {
    ...stateWithPlan(activePlan, [historyPlan]),
    draftPlan,
    generationPreferences: {
      ...defaults().generationPreferences,
      durationDays,
      mealTypes: ['breakfast'],
      goals: ['保留缓存偏好'],
    },
    checkedShoppingIds: ['cached-duration-item'],
    mealOverrides: { [activeMealId]: mealOverride('保留个人餐食调整') },
    customReminders: [{ id: 'cached-duration-reminder', text: '保留离线提醒', done: false }],
    settings: { calciumAnchorReminder: true, vitaminDReminder: true },
    updatedAt: '2026-08-31T01:02:03.000Z',
  }
}

function testInvalidCachedDurationRepairsOnlyDurationField() {
  const key = `meal_user_state_v3_${namespaceC}`
  const pending = `meal_user_pending_v1_${namespaceC}`
  ;[0, 15, 1.5, 'not-a-number'].forEach((durationDays) => {
    storage.set(key, cachedStateWithInvalidDuration(durationDays))
    storage.delete(pending)
    const store = new UserStore(new FakeMembershipStore(namespaceC))
    store.bindNamespace()

    assert.strictEqual(store.data.generationPreferences.durationDays, 1)
    assert.deepStrictEqual(store.data.generationPreferences.goals, ['保留缓存偏好'])
    assert.strictEqual(store.data.activePlan.id, 'cached-duration-active')
    assert.strictEqual(store.data.draftPlan.id, 'cached-duration-draft')
    assert.deepStrictEqual(store.data.planHistory.map((plan) => plan.id), ['cached-duration-history'])
    assert.deepStrictEqual(store.data.checkedShoppingIds, ['cached-duration-item'])
    assert.strictEqual(
      store.data.mealOverrides['cached-duration-active-meal-1'].title,
      '保留个人餐食调整',
    )
    assert.deepStrictEqual(store.data.customReminders, [
      { id: 'cached-duration-reminder', text: '保留离线提醒', done: false },
    ])
    assert.deepStrictEqual(store.data.settings, { calciumAnchorReminder: true, vitaminDReminder: true })
    assert.strictEqual(store.data.updatedAt, '2026-08-31T01:02:03.000Z')
  })
}

async function testCloudDurationValidationRemainsStrict() {
  const key = `meal_user_state_v3_${namespaceC}`
  const pending = `meal_user_pending_v1_${namespaceC}`
  for (const durationDays of [0, 15, 1.5, 'not-a-number']) {
    storage.delete(key)
    storage.delete(pending)
    const store = new UserStore(new FakeMembershipStore(namespaceC))
    cloudHandler = async (_name, action) => {
      assert.strictEqual(action, 'bootstrap')
      return cachedStateWithInvalidDuration(durationDays)
    }
    await assert.rejects(store.init({ force: true }), /generationPreferences\.durationDays/)
    assert.strictEqual(store.data.activePlan, null, '非法云端状态不得进入客户端数据')
  }
}

async function main() {
  await testColdStartRequiresOnlineStatus()
  await testVerifiedIdentityReconcilesOnlyStalePrivateCaches()
  await testLatestIdentityResponseWins()
  await testResetInvalidatesIdentityResponse()
  testDeletionRecoveryClassification()
  await testAuthCachesAreNamespaced()
  await testStaleAuthRequestCannotCrossNamespace()
  await testHealthCachesAreNamespaced()
  await testStaleRequestCannotCrossNamespace()
  await testGenerationIsSentWithEveryDataRequest()
  await testPreferenceOnlyCacheRestoresOfflineWithoutTreatingDefaultsAsCache()
  await testHealthRangeFallsBackToCompleteOrPartialMonthCaches()
  await testPlanCachesAreNamespaced()
  await testStalePlanRequestCannotCrossNamespace()
  await testStalePlanSaveCannotCrossNamespace()
  await testImmediateSaveWaitsForItsOwnRevision()
  await testDiscardDraftKeepsExpectedIdAcrossFlush()
  await testColdStartReplaysPersistedShoppingOperations()
  await testPlanScopedPendingDoesNotMoveAcrossConflict()
  await testLegacyFlatPendingMigratesToCachedPlan()
  await testRevisionConflictRebasesPendingChangesOnce()
  await testDifferentMealOverridesMergeAcrossRevisionConflict()
  await testSameMealOverrideUsesExplicitLocalOperationOnConflict()
  await testMealOverrideRemovalTombstoneSurvivesConflict()
  await testColdStartReplaysPersistedMealOverrideOperation()
  await testLegacyEmptyMealOverridesRemovesCloudOverride()
  await testLegacyMealOverridesMixedReplacementSurvivesConflict()
  await testPersistedLegacyReplacementKeepsNewV3MealOperation()
  testV3PendingNeverFallsBackToFullMealMap()
  await testLegacyMealReplacementCannotCrossNamespace()
  testMealEditUsesSingleMealOperationApi()
  await testLateBootstrapCannotRollBackSuccessfulSave()
  testInvalidCachedDurationRepairsOnlyDurationField()
  await testCloudDurationValidationRemainsStrict()
  console.log('cache namespace tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
