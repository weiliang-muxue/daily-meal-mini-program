'use strict'

const assert = require('assert')
const path = require('path')

const root = path.resolve(__dirname, '..')
const shoppingPath = path.join(root, 'miniprogram', 'pages', 'shopping', 'shopping.js')
const userStorePath = path.join(root, 'miniprogram', 'services', 'user-store.js')
const authStorePath = path.join(root, 'miniprogram', 'services', 'auth-store.js')
const membershipStorePath = path.join(root, 'miniprogram', 'services', 'membership-store.js')

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
const userStore = {
  data: { activePlanId: 'plan-a', activePlan: plan('plan-a', 'apple'), checkedShoppingIds: [] },
  state: 'ready',
  error: '',
  init: async () => userStore.data,
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
  reLaunch() {}, stopPullDownRefresh() {}, showToast() {}, showModal() {}, navigateTo() {}, switchTab() {},
}

delete require.cache[shoppingPath]
require(shoppingPath)

function pageInstance() {
  const page = {
    ...pageDefinition,
    data: JSON.parse(JSON.stringify(pageDefinition.data)),
    setData(partial) { this.data = { ...this.data, ...partial } },
    scheduleSync() {},
  }
  page.ensureOperationScope()
  return page
}

function resetState() {
  membershipStore.cacheNamespace = namespaceA
  userStore.data = { activePlanId: 'plan-a', activePlan: plan('plan-a', 'apple'), checkedShoppingIds: [] }
  userStore.state = 'ready'
  patchCalls.length = 0
  flushes.length = 0
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

async function main() {
  await testNamespaceSwitchDropsOnlyPageOperations()
  await testPlanSwitchDropsOldPlanOperations()
  await testLateSaveCannotClearNewScope()
  console.log('shopping operation scope tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
