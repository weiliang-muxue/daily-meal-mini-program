'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const shoppingPath = path.join(root, 'miniprogram', 'pages', 'shopping', 'shopping.js')
const userStorePath = path.join(root, 'miniprogram', 'services', 'user-store.js')
const authStorePath = path.join(root, 'miniprogram', 'services', 'auth-store.js')
const membershipStorePath = path.join(root, 'miniprogram', 'services', 'membership-store.js')
const shoppingMarkup = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'shopping', 'shopping.wxml'), 'utf8')
assert(shoppingMarkup.includes('AI 生成') && !shoppingMarkup.includes('AI生成'),
  '采购页的 AI 来源标识必须保留中英文空格')
assert(!shoppingMarkup.includes('结构化食材'), '采购页不能向用户暴露内部食材结构术语')
assert(!shoppingMarkup.includes('本机快照') && !shoppingMarkup.includes('云同步'),
  '采购页同步提示必须使用面向用户的表达')
assert(shoppingMarkup.includes('食材采购进度'), '页面内容标题必须说明用户任务，避免与导航栏重复“采购清单”')
for (const wording of ['已确认餐单', '查看当前餐单', '重置采购勾选']) {
  assert(shoppingMarkup.includes(wording), `采购页缺少统一餐单文案：${wording}`)
}
for (const wording of ['确认计划', '当前计划', 'AI 餐单']) {
  assert(!shoppingMarkup.includes(wording), `采购页仍混用旧计划文案：${wording}`)
}
assert(shoppingMarkup.includes('wx:if="{{errorMessage || offline}}"'),
  '有采购项时也必须显示同步错误或离线提示')
assert(/<button[^>]+class="[^"]*sync-retry[^>]+bindtap="retrySync"[^>]+disabled="{{saving}}"[^>]+loading="{{saving}}"/.test(shoppingMarkup),
  '同步错误必须提供有忙碌反馈且避免重复点击的原生重试按钮')
assert(shoppingMarkup.includes('采购进度尚未同步') && shoppingMarkup.includes('本机勾选等待同步'),
  '待同步和同步失败不能继续声称正在保存或已同步')

const namespaceA = 'a'.repeat(32)
const namespaceB = 'b'.repeat(32)
let pageDefinition

function plan(id, itemId) {
  return {
    id,
    title: id,
    durationDays: 1,
    days: [{ id: `${id}-day`, date: '2026-08-26', meals: [] }],
    shoppingGroups: [{ id: `${id}-group`, name: '食材', items: [{ id: itemId, name: itemId, amount: '1 份' }] }],
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const namespaceListeners = new Set()
const membershipStore = {
  cacheNamespace: namespaceA,
  init: async () => ({ status: 'active', cacheNamespace: membershipStore.cacheNamespace }),
  onCacheNamespaceChange(listener) {
    namespaceListeners.add(listener)
    return () => namespaceListeners.delete(listener)
  },
  switchTo(namespace) {
    const previous = this.cacheNamespace
    this.cacheNamespace = namespace
    namespaceListeners.forEach((listener) => listener(namespace, previous))
  },
}

const patchCalls = []
const flushes = []
const initCalls = []
const toasts = []
const modals = []
let initHandler
const userStore = {
  data: { activePlanId: 'plan-a', activePlan: plan('plan-a', 'apple'), checkedShoppingIds: [] },
  state: 'ready',
  error: '',
  init(options) {
    initCalls.push(options)
    return initHandler(options)
  },
  patch(partial) {
    patchCalls.push(partial)
    userStore.data = { ...userStore.data, ...partial }
    return Promise.resolve(userStore.data)
  },
  flush() {
    const request = deferred()
    flushes.push(request)
    return request.promise
  },
}

require.cache[userStorePath] = {
  id: userStorePath, filename: userStorePath, loaded: true, exports: { userStore },
}
require.cache[authStorePath] = {
  id: authStorePath, filename: authStorePath, loaded: true, exports: { authStore: { init: async () => ({}) } },
}
require.cache[membershipStorePath] = {
  id: membershipStorePath, filename: membershipStorePath, loaded: true, exports: { membershipStore },
}

global.Page = (definition) => { pageDefinition = definition }
global.wx = {
  reLaunch() {}, stopPullDownRefresh() {}, navigateTo() {}, switchTab() {},
  showToast(options) { toasts.push(options) },
  showModal(options) { modals.push(options) },
}

delete require.cache[shoppingPath]
require(shoppingPath)

function pageInstance() {
  const page = {
    ...pageDefinition,
    data: JSON.parse(JSON.stringify(pageDefinition.data)),
    scheduledSyncs: [],
    setData(partial) { this.data = { ...this.data, ...partial } },
    scheduleSync(delay) { this.scheduledSyncs.push(delay) },
  }
  page.ensureOperationScope()
  return page
}

function resetState() {
  membershipStore.cacheNamespace = namespaceA
  userStore.data = { activePlanId: 'plan-a', activePlan: plan('plan-a', 'apple'), checkedShoppingIds: [] }
  userStore.state = 'ready'
  userStore.error = ''
  initHandler = async () => userStore.data
  patchCalls.length = 0
  flushes.length = 0
  initCalls.length = 0
  toasts.length = 0
  modals.length = 0
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve))
}

