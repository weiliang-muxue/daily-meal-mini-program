'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const profilePath = path.join(root, 'miniprogram', 'pages', 'profile', 'profile.js')
let pageDefinition
global.Page = (definition) => { pageDefinition = definition }
global.wx = {
  getStorageSync: () => null,
  setStorageSync: () => {},
  getStorageInfoSync: () => ({ keys: [] }),
  removeStorageSync: () => {},
}
require(profilePath)
const { membershipStore } = require('../miniprogram/services/membership-store')

const ownerRef = 'a'.repeat(32)
const memberRef = 'b'.repeat(32)
const namespace = 'c'.repeat(32)
const joinedAt = Date.parse('2026-09-21T01:02:00Z')

function makePage() {
  const page = Object.create(pageDefinition)
  page.data = JSON.parse(JSON.stringify(pageDefinition.data))
  page.data.profileLoading = false
  page.setData = (patch) => Object.assign(page.data, patch)
  return page
}

function setOwner(cacheNamespace = namespace) {
  membershipStore.save({ status: 'active', role: 'owner', cacheNamespace })
}

function summary(members) {
  return { members, count: members.length, activeInvites: [], maxMembers: 4, inviteTtlHours: 168 }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function main() {
  setOwner()
  const knownMembers = summary([
    {
      memberRef: ownerRef, role: 'owner', label: '管理员', displayName: '  管理者甲  ',
      joinedAt, joinSource: 'owner', inviterLabel: '不应展示的来源', invitationLabel: '不应展示的备注',
      openid: 'private-owner', phone: 'private-phone', avatarUrl: 'private-avatar', health: { weight: 50 },
    },
    {
      memberRef: memberRef.toUpperCase(), role: 'member', label: '家人邀请', displayName: '小林',
      joinedAt: '2026-09-20T23:10:00-07:00', joinSource: 'invite', inviterLabel: '原管理员甲', invitationLabel: '家人邀请',
      _id: 'private-document', unionid: 'private-union', createdBy: 'private-creator',
      inviteId: 'private-invite', codeHash: 'private-hash', code: 'private-code', nickname: 'private-extra-nickname',
    },
    { memberRef, role: 'member', displayName: '重复成员必须丢弃', joinSource: 'invite' },
    { memberRef: 'not-valid', role: 'member', displayName: '非法引用必须丢弃' },
    { memberRef: 'd'.repeat(32), role: 'unexpected', displayName: '非法身份必须丢弃' },
  ])
  membershipStore.listMembers = async () => ({ ...knownMembers, count: 2 })
  const page = makePage()
  await page.loadMembers()
  assert.strictEqual(page.data.joinedMembersState, 'ready')
  assert.deepStrictEqual(page.data.joinedMembers, [
    {
      memberRef: ownerRef, displayName: '管理者甲', role: 'owner', roleLabel: '管理员',
      joinedText: '2026-09-21 09:02（北京时间）', inviterLabel: '无需邀请加入', invitationLabel: '无需邀请',
    },
    {
      memberRef, displayName: '小林', role: 'member', roleLabel: '普通成员',
      joinedText: '2026-09-21 14:10（北京时间）', inviterLabel: '原管理员甲', invitationLabel: '家人邀请',
    },
  ], '成员展示只保留安全字段，昵称优先并正确转换北京时间')
  assert(!JSON.stringify(page.data.joinedMembers).includes('private-'), '成员展示不得保留身份、手机号、头像或健康数据')
  assert(page.data.transferMembers.every((item) => item.memberRef === memberRef), '管理员只能出现在已加入列表，不能进入接任候选')
  assert(page.data.transferMembers.every((item) => Object.keys(item).sort().join(',') === 'displayName,memberRef'),
    '管理员交接列表不能混入邀请关系展示字段')

  membershipStore.listMembers = async () => summary([
    { memberRef: ownerRef, role: 'owner', label: '当前管理员', joinedAt: null, joinSource: 'legacy', inviterLabel: '不能据身份猜测的邀请人', invitationLabel: '旧邀请备注' },
    { memberRef, role: 'member', label: '家人备注', displayName: '  ', joinedAt: 0, joinSource: 'invite', inviterLabel: '原邀请人已退出' },
    { memberRef: 'd'.repeat(32), role: 'member', displayName: {}, label: {}, joinedAt: '', joinSource: 'unsupported' },
  ])
  const legacyPage = makePage()
  await legacyPage.loadMembers()
  assert.deepStrictEqual(legacyPage.data.joinedMembers.map((item) => ({
    displayName: item.displayName, inviterLabel: item.inviterLabel, invitationLabel: item.invitationLabel, joinedText: item.joinedText,
  })), [
    { displayName: '当前管理员', inviterLabel: '邀请人信息未记录', invitationLabel: '旧邀请备注', joinedText: '加入时间未记录' },
    { displayName: '家人备注', inviterLabel: '原邀请人已退出', invitationLabel: '未填写', joinedText: '加入时间未记录' },
    { displayName: '受邀成员', inviterLabel: '邀请人信息未记录', invitationLabel: '未记录', joinedText: '加入时间未记录' },
  ], '历史记录不能把当前管理员猜成邀请人；已知旧备注仍可展示')

  const invalidDates = [null, undefined, '', false, 0, -1, NaN, Infinity, {}, [], 'bad-date', '2026-09-21 09:00:00', '2026-09-21', '2026-99-99T00:00:00Z']
  membershipStore.listMembers = async () => summary(invalidDates.map((value, index) => ({
    memberRef: (index + 1).toString(16).padStart(32, '0'), role: 'member', joinedAt: value,
  })))
  const datePage = makePage()
  await datePage.loadMembers()
  assert(datePage.data.joinedMembers.every((item) => item.joinedText === '加入时间未记录'),
    '缺失、无效和未注明时区的时间不能被显示为 1970 或按设备时区猜测')

  membershipStore.listMembers = async () => summary([{ memberRef: ownerRef, role: 'owner', joinSource: 'owner', joinedAt }])
  const onlyOwner = makePage()
  await onlyOwner.loadMembers()
  assert.strictEqual(onlyOwner.data.joinedMembersState, 'ready', '仅有管理员时，已加入成员列表仍必须展示管理员')
  assert.strictEqual(onlyOwner.data.joinedMembers.length, 1)
  assert.strictEqual(onlyOwner.data.membersState, 'empty', '仅有管理员时，管理员交接仍独立显示无接任成员')
  assert.deepStrictEqual(onlyOwner.data.transferMembers, [])
  membershipStore.listMembers = async () => summary([])
  await onlyOwner.loadMembers()
  assert.strictEqual(onlyOwner.data.joinedMembersState, 'empty')
  assert.strictEqual(onlyOwner.data.memberCount, 0, '空响应不能虚构一个管理员成员')

  membershipStore.listMembers = async () => knownMembers
  await page.loadMembers()
  const reload = deferred()
  membershipStore.listMembers = () => reload.promise
  const reloadRequest = page.loadMembers()
  assert.strictEqual(page.data.joinedMembersState, 'loading')
  assert.deepStrictEqual(page.data.joinedMembers, [], '刷新期间不能继续宣称旧名单为当前成员')
  assert.strictEqual(page.data.inviteCapacityKnown, false)
  reload.reject(new Error('网络连接失败，请稍后重试'))
  await reloadRequest
  assert.strictEqual(page.data.joinedMembersState, 'error')
  assert.deepStrictEqual(page.data.joinedMembers, [])
  assert.strictEqual(page.data.memberCount, 0)
  assert.deepStrictEqual(page.data.transferMembers, [])
  membershipStore.listMembers = async () => summary([{ memberRef: ownerRef, role: 'owner' }])
  await page.retryMembers()
  assert.strictEqual(page.data.joinedMembersState, 'ready', '失败后必须能重试恢复')

  let ordinaryRequests = 0
  membershipStore.listMembers = async () => { ordinaryRequests += 1; return knownMembers }
  membershipStore.save({ status: 'active', role: 'member', cacheNamespace: namespace })
  await page.loadMembers()
  assert.strictEqual(ordinaryRequests, 0, '普通成员不能请求他人的成员列表')
  assert.strictEqual(page.data.joinedMembersState, 'idle')
  assert.deepStrictEqual(page.data.joinedMembers, [])
  page.setData({ joinedMembers: [{ displayName: '旧成员' }], joinedMembersState: 'ready' })
  page.render()
  assert.deepStrictEqual(page.data.joinedMembers, [], '身份变更后的页面重绘必须清掉旧成员投影')

  setOwner()
  const changedRole = deferred()
  membershipStore.listMembers = () => changedRole.promise
  const changedRolePage = makePage()
  const changedRoleRequest = changedRolePage.loadMembers()
  membershipStore.save({ status: 'active', role: 'member', cacheNamespace: namespace })
  changedRole.resolve(knownMembers)
  await changedRoleRequest
  assert.deepStrictEqual(changedRolePage.data.joinedMembers, [], '在途响应不能在失去管理员身份后重新展示成员')
  assert.strictEqual(changedRolePage.data.joinedMembersState, 'idle')

  setOwner()
  const changedNamespace = deferred()
  membershipStore.listMembers = () => changedNamespace.promise
  const changedNamespacePage = makePage()
  const changedNamespaceRequest = changedNamespacePage.loadMembers()
  setOwner('e'.repeat(32))
  changedNamespace.resolve(knownMembers)
  await changedNamespaceRequest
  assert.deepStrictEqual(changedNamespacePage.data.joinedMembers, [], '旧身份命名空间的响应不能进入新身份')

  setOwner()
  const older = deferred()
  const newer = deferred()
  let pendingCount = 0
  membershipStore.listMembers = () => (++pendingCount === 1 ? older.promise : newer.promise)
  const racePage = makePage()
  const oldRequest = racePage.loadMembers()
  const newRequest = racePage.loadMembers()
  newer.reject(new Error('新请求失败，请重试'))
  await newRequest
  older.resolve(knownMembers)
  await oldRequest
  assert.strictEqual(racePage.data.joinedMembersState, 'error', '旧请求成功不能覆盖较新刷新失败，伪装为最新成员名单')
  assert.deepStrictEqual(racePage.data.joinedMembers, [])

  const clearPage = makePage()
  clearPage.setData({ joinedMembers: [{ displayName: '待清空的私人昵称' }], joinedMembersState: 'ready' })
  clearPage.clearRenderedPrivateData()
  assert.deepStrictEqual(clearPage.data.joinedMembers, [], '清空私人数据时必须同时清掉已渲染成员')
  assert.strictEqual(clearPage.data.joinedMembersState, 'idle')

  const returnPage = makePage()
  let returnRefreshes = 0
  returnPage.loadMembers = () => { returnRefreshes += 1 }
  returnPage.onShow()
  assert.strictEqual(returnRefreshes, 1, '管理员返回资料页时应刷新已加入成员')
  returnPage.data.profileLoading = true
  returnPage.onShow()
  assert.strictEqual(returnRefreshes, 1, '初次资料初始化期间不能重复请求成员列表')

  const profileWxml = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/profile.wxml'), 'utf8')
  const profileWxss = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/profile.wxss'), 'utf8')
  const adminBlock = profileWxml.indexOf('<block wx:if="{{member.role === \'owner\'}}">')
  const joinedStart = profileWxml.indexOf('<text class="section-title">已加入成员</text>')
  const invitesStart = profileWxml.indexOf('<text class="section-title">邀请成员</text>')
  const transferStart = profileWxml.indexOf('<text class="section-title">管理员交接</text>')
  assert(adminBlock >= 0 && joinedStart > adminBlock && joinedStart < invitesStart && invitesStart < transferStart,
    '已加入成员必须是管理员区域的独立章节，不能隐藏在管理员交接里')
  const joinedMarkup = profileWxml.slice(joinedStart, invitesStart)
  for (const field of ['displayName', 'roleLabel', 'joinedText', 'inviterLabel', 'invitationLabel']) {
    assert(joinedMarkup.includes(`{{item.${field}}}`), `已加入成员必须展示 ${field}`)
  }
  assert(!joinedMarkup.includes('{{item.memberRef}}') && !/phone|avatar|openid|unionid|health|codeHash/.test(joinedMarkup),
    '已加入成员行不显示成员引用或任何私人字段')
  assert(joinedMarkup.includes('重新加载') && joinedMarkup.includes('暂无可展示的成员') && joinedMarkup.includes('正在加载已加入成员'),
    '已加入成员必须提供加载、空白和可重试错误反馈')
  assert(/\.joined-members-refresh\s*\{[^}]*max-width:\s*72px/.test(profileWxss),
    'refresh must not expand to the platform default button width')
  assert(/\.joined-members-refresh, \.joined-members-retry\s*\{[^}]*min-height:\s*48px/.test(profileWxss),
    '新刷新和重试按钮触控高度必须至少 48px')
  assert(/\.joined-member-value\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/.test(profileWxss),
    '成员长昵称和邀请备注必须在窄屏内换行')
  console.log('profile invitation relationship tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
