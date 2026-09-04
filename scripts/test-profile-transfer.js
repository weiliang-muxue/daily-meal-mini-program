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
const modalTasks = []
const toastCalls = []
const cloudCalls = []
const deletionEvents = []

global.Page = (definition) => { pageDefinition = definition }
global.wx = {
  getStorageSync: () => null,
  setStorageSync: () => {},
  showModal(options) {
    modalCalls.push(options)
    const response = modalResponses.shift() || { confirm: false }
    const task = options.success(response)
    if (task && typeof task.then === 'function') modalTasks.push(task)
  },
  showLoading: () => {},
  hideLoading: () => {},
  showToast: (options) => toastCalls.push(options),
  reLaunch: () => {},
  getStorageInfoSync: () => ({ keys: [
    `meal_ai_task_v1_${'c'.repeat(32)}`,
    `meal_ai_task_v2_${'c'.repeat(32)}`,
    `meal_ai_task_v2_${'d'.repeat(32)}`,
  ] }),
  removeStorageSync(key) { deletionEvents.push(`cache:${key}`) },
  cloud: {
    callFunction: async (options) => {
      cloudCalls.push(options)
      if (options.name === 'privacy') deletionEvents.push('cloud:privacy')
      return { result: { success: false, code: 'TEST_FAILURE', message: '受控测试失败' } }
    },
  },
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
  page.data.profileLoading = false
  page.setData = (patch) => Object.assign(page.data, patch)
  return page
}