async function testNamespaceSwitchDropsOnlyPageOperations() {
  resetState()
  const page = pageInstance()
  page.applyCheckedIds(new Set(['apple']), ['apple'])
  const oldScope = page.operationScope
  assert.strictEqual(oldScope.pendingOperations.size, 1)
  assert.deepStrictEqual(userStore.data.checkedShoppingIds, ['apple'], '勾选仍须先进入 user-store 的持久化机制')

  membershipStore.switchTo(namespaceB)
  userStore.data = { activePlanId: 'plan-b', activePlan: plan('plan-b', 'banana'), checkedShoppingIds: [] }
  const nextScope = page.ensureOperationScope()

  assert.notStrictEqual(nextScope, oldScope)
  assert.strictEqual(oldScope.pendingOperations.size, 0)
  assert.strictEqual(nextScope.cacheNamespace, namespaceB)
  assert.strictEqual(nextScope.activePlanId, 'plan-b')
  assert.strictEqual(nextScope.pendingOperations.size, 0)
  assert.strictEqual(patchCalls.length, 1, '切换账号只能丢弃页面 Map，不能覆盖 user-store 的持久化操作日志')
}

async function testPlanSwitchDropsOldPlanOperations() {
  resetState()
  const page = pageInstance()
  page.applyCheckedIds(new Set(['apple']), ['apple'])
  const oldScope = page.operationScope

  userStore.data = { activePlanId: 'plan-c', activePlan: plan('plan-c', 'carrot'), checkedShoppingIds: [] }
  const nextScope = page.ensureOperationScope()

  assert.notStrictEqual(nextScope, oldScope)
  assert.strictEqual(oldScope.pendingOperations.size, 0)
  assert.strictEqual(nextScope.cacheNamespace, namespaceA)
  assert.strictEqual(nextScope.activePlanId, 'plan-c')
  assert.strictEqual(patchCalls.length, 1, '切换计划不能把旧计划勾选写入新计划')
}

async function testLateSaveCannotClearNewScope() {
  resetState()
  const page = pageInstance()
  page.applyCheckedIds(new Set(['apple']), ['apple'])
  const oldScope = page.operationScope
  const oldSave = page.syncChanges(oldScope)
  assert.strictEqual(flushes.length, 1)

  membershipStore.switchTo(namespaceB)
  userStore.data = { activePlanId: 'plan-b', activePlan: plan('plan-b', 'banana'), checkedShoppingIds: [] }
  page.ensureOperationScope()
  page.applyCheckedIds(new Set(['banana']), ['banana'])
  const newScope = page.operationScope
  const newSave = page.syncChanges(newScope)
  assert.strictEqual(flushes.length, 2)
  assert.strictEqual(newScope.pendingOperations.has('banana'), true)

  flushes[0].resolve(userStore.data)
  await oldSave
  await tick()
  assert.strictEqual(page.operationScope, newScope)
  assert.strictEqual(newScope.pendingOperations.has('banana'), true, '旧账号迟到的保存响应不能清除新账号操作')

  flushes[1].resolve(userStore.data)
  await newSave
  assert.strictEqual(newScope.pendingOperations.size, 0)
}

