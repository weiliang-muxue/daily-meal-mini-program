'use strict'

const assert = require('assert')
const path = require('path')

const root = path.resolve(__dirname, '..')
const profilePath = path.join(root, 'miniprogram', 'pages', 'profile', 'profile.js')
const membershipPath = path.join(root, 'miniprogram', 'services', 'membership-store.js')
const userStorePath = path.join(root, 'miniprogram', 'services', 'user-store.js')

let pageDefinition
const modalResponses = []
const modalCalls = []
const toastCalls = []

global.Page = (definition) => { pageDefinition = definition }
global.wx = {
  getStorageSync: () => null,
  setStorageSync: () => {},
  showModal(options) {
    modalCalls.push(options)
    const response = modalResponses.shift() || { confirm: false }
    options.success(response)
  },
  showLoading: () => {},
  hideLoading: () => {},
  showToast: (options) => toastCalls.push(options),
}

delete require.cache[profilePath]
const profileUserStore = require(userStorePath).userStore
require(profilePath)
assert(pageDefinition, '资料页必须完成 Page 注册')

const { membershipStore } = require(membershipPath)
const memberRefA = 'a'.repeat(32)
const memberRefB = 'b'.repeat(32)

function makePage() {
  const page = Object.create(pageDefinition)
  page.data = JSON.parse(JSON.stringify(pageDefinition.data))
  page.setData = (patch) => Object.assign(page.data, patch)
  return page
}

async function main() {
  membershipStore.member = { status: 'active', role: 'owner', cacheNamespace: 'c'.repeat(32) }
  membershipStore.listMembers = async () => ({
    count: 3,
    maxMembers: 7,
    members: [
      { role: 'owner', label: '管理员', memberRef: 'd'.repeat(32), openid: 'private-owner-id' },
      { role: 'member', label: '家人甲', memberRef: memberRefA, openid: 'private-member-a' },
      { role: 'member', displayName: '家人乙', memberRef: memberRefB, unionid: 'private-union-id' },
      { role: 'member', label: '非法引用', memberRef: 'not-valid', openid: 'must-be-dropped' },
    ],
  })

  const page = makePage()
  await page.loadMembers()
  assert.strictEqual(page.data.membersState, 'ready')
  assert.strictEqual(page.data.memberCount, 3)
  assert.strictEqual(page.data.maxMembers, 7)
  assert.deepStrictEqual(page.data.transferMembers, [
    { displayName: '家人甲', memberRef: memberRefA },
    { displayName: '家人乙', memberRef: memberRefB },
  ])
  assert.strictEqual(JSON.stringify(page.data.transferMembers).includes('openid'), false)
  assert.strictEqual(JSON.stringify(page.data.transferMembers).includes('unionid'), false)
  assert.strictEqual(JSON.stringify(page.data.transferMembers).includes('private-'), false)

  page.selectTransferMember({ detail: { value: memberRefA } })
  assert.strictEqual(page.data.selectedMemberRef, memberRefA)

  const transferCalls = []
  membershipStore.transferOwner = async (...args) => {
    transferCalls.push(args)
    membershipStore.member = { status: 'active', role: 'member', cacheNamespace: 'c'.repeat(32) }
    return membershipStore.member
  }
  modalResponses.push({ confirm: true }, { confirm: true })
  await page.transferOwner()

  assert.strictEqual(modalCalls.length, 2, '管理员转移必须经过两次确认')
  assert.deepStrictEqual(transferCalls, [[memberRefA, true]])
  assert.strictEqual(page.data.member.role, 'member')
  assert.deepStrictEqual(page.data.transferMembers, [])
  assert.strictEqual(page.data.membersState, 'idle')
  assert.strictEqual(page.data.selectedMemberRef, '')
  assert.strictEqual(page.data.transferringOwner, false)
  assert(toastCalls.some((item) => item.title === '管理员已转移' && item.icon === 'success'))

  membershipStore.member = { status: 'active', role: 'owner', cacheNamespace: 'c'.repeat(32) }
  const cancelledPage = makePage()
  cancelledPage.setData({
    transferMembers: [{ displayName: '家人甲', memberRef: memberRefA }],
    membersState: 'ready', selectedMemberRef: memberRefA,
  })
  modalResponses.push({ confirm: false })
  const callsBeforeCancel = transferCalls.length
  await cancelledPage.transferOwner()
  assert.strictEqual(transferCalls.length, callsBeforeCancel, '任一次确认取消都不能调用转移接口')

  membershipStore.listMembers = async () => ({ count: 1, maxMembers: 7, members: [
    { role: 'owner', label: '管理员', memberRef: 'd'.repeat(32) },
  ] })
  const emptyPage = makePage()
  await emptyPage.loadMembers()
  assert.strictEqual(emptyPage.data.membersState, 'empty')
  assert.deepStrictEqual(emptyPage.data.transferMembers, [])

  const retryPage = makePage()
  const connectCalls = []
  retryPage.connect = async (force) => { connectCalls.push(force) }
  retryPage.setData({ authState: 'ready' })
  await retryPage.retryLogin()
  retryPage.setData({ authState: 'connecting' })
  await retryPage.retryLogin()
  retryPage.setData({ authState: 'offline' })
  await retryPage.retryLogin()
  assert.deepStrictEqual(connectCalls, [true], '只有离线状态允许触发身份重连')

  const settingsPage = makePage()
  profileUserStore.data = {
    ...profileUserStore.data,
    settings: { calciumAnchorReminder: false, vitaminDReminder: false },
  }
  profileUserStore.patch = async (partial, options) => {
    assert.deepStrictEqual(options, { immediate: true })
    profileUserStore.data = { ...profileUserStore.data, ...partial }
    profileUserStore.state = 'offline'
    profileUserStore.error = '网络不可用'
    throw new Error('网络不可用')
  }
  settingsPage.render = pageDefinition.render.bind(settingsPage)
  await settingsPage.toggleHealthSetting({
    currentTarget: { dataset: { key: 'calciumAnchorReminder' } },
    detail: { value: true },
  })
  assert.strictEqual(profileUserStore.data.settings.calciumAnchorReminder, true,
    '提醒保存失败后 user-store 中的本机 pending 值不能回滚')
  assert.strictEqual(settingsPage.data.settings.calciumAnchorReminder, true,
    '资料页失败后必须继续显示待重试值')
  assert.strictEqual(settingsPage.data.savingSettings, false)
  assert(toastCalls.some((item) => item.title === '网络不可用'))

  console.log('profile owner transfer tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
