'use strict'

const assert = require('assert')
const path = require('path')

const root = path.resolve(__dirname, '..')
const pagePath = path.join(root, 'miniprogram', 'pages', 'plan-history', 'plan-history.js')
const membershipPath = path.join(root, 'miniprogram', 'services', 'membership-store.js')
const userStorePath = path.join(root, 'miniprogram', 'services', 'user-store.js')

let pageDefinition
const modals = []
const modalResponses = []
const membershipStore = { init: async () => ({ status: 'active' }) }
const userStore = {
  state: 'ready',
  error: '',
  data: { planHistory: [] },
  init: async () => userStore.data,
  restoreHistory: async () => userStore.data,
}

require.cache[membershipPath] = {
  id: membershipPath, filename: membershipPath, loaded: true, exports: { membershipStore },
}
require.cache[userStorePath] = {
  id: userStorePath, filename: userStorePath, loaded: true, exports: { userStore },
}

global.Page = (definition) => { pageDefinition = definition }
global.wx = {
  showModal(options) {
    modals.push(options)
    if (options.success) options.success(modalResponses.shift() || { confirm: false })
  },
  showToast() {},
  switchTab() {},
  reLaunch() {},
  stopPullDownRefresh() {},
}

delete require.cache[pagePath]
require(pagePath)

function plan(index) {
  return {
    id: `history-${index}`,
    title: `Plan ${index}`,
    source: 'ai',
    planVersion: 1,
    contractVersion: 1,
    generatedAt: '2026-08-26T00:00:00.000Z',
    days: [{
      id: `history-${index}-day`,
      date: '2026-09-01',
      name: 'Day 1',
      meals: [{ id: `history-${index}-meal`, type: 'breakfast', scenario: 'default', title: 'Meal' }],
    }],
  }
}

function makePage() {
  const page = Object.create(pageDefinition)
  page.data = JSON.parse(JSON.stringify(pageDefinition.data))
  page.setData = (partial) => Object.assign(page.data, partial)
  return page
}

async function main() {
  userStore.data = { planHistory: Array.from({ length: 20 }, (_, index) => plan(index + 1)) }
  const page = makePage()
  page.render()
  assert.strictEqual(page.data.plans.length, 20, 'history UI must display all stored plans')
  assert.strictEqual(page.data.historyCapacity, 64)

  const target = page.data.plans[19]
  const restored = []
  userStore.restoreHistory = async (planId) => { restored.push(planId); return userStore.data }
  modalResponses.push({ confirm: true }, { confirm: true })
  await page.restorePlan({ currentTarget: { dataset: { id: target.id } } })
  assert.deepStrictEqual(restored, [target.id], 'a plan beyond the former five-item view must be restorable')
  assert(modals[0].content.includes('恢复这份计划自己的采购勾选和晚餐选择'))

  const historyLimit = new Error('历史计划已达 64 份上限。为避免删除旧计划，本次计划更新未生效，请完成分页归档后重试')
  historyLimit.code = 'STATE_HISTORY_LIMIT'
  userStore.restoreHistory = async () => { throw historyLimit }
  modalResponses.push({ confirm: true }, { confirm: true })
  await page.restorePlan({ currentTarget: { dataset: { id: target.id } } })
  const failure = modals[modals.length - 1]
  assert.strictEqual(failure.title, '恢复失败')
  assert(failure.content.includes('64 份上限'))
  assert(failure.content.includes('当前计划没有变化'))

  let restoreAttempts = 0
  let refreshOptions = null
  const conflict = new Error('state changed on another device')
  conflict.code = 'STATE_REVISION_CONFLICT'
  userStore.restoreHistory = async () => { restoreAttempts += 1; throw conflict }
  userStore.init = async (options) => { refreshOptions = options; return userStore.data }
  modalResponses.push({ confirm: true }, { confirm: true })
  await page.restorePlan({ currentTarget: { dataset: { id: target.id } } })
  const conflictModal = modals[modals.length - 1]
  assert.strictEqual(restoreAttempts, 1, 'revision conflict must not trigger an automatic overwrite retry')
  assert.deepStrictEqual(refreshOptions, { force: true })
  assert.strictEqual(conflictModal.title, '计划历史已变化')
  assert(conflictModal.content.includes('当前计划没有被替换'))

  console.log('plan history page tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