async function testFailedSaveKeepsChecksAndCanRetry() {
  resetState()
  const page = pageInstance()
  page.applyCheckedIds(new Set(['apple']), ['apple'])
  const activePlan = userStore.data.activePlan
  assert.strictEqual(page.data.pendingSync, true)
  assert.strictEqual(page.data.saving, false, '等待同步不能伪装成正在发送请求')

  const save = page.syncChanges()
  assert.strictEqual(page.data.saving, true)
  const failure = assert.rejects(save, /模拟保存失败/)
  flushes[0].reject(new Error('模拟保存失败，请重试'))
  await failure
  assert.strictEqual(page.data.viewState, 'ready', '同步错误不能隐藏仍可使用的采购清单')
  assert.strictEqual(page.data.saving, false)
  assert.strictEqual(page.data.pendingSync, true)
  assert.strictEqual(page.data.errorMessage, '模拟保存失败，请重试')
  assert.strictEqual(page.data.checked, 1)
  assert.deepStrictEqual(userStore.data.checkedShoppingIds, ['apple'])
  assert.deepStrictEqual(page.scheduledSyncs, [500], '失败后不能每 80ms 无限重试')
  page.render()
  assert.strictEqual(page.data.errorMessage, '模拟保存失败，请重试', '再次渲染不能吞掉失败提示')

  const retry = page.retrySync()
  assert.strictEqual(page.retrySync(), retry, '重复点击必须复用同一次重试')
  await tick()
  assert.strictEqual(flushes.length, 2)
  assert.strictEqual(initCalls.length, 0, '有待同步勾选时应先保存，不能重新载入覆盖本页操作')
  assert.strictEqual(page.data.saving, true)
  flushes[1].resolve(userStore.data)
  await retry
  assert.strictEqual(page.data.pendingSync, false)
  assert.strictEqual(page.data.saving, false)
  assert.strictEqual(page.data.errorMessage, '')
  assert.strictEqual(userStore.data.activePlan, activePlan, '重试不得重置餐单')
  assert.deepStrictEqual(userStore.data.checkedShoppingIds, ['apple'])
  assert.strictEqual(patchCalls.length, 1, '普通重试只提交本机记录，不能反复改写勾选')
}

async function testOfflineFailureAndRepeatedRetry() {
  resetState()
  const page = pageInstance()
  page.applyCheckedIds(new Set(['apple']), ['apple'])
  const save = page.syncChanges()
  const failure = assert.rejects(save, /模拟离线/)
  userStore.state = 'offline'
  userStore.error = '模拟离线'
  flushes[0].reject(new Error('模拟离线'))
  await failure
  assert.strictEqual(page.data.offline, true)
  assert.strictEqual(page.data.saving, false)
  assert.strictEqual(page.data.checked, 1)

  const retry = page.retrySync()
  await tick()
  assert.strictEqual(page.data.saving, true)
  flushes[1].reject(new Error('模拟网络仍不可用'))
  await retry
  assert.strictEqual(page.data.saving, false)
  assert.strictEqual(page.data.errorMessage, '模拟网络仍不可用')
  assert.strictEqual(page.operationScope.pendingOperations.size, 1)
  assert.deepStrictEqual(userStore.data.checkedShoppingIds, ['apple'])
  assert.strictEqual(toasts.some((toast) => toast.icon === 'success'), false)
}

async function testRetryWithoutPageOperationsReloadsOnce() {
  resetState()
  userStore.data.checkedShoppingIds = ['apple']
  const page = pageInstance()
  page.operationScope.errorMessage = '上次加载失败'
  page.render()
  const reload = deferred()
  initHandler = () => reload.promise
  const retry = page.retrySync()
  assert.strictEqual(page.retrySync(), retry)
  await tick()
  assert.deepStrictEqual(initCalls, [{ force: true }], '没有页面操作时应只重新加载一次')
  assert.strictEqual(flushes.length, 0)
  assert.strictEqual(patchCalls.length, 0)
  reload.resolve(userStore.data)
  await retry
  assert.strictEqual(page.data.viewState, 'ready')
  assert.strictEqual(page.data.checked, 1)
  assert.strictEqual(page.data.saving, false)
  assert.strictEqual(page.data.errorMessage, '')
  assert.strictEqual(userStore.data.activePlanId, 'plan-a')
}

async function testReloadFailureWithExistingListStaysVisible() {
  resetState()
  userStore.data.checkedShoppingIds = ['apple']
  const page = pageInstance()
  initHandler = async () => { throw new Error('模拟重新加载失败') }
  await page.retrySync()
  assert.strictEqual(page.data.viewState, 'ready')
  assert.strictEqual(page.data.errorMessage, '模拟重新加载失败')
  assert.strictEqual(page.data.checked, 1)
  assert.strictEqual(page.data.saving, false)
  assert.strictEqual(page.data.pendingSync, false)
  assert.strictEqual(patchCalls.length, 0)
}