async function main() {
  membershipStore.save({ status: 'active', role: 'owner', cacheNamespace: 'c'.repeat(32) })
  const activeInviteRef = '1'.repeat(32)
  let activeInvites = [
    {
      inviteRef: activeInviteRef, label: '家人邀请', expiresAt: 2000000000000,
      codeHash: 'private-code-hash', createdBy: 'private-owner-id', usedBy: 'private-member-id',
    },
    { inviteRef: 'invalid-ref', label: '必须过滤', expiresAt: 2000000000000 },
  ]
  let summaryOverrides = { maxMembers: 4, inviteTtlHours: 168 }
  let listMembersCalls = 0
  membershipStore.listMembers = async () => {
    listMembersCalls += 1
    return {
      count: 3,
      members: [
        { role: 'owner', label: '管理员', memberRef: 'd'.repeat(32), openid: 'private-owner-id' },
        { role: 'member', label: '家人甲', memberRef: memberRefA, openid: 'private-member-a' },
        { role: 'member', displayName: '家人乙', memberRef: memberRefB, unionid: 'private-union-id' },
        { role: 'member', label: '非法引用', memberRef: 'not-valid', openid: 'must-be-dropped' },
      ],
      activeInvites,
      ...summaryOverrides,
    }
  }

  const page = makePage()
  await page.loadMembers()
  assert.strictEqual(page.data.membersState, 'ready')
  assert.strictEqual(page.data.memberCount, 3)
  assert.strictEqual(page.data.maxMembers, 4, '页面必须采用 listMembers 返回的默认 4 人容量')
  assert.strictEqual(page.data.inviteTtlHours, 168, '页面必须采用 listMembers 返回的默认 168 小时 TTL')
  assert.strictEqual(page.data.inviteTtlText, '7 天', '默认 168 小时必须友好显示为 7 天')
  assert.strictEqual(page.data.occupiedCount, 4, '待使用邀请必须占用成员容量')
  assert.strictEqual(page.data.inviteCapacityKnown, true)
  assert.deepStrictEqual(page.data.transferMembers, [
    { displayName: '家人甲', memberRef: memberRefA },
    { displayName: '家人乙', memberRef: memberRefB },
  ])
  assert.strictEqual(JSON.stringify(page.data.transferMembers).includes('openid'), false)
  assert.strictEqual(JSON.stringify(page.data.transferMembers).includes('unionid'), false)
  assert.strictEqual(JSON.stringify(page.data.transferMembers).includes('private-'), false)
  assert.deepStrictEqual(page.data.activeInvites, [{
    inviteRef: activeInviteRef,
    label: '家人邀请',
    expiresAt: 2000000000000,
    expiresText: '2033-05-18 11:33',
  }])
  const visibleInvites = JSON.stringify(page.data.activeInvites)
  ;['codeHash', 'createdBy', 'usedBy', 'private-', 'private-code-hash'].forEach((secret) => {
    assert.strictEqual(visibleInvites.includes(secret), false, `客户端邀请列表不得保留 ${secret}`)
  })

  summaryOverrides = { maxMembers: 6, inviteTtlHours: 30 }
  const configuredPage = makePage()
  await configuredPage.loadMembers()
  assert.strictEqual(configuredPage.data.maxMembers, 6, '页面必须采用 listMembers 返回的非默认容量')
  assert.strictEqual(configuredPage.data.inviteTtlHours, 30, '页面必须采用 listMembers 返回的非默认 TTL')
  assert.strictEqual(configuredPage.data.inviteTtlText, '30 小时', '非整天 TTL 必须按小时显示，不能模糊取整')

  summaryOverrides = {}
  const missingConfigPage = makePage()
  await missingConfigPage.loadMembers()
  assert.strictEqual(missingConfigPage.data.maxMembers, 4, '缺失容量必须回退到防御默认值')
  assert.strictEqual(missingConfigPage.data.inviteTtlHours, 168, '缺失 TTL 必须回退到防御默认值')
  assert.strictEqual(missingConfigPage.data.inviteTtlText, '7 天')

  summaryOverrides = { maxMembers: 0, inviteTtlHours: -1 }
  const invalidConfigPage = makePage()
  await invalidConfigPage.loadMembers()
  assert.strictEqual(invalidConfigPage.data.maxMembers, 4, '非法容量必须回退到防御默认值')
  assert.strictEqual(invalidConfigPage.data.inviteTtlHours, 168, '非法 TTL 必须回退到防御默认值')
  assert.strictEqual(invalidConfigPage.data.inviteTtlText, '7 天')
  summaryOverrides = { maxMembers: 4, inviteTtlHours: 168 }

  const revokeCalls = []
  membershipStore.revokeInvite = async (inviteRef) => {
    revokeCalls.push(inviteRef)
    activeInvites = []
    return { revoked: true }
  }
  const revokeModalBefore = modalCalls.length
  modalResponses.push({ confirm: false })
  await page.revokeInvite({ currentTarget: { dataset: { inviteRef: activeInviteRef } } })
  assert.strictEqual(modalCalls.length, revokeModalBefore + 1, '撤销邀请必须显示确认弹窗')
  assert.deepStrictEqual(revokeCalls, [], '取消确认不得调用撤销接口')

  modalResponses.push({ confirm: true })
  await page.revokeInvite({ currentTarget: { dataset: { inviteRef: activeInviteRef } } })
  assert.deepStrictEqual(revokeCalls, [activeInviteRef])
  assert.deepStrictEqual(page.data.activeInvites, [])
  assert.strictEqual(page.data.occupiedCount, 3)
  assert.strictEqual(page.data.revokingInviteRef, '')
  assert(toastCalls.some((item) => item.title === '邀请已撤销' && item.icon === 'success'))

  const createdInviteCode = 'C'.repeat(32)
  const createdInviteRef = '2'.repeat(32)
  const createInviteCalls = []
  let resolveCreateInvite
  membershipStore.createInvite = (label) => {
    createInviteCalls.push(label)
    return new Promise((resolve) => { resolveCreateInvite = resolve })
  }
  const createPage = makePage()
  createPage.setData({
    inviteLabel: '家人丙', inviteCapacityKnown: true, occupiedCount: 3, maxMembers: 4,
  })
  const listsBeforeCreate = listMembersCalls
  const createRequest = createPage.createInvite()
  const duplicateCreateRequest = createPage.createInvite()
  assert.deepStrictEqual(createInviteCalls, ['家人丙'], '连续点击创建只能发出一次请求')
  assert.strictEqual(createPage.data.creatingInvite, true, '创建请求期间必须持有按钮锁')

  activeInvites = [{
    inviteRef: createdInviteRef,
    label: '家人丙',
    expiresAt: 2000000000000,
    code: createdInviteCode,
    codeHash: 'private-created-code-hash',
  }]
  resolveCreateInvite({
    code: createdInviteCode,
    inviteRef: createdInviteRef,
    expiresAt: 2000000000000,
  })
  await Promise.all([createRequest, duplicateCreateRequest])
  assert.strictEqual(createPage.data.creatingInvite, false, '创建成功后必须释放按钮锁')
  assert.strictEqual(listMembersCalls, listsBeforeCreate + 1, '创建成功后必须刷新成员与邀请列表')
  assert.strictEqual(createPage.data.inviteCode, createdInviteCode, '仅创建页面实例应显示一次性明文邀请码')
  assert.strictEqual(createPage.data.inviteLabel, '', '创建成功后必须清空邀请备注')
  assert.strictEqual(JSON.stringify(createPage.data.activeInvites).includes(createdInviteCode), false,
    '刷新后的邀请列表不得保留明文邀请码')
  assert.strictEqual(JSON.stringify(createPage.data.activeInvites).includes('codeHash'), false,
    '刷新后的邀请列表不得保留邀请码哈希')

  const freshPage = makePage()
  await freshPage.loadMembers()
  assert.strictEqual(freshPage.data.inviteCode, '', '新页面加载邀请列表时不得恢复明文邀请码')
  assert.strictEqual(JSON.stringify(freshPage.data).includes(createdInviteCode), false,
    '明文邀请码不得进入其他页面实例')

  activeInvites = []
  const createFailureCalls = []
  let rejectCreateInvite
  membershipStore.createInvite = (label) => {
    createFailureCalls.push(label)
    return new Promise((resolve, reject) => { rejectCreateInvite = reject })
  }
  const failedCreatePage = makePage()
  failedCreatePage.setData({
    inviteLabel: '保留这个备注', inviteCapacityKnown: true, occupiedCount: 3, maxMembers: 4,
  })
  const listsBeforeFailedCreate = listMembersCalls
  const failedCreateRequest = failedCreatePage.createInvite()
  const duplicateFailedCreateRequest = failedCreatePage.createInvite()
  assert.deepStrictEqual(createFailureCalls, ['保留这个备注'], '失败中的重复点击也不得发出第二次请求')
  assert.strictEqual(failedCreatePage.data.creatingInvite, true)
  rejectCreateInvite(new Error('邀请码服务暂不可用'))
  await Promise.all([failedCreateRequest, duplicateFailedCreateRequest])
  assert.strictEqual(failedCreatePage.data.creatingInvite, false, '创建失败后必须释放按钮锁')
  assert.strictEqual(failedCreatePage.data.inviteLabel, '保留这个备注', '创建失败后必须保留邀请备注')
  assert.strictEqual(failedCreatePage.data.inviteCode, '', '创建失败不得显示或沿用明文邀请码')
  assert.strictEqual(listMembersCalls, listsBeforeFailedCreate, '创建失败不得刷新邀请列表')
  assert.deepStrictEqual(toastCalls.at(-1), { title: '邀请码服务暂不可用', icon: 'none' })

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

  assert.strictEqual(modalCalls.length, revokeModalBefore + 4, '撤销一次确认后，管理员转移必须再经过两次确认')
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

  async function verifyAllowedClear({ member, memberCount, membersState, inviteCapacityKnown, consequence }) {
    membershipStore.save({ status: 'active', role: member.role, cacheNamespace: 'c'.repeat(32) })
    const clearPage = makePage()
    clearPage.setData({ member, memberCount, membersState, inviteCapacityKnown })
    const modalBefore = modalCalls.length
    const cloudBefore = cloudCalls.length
    const deletionEventsBefore = deletionEvents.length
    modalResponses.push({ confirm: true }, { confirm: true })

    const request = clearPage.clearMyData()
    clearPage.clearMyData()
    await request

    const clearModals = modalCalls.slice(modalBefore)
    assert.strictEqual(clearModals.length, 2, '连续点击清空只能启动一次两次确认流程')
    assert(clearModals.every((item) => item.content.includes(consequence)), '确认弹窗必须准确说明身份后果')
    assert.deepStrictEqual(cloudCalls.slice(cloudBefore), [{
      name: 'privacy',
      data: {
        action: 'clearMyData',
        expectedCacheNamespace: 'c'.repeat(32),
      },
    }], '清空请求必须携带用户确认时的 cache namespace')
    assert.deepStrictEqual(deletionEvents.slice(deletionEventsBefore), [
      `cache:meal_ai_task_v1_${'c'.repeat(32)}`,
      `cache:meal_ai_task_v2_${'c'.repeat(32)}`,
      'cloud:privacy',
    ], '二次确认后必须先清除当前 namespace 的 v1/v2 私密缓存，再调用不可逆云删除')
    assert.strictEqual(clearPage.data.clearingData, false, '清空请求结束后必须恢复按钮状态')
  }

  await verifyAllowedClear({
    member: { status: 'active', role: 'member' },
    memberCount: 0,
    membersState: 'idle',
    inviteCapacityKnown: false,
    consequence: '退出当前成员资格',
  })
  await verifyAllowedClear({
    member: { status: 'active', role: 'owner' },
    memberCount: 1,
    membersState: 'empty',
    inviteCapacityKnown: true,
    consequence: '空管理员身份',
  })
  assert(toastCalls.some((item) => item.title === '受控测试失败' && item.icon === 'none'))

  const originalCloudCall = wx.cloud.callFunction
  const originalMembershipInit = membershipStore.init
  membershipStore.save({ status: 'active', role: 'member', cacheNamespace: 'c'.repeat(32) })
  membershipStore.init = async function initAfterLostResponse(options) {
    assert.deepStrictEqual(options, { force: true })
    this.member = { status: 'invite_required', cacheNamespace: '' }
    this.cacheNamespace = ''
    this.state = 'ready'
    return this.member
  }
  wx.cloud.callFunction = async (options) => {
    cloudCalls.push(options)
    if (options.name === 'privacy') deletionEvents.push('cloud:privacy-timeout')
    throw Object.assign(new Error('request timeout'), { errMsg: 'request:fail timeout' })
  }
  const lostResponsePage = makePage()
  lostResponsePage.setData({
    member: { status: 'active', role: 'member' },
    memberCount: 0,
    membersState: 'idle',
    inviteCapacityKnown: false,
  })
  modalResponses.push({ confirm: true }, { confirm: true })
  const lostResponseToastBefore = toastCalls.length
  await lostResponsePage.clearMyData()
  assert(toastCalls.slice(lostResponseToastBefore).some((item) => (
    item.title === '私人数据已清空' && item.icon === 'success'
  )), '云端完成但客户端响应丢失时，必须用新鲜成员状态确认完成')
  assert.strictEqual(lostResponsePage.data.clearingData, false)
  membershipStore.init = originalMembershipInit
  wx.cloud.callFunction = originalCloudCall

  const successPage = makePage()
  successPage.setData({
    member: { status: 'active', role: 'member' }, nickname: '私人昵称',
    profile: { nickname: '私人昵称', maskedPhone: '****8000' },
    avatarPreview: 'private-avatar-url', avatarLocalPath: 'private-local-avatar',
    activeInvites: [{ inviteRef: '3'.repeat(32), label: '私人备注' }],
    transferMembers: [{ displayName: '私人称呼', memberRef: memberRefA }],
    inviteCode: 'D'.repeat(32), memberCount: 3, occupiedCount: 4,
  })
  membershipStore.save({ status: 'active', role: 'member', cacheNamespace: 'c'.repeat(32) })
  wx.cloud.callFunction = async (options) => {
    cloudCalls.push(options)
    return { result: { success: true, data: { cleared: true } } }
  }
  const originalStorageInfo = wx.getStorageInfoSync
  wx.getStorageInfoSync = () => { throw new Error('storage enumeration unavailable') }
  modalResponses.push({ confirm: true }, { confirm: true })
  await successPage.clearMyData()
  assert.deepStrictEqual({
    profile: successPage.data.profile,
    nickname: successPage.data.nickname,
    avatarPreview: successPage.data.avatarPreview,
    avatarLocalPath: successPage.data.avatarLocalPath,
    activeInvites: successPage.data.activeInvites,
    transferMembers: successPage.data.transferMembers,
    inviteCode: successPage.data.inviteCode,
    member: successPage.data.member,
  }, {
    profile: {}, nickname: '', avatarPreview: '', avatarLocalPath: '',
    activeInvites: [], transferMembers: [], inviteCode: '', member: {},
  }, '云端删除成功后必须立即抹除资料页已渲染的私人字段，不依赖延迟跳转')
  assert(cloudCalls.some((item) => item.name === 'privacy'),
    '本地存储枚举失败不得阻断资料页云端删除')
  wx.getStorageInfoSync = originalStorageInfo
  wx.cloud.callFunction = originalCloudCall

  const ownerWithMembersPage = makePage()
  ownerWithMembersPage.setData({
    member: { status: 'active', role: 'owner' },
    memberCount: 2,
    membersState: 'ready',
    inviteCapacityKnown: true,
  })
  const ownerWithMembersModalBefore = modalCalls.length
  const ownerWithMembersCloudBefore = cloudCalls.length
  await ownerWithMembersPage.clearMyData()
  assert.strictEqual(modalCalls.length, ownerWithMembersModalBefore, '管理员有其他成员时不能进入清空确认')
  assert.strictEqual(cloudCalls.length, ownerWithMembersCloudBefore, '管理员交接前不能请求清空')
  assert.deepStrictEqual(toastCalls.at(-1), { title: '请先完成管理员交接', icon: 'none' })

  const unknownMembersPage = makePage()
  unknownMembersPage.setData({
    member: { status: 'active', role: 'owner' },
    memberCount: 1,
    membersState: 'loading',
    inviteCapacityKnown: false,
  })
  const unknownModalBefore = modalCalls.length
  const unknownCloudBefore = cloudCalls.length
  await unknownMembersPage.clearMyData()
  assert.strictEqual(modalCalls.length, unknownModalBefore, '成员状态未知时不能进入清空确认')
  assert.strictEqual(cloudCalls.length, unknownCloudBefore, '成员状态未知时不能请求清空')
  assert.deepStrictEqual(toastCalls.at(-1), { title: '请先刷新成员状态', icon: 'none' })

  membershipStore.listMembers = async () => ({ count: 1, maxMembers: 4, activeInvites: [], members: [
    { role: 'owner', label: '管理员', memberRef: 'd'.repeat(32) },
  ] })
  membershipStore.save({ status: 'active', role: 'owner', cacheNamespace: 'c'.repeat(32) })
  const emptyPage = makePage()
  await emptyPage.loadMembers()
  assert.strictEqual(emptyPage.data.membersState, 'empty')
  assert.deepStrictEqual(emptyPage.data.transferMembers, [])
  assert.deepStrictEqual(emptyPage.data.activeInvites, [])

  const profileWxml = require('fs').readFileSync(path.join(root, 'miniprogram/pages/profile/profile.wxml'), 'utf8')
  const profileWxss = require('fs').readFileSync(path.join(root, 'miniprogram/pages/profile/profile.wxss'), 'utf8')
  assert(profileWxml.includes('bindtap="revokeInvite"') && profileWxml.includes('确认撤销') === false,
    '资料页必须提供撤销入口，确认文案应由原生弹窗提供')
  assert(profileWxml.includes('occupiedCount >= maxMembers'), '创建邀请容量判断必须包含待使用邀请')
  assert(profileWxml.includes('总容量 {{maxMembers}} 人') && profileWxml.includes('创建 {{inviteTtlText}}后失效'),
    '邀请说明必须动态展示服务端容量与 TTL')
  assert(!profileWxml.includes('默认总容量 4 人') && !profileWxml.includes('创建 7 天后失效'),
    '邀请说明不得继续写死默认服务配置')
  assert(/\.invite-revoke[^}]*min-height:\s*(?:88rpx|4[48]px|9[0-9]rpx)/.test(profileWxss),
    '撤销按钮触控高度不得小于 44px')

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