async function testLateFailureCannotAffectNewScope() {
  resetState()
  const page = pageInstance()
  page.applyCheckedIds(new Set(['apple']), ['apple'])
  const oldRetry = page.retrySync()
  await tick()
  membershipStore.switchTo(namespaceB)
  userStore.data = { activePlanId: 'plan-b', activePlan: plan('plan-b', 'banana'), checkedShoppingIds: [] }
  page.ensureOperationScope()
  page.applyCheckedIds(new Set(['banana']), ['banana'])
  const newRetry = page.retrySync()
  await tick()
  const nextView = JSON.stringify(page.data)
  flushes[0].reject(new Error('旧账号迟到的失败'))
  await oldRetry
  assert.strictEqual(JSON.stringify(page.data), nextView)
  assert.strictEqual(page.operationScope.pendingOperations.has('banana'), true)
  assert.strictEqual(toasts.length, 0, '旧账号迟到的错误不能弹出到新账号')
  assert.strictEqual(modals.length, 0)
  flushes[1].resolve(userStore.data)
  await newRetry
  assert.strictEqual(page.data.pendingSync, false)
}

async function testLateReloadCannotAffectNewScope() {
  resetState()
  const page = pageInstance()
  const oldReload = deferred()
  initHandler = () => oldReload.promise
  const oldRetry = page.retrySync()
  await tick()
  membershipStore.switchTo(namespaceB)
  userStore.data = { activePlanId: 'plan-b', activePlan: plan('plan-b', 'banana'), checkedShoppingIds: [] }
  page.render()
  initHandler = async () => userStore.data
  await page.retrySync()
  const nextView = JSON.stringify(page.data)
  oldReload.reject(new Error('旧账号迟到的加载错误'))
  await oldRetry
  assert.strictEqual(JSON.stringify(page.data), nextView)
  assert.strictEqual(page.data.planTitle, 'plan-b')
  assert.strictEqual(page.data.errorMessage, '')
  assert.strictEqual(toasts.length, 0)
}

async function testConflictRetryIncludesEditsMadeWhileReloading() {
  resetState()
  const page = pageInstance()
  page.applyCheckedIds(new Set(['apple']), ['apple'])
  page.operationScope.conflictPending = true
  page.operationScope.errorMessage = 'STATE_REVISION_CONFLICT'
  const reload = deferred()
  initHandler = () => reload.promise
  const retry = page.retrySync()
  assert.strictEqual(page.retrySync(), retry, '冲突读取阶段也必须防止重复重试')
  await tick()
  assert.strictEqual(initCalls.length, 1)
  assert.strictEqual(flushes.length, 0)
  page.applyCheckedIds(new Set(), ['apple'])
  userStore.data.checkedShoppingIds = ['apple']
  reload.resolve(userStore.data)
  await tick()
  assert.deepStrictEqual(userStore.data.checkedShoppingIds, [], '冲突重载期间的新勾选操作不能被旧快照覆盖')
  assert.strictEqual(flushes.length, 1)
  flushes[0].resolve(userStore.data)
  await retry
  assert.strictEqual(page.data.checked, 0)
  assert.strictEqual(page.data.saving, false)
  assert.strictEqual(page.data.pendingSync, false)
}

async function testConflictReloadFailureKeepsRecoveryVisible() {
  resetState()
  const page = pageInstance()
  page.applyCheckedIds(new Set(['apple']), ['apple'])
  page.operationScope.conflictPending = true
  initHandler = async () => {
    userStore.state = 'offline'
    userStore.error = '模拟冲突读取离线'
    return userStore.data
  }
  await page.retrySync()
  assert.strictEqual(flushes.length, 0)
  assert.strictEqual(page.data.errorMessage, '模拟冲突读取离线')
  assert.strictEqual(page.data.offline, true)
  assert.strictEqual(page.data.saving, false)
  assert.strictEqual(page.data.pendingSync, true)
  assert.strictEqual(page.data.checked, 1)
  assert.strictEqual(page.operationScope.conflictPending, true)
}

async function testLateConflictReloadCannotPatchNewScope() {
  resetState()
  const page = pageInstance()
  page.applyCheckedIds(new Set(['apple']), ['apple'])
  page.operationScope.conflictPending = true
  const reload = deferred()
  initHandler = () => reload.promise
  const oldRetry = page.retrySync()
  await tick()
  membershipStore.switchTo(namespaceB)
  userStore.data = { activePlanId: 'plan-b', activePlan: plan('plan-b', 'banana'), checkedShoppingIds: [] }
  page.applyCheckedIds(new Set(['banana']), ['banana'])
  const nextView = JSON.stringify(page.data)
  reload.resolve(userStore.data)
  await oldRetry
  assert.strictEqual(JSON.stringify(page.data), nextView)
  assert.strictEqual(patchCalls.length, 2, '旧账号合并响应不能在新账号继续 patch')
  assert.deepStrictEqual(userStore.data.checkedShoppingIds, ['banana'])
  assert.strictEqual(page.operationScope.pendingOperations.has('banana'), true)
  assert.strictEqual(flushes.length, 0)
  assert.strictEqual(toasts.length, 0)
}

async function testRemotePlanChangeEndsOldPlanStatus() {
  for (const conflictPending of [false, true]) {
    resetState()
    const page = pageInstance()
    page.applyCheckedIds(new Set(['apple']), ['apple'])
    page.operationScope.conflictPending = conflictPending
    const reload = deferred()
    initHandler = () => reload.promise
    const retry = page.retrySync()
    await tick()
    userStore.data = { activePlanId: 'plan-c', activePlan: plan('plan-c', 'carrot'), checkedShoppingIds: [] }
    if (conflictPending) reload.resolve(userStore.data)
    else flushes[0].resolve(userStore.data)
    await retry
    assert.strictEqual(page.data.planTitle, 'plan-c', '服务端切换餐单后应刷新当前清单')
    assert.strictEqual(page.data.saving, false)
    assert.strictEqual(page.data.pendingSync, false)
    assert.strictEqual(page.operationScope.activePlanId, 'plan-c')
    assert.strictEqual(patchCalls.length, 1, '旧餐单的重试不能改写新餐单勾选')
    assert.strictEqual(toasts.length, 0, '旧餐单不能声称新餐单已同步')
  }
}

async function testNewEditsRemainPendingAfterEarlierSave() {
  resetState()
  const page = pageInstance()
  page.applyCheckedIds(new Set(['apple']), ['apple'])
  const save = page.syncChanges()
  page.applyCheckedIds(new Set(), ['apple'])
  flushes[0].resolve(userStore.data)
  await save
  assert.strictEqual(page.operationScope.pendingOperations.get('apple').checked, false)
  assert.strictEqual(page.data.pendingSync, true)
  assert.strictEqual(page.data.saving, false)
  assert.strictEqual(page.scheduledSyncs.at(-1), 80, '上一批成功后继续同步期间新增的操作')
  const nextSave = page.syncChanges()
  flushes[1].resolve(userStore.data)
  await nextSave
  assert.strictEqual(page.data.pendingSync, false)
  assert.strictEqual(page.data.checked, 0)
}

async function testConflictRetryDoesNotClaimNewerEditsSynced() {
  resetState()
  const page = pageInstance()
  page.applyCheckedIds(new Set(['apple']), ['apple'])
  page.operationScope.conflictPending = true
  const retry = page.retrySync()
  await tick()
  assert.strictEqual(flushes.length, 1)
  page.applyCheckedIds(new Set(), ['apple'])
  flushes[0].resolve(userStore.data)
  await retry
  assert.strictEqual(page.data.pendingSync, true)
  assert.strictEqual(page.data.saving, false)
  assert.strictEqual(toasts.length, 0, '还有新操作待同步时不能弹出同步成功提示')
  assert.strictEqual(page.scheduledSyncs.at(-1), 80)
}

async function main() {
  await testNamespaceSwitchDropsOnlyPageOperations()
  await testPlanSwitchDropsOldPlanOperations()
  await testLateSaveCannotClearNewScope()
  await testFailedSaveKeepsChecksAndCanRetry()
  await testOfflineFailureAndRepeatedRetry()
  await testRetryWithoutPageOperationsReloadsOnce()
  await testReloadFailureWithExistingListStaysVisible()
  await testLateFailureCannotAffectNewScope()
  await testLateReloadCannotAffectNewScope()
  await testConflictRetryIncludesEditsMadeWhileReloading()
  await testConflictReloadFailureKeepsRecoveryVisible()
  await testLateConflictReloadCannotPatchNewScope()
  await testRemotePlanChangeEndsOldPlanStatus()
  await testNewEditsRemainPendingAfterEarlierSave()
  await testConflictRetryDoesNotClaimNewerEditsSynced()
  console.log('shopping operation scope and sync recovery tests passed (15 scenarios)')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
