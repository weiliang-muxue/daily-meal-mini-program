'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const profilePath = path.join(root, 'miniprogram', 'pages', 'profile', 'profile.js')
let pageDefinition
const toastCalls = []
const storageWrites = []
global.Page = (definition) => { pageDefinition = definition }
global.wx = {
  getStorageSync: () => null,
  setStorageSync: (key, value) => storageWrites.push({ key, value }),
  getStorageInfoSync: () => ({ keys: [] }),
  removeStorageSync: () => {},
  showToast: (options) => toastCalls.push(options),
}
require(profilePath)
const { MembershipStore, membershipStore } = require('../miniprogram/services/membership-store')

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
  return { members, count: members.length, activeInvites: [], maxMembers: 11, inviteTtlHours: 168 }
}

function memberEvent(memberRef) { return { currentTarget: { dataset: { memberRef } } } }

function inputNote(page, value) { page.inputMemberNote({ detail: { value } }) }

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
      phoneStatus: 'available', maskedPhone: '****1234',
    },
    {
      memberRef: memberRef.toUpperCase(), role: 'member', label: '家人邀请', displayName: '小林',
      joinedAt: '2026-09-20T23:10:00-07:00', joinSource: 'invite', inviterLabel: '原管理员甲', invitationLabel: '家人邀请',
      adminNote: '  成员专属备注  ', adminNoteUpdatedAt: joinedAt,
      phoneStatus: 'consent_required', maskedPhone: '****9999',
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
      adminNote: '', phoneText: '****1234',
    },
    {
      memberRef, displayName: '小林', role: 'member', roleLabel: '普通成员',
      joinedText: '2026-09-21 14:10（北京时间）', inviterLabel: '原管理员甲', invitationLabel: '家人邀请',
      adminNote: '成员专属备注', phoneText: '待成员确认',
    },
  ], '成员展示只保留安全字段，昵称优先并正确转换北京时间')
  assert(!JSON.stringify(page.data.joinedMembers).includes('private-'), '成员展示不得保留身份、完整手机号、头像或健康数据')
  assert(!JSON.stringify(page.data.joinedMembers).includes('9999'), '未确认隐私说明不能在页面数据保留尾号')
  assert(page.data.transferMembers.every((item) => item.memberRef === memberRef), '管理员只能出现在已加入列表，不能进入接任候选')
  assert(page.data.transferMembers.every((item) => Object.keys(item).sort().join(',') === 'displayName,memberRef'),
    '管理员交接列表不能混入邀请关系展示字段')
  assert.strictEqual(page.data.maxMembers, 11, '默认容量应为 10 位受邀成员加 1 位管理员')
  assert.strictEqual(page.data.maxMemberNoteLength, 100)
  assert.strictEqual(makePage().data.maxMembers, 11, '客户端防御默认值也必须为 11 人')

  const phonePage = makePage()
  for (const [phoneStatus, maskedPhone, expected] of [
    ['available', '****0000', '****0000'], ['available', '12345678901', '暂不可用'],
    ['available', '****1234\n', '暂不可用'], ['available', ['****1234'], '暂不可用'],
    ['available', null, '暂不可用'], ['unbound', '****1234', '未绑定'],
    ['consent_required', '****1234', '待成员确认'], ['unavailable', '****1234', '暂不可用'],
    [undefined, '****1234', '暂不可用'],
  ]) {
    membershipStore.listMembers = async () => summary([{ memberRef, role: 'member', phoneStatus, maskedPhone }])
    await phonePage.loadMembers()
    assert.strictEqual(phonePage.data.joinedMembers[0].phoneText, expected)
    assert.strictEqual(Object.hasOwn(phonePage.data.joinedMembers[0], 'maskedPhone'), false, '页面只保留已验证的显示字段')
  }
  membershipStore.listMembers = async () => knownMembers

  const cloudCalls = []
  wx.cloud = { callFunction: async (options) => {
    cloudCalls.push(options)
    return { result: { success: true, data: { updated: true, memberRef } } }
  } }
  await new MembershipStore().setMemberNote(memberRef, '接口合成备注')
  assert.deepStrictEqual(cloudCalls, [{ name: 'membership', data: { action: 'setMemberNote', memberRef, note: '接口合成备注' } }],
    '备注必须调用独立的 setMemberNote action，只提交成员引用和备注')

  const notePage = makePage()
  await notePage.loadMembers()
  notePage.editMemberNote(memberEvent(memberRef))
  assert.strictEqual(notePage.data.memberNoteDraft, '成员专属备注')
  inputNote(notePage, '取消的草稿')
  notePage.cancelMemberNote()
  assert.strictEqual(notePage.data.memberNoteDraft, '')
  assert.strictEqual(notePage.data.editingMemberRef, '')
  assert.strictEqual(notePage.data.joinedMembers[1].adminNote, '成员专属备注', '取消不能改动已确认备注')
  notePage.editMemberNote(memberEvent(memberRef))
  inputNote(notePage, '  合成新备注😀  ')
  const saveCalls = []
  const saving = deferred()
  const noteRefresh = deferred()
  let noteRefreshes = 0
  membershipStore.setMemberNote = (ref, note) => {
    saveCalls.push({ ref, note })
    return saving.promise
  }
  membershipStore.listMembers = () => { noteRefreshes += 1; return noteRefresh.promise }
  const saveRequest = notePage.saveMemberNote()
  const duplicateSave = notePage.saveMemberNote()
  assert.strictEqual(notePage.data.savingMemberNote, true)
  assert.deepStrictEqual(saveCalls, [{ ref: memberRef, note: '合成新备注😀' }], '保存应修剪首尾空格且防止重复提交')
  notePage.cancelMemberNote()
  notePage.editMemberNote(memberEvent(ownerRef))
  assert.strictEqual(notePage.data.editingMemberRef, memberRef, '保存期间不能切换编辑对象或取消锁')
  saving.resolve({ updated: true, memberRef, adminNote: '不能信任写入响应里的备注' })
  await Promise.resolve()
  assert.strictEqual(noteRefreshes, 1, '备注保存后必须重新调用管理员 listMembers 验证权限')
  assert.deepStrictEqual(notePage.data.joinedMembers, [], '重验权限期间不得乐观展示提交的备注或旧列表')
  assert.strictEqual(notePage.data.memberNoteDraft, '')
  const savedSummary = summary([
    knownMembers.members[0],
    { ...knownMembers.members[1], displayName: '昵称已更新', adminNote: '合成新备注😀' },
  ])
  noteRefresh.resolve(savedSummary)
  await Promise.all([saveRequest, duplicateSave])
  assert.strictEqual(notePage.data.joinedMembers[1].adminNote, '合成新备注😀')
  assert.strictEqual(notePage.data.joinedMembers[1].displayName, '昵称已更新', '昵称改变后仍应按稳定成员编号对应备注')
  assert.strictEqual(notePage.data.joinedMembers[1].invitationLabel, '家人邀请', '成员备注不能覆盖原邀请备注')
  assert(!JSON.stringify(notePage.data).includes('不能信任写入响应里的备注'))
  assert.strictEqual(notePage.data.savingMemberNote, false)
  assert.strictEqual(toastCalls.at(-1).title, '成员备注已保存')

  const retryNote = '保存失败后可重试的草稿'
  membershipStore.setMemberNote = async () => { throw new Error('网络连接失败') }
  notePage.editMemberNote(memberEvent(memberRef))
  inputNote(notePage, retryNote)
  await notePage.saveMemberNote()
  assert.strictEqual(notePage.data.memberNoteDraft, retryNote, '可重试错误应保留编辑草稿')
  assert.strictEqual(notePage.data.savingMemberNote, false)
  assert(notePage.data.memberNoteError.includes('重试保存'))
  assert.strictEqual(notePage.data.joinedMembers[1].adminNote, '合成新备注😀')
  membershipStore.setMemberNote = async (ref, note) => { saveCalls.push({ ref, note }); return { updated: true, memberRef: ref } }
  membershipStore.listMembers = async () => summary([{ ...knownMembers.members[1], adminNote: retryNote }])
  await notePage.saveMemberNote()
  assert.strictEqual(notePage.data.joinedMembers[0].adminNote, retryNote, '失败后重试应刷新为服务端确认的备注')

  notePage.editMemberNote(memberEvent(memberRef))
  inputNote(notePage, '😀'.repeat(101))
  const callsBeforeLimit = saveCalls.length
  await notePage.saveMemberNote()
  assert.strictEqual(saveCalls.length, callsBeforeLimit, '超过 100 个 Unicode 字符不得请求保存')
  assert.strictEqual(notePage.data.memberNoteLength, 101)
  assert(notePage.data.memberNoteError.includes('100'))
  inputNote(notePage, `  ${'😀'.repeat(100)}  `)
  assert.strictEqual(notePage.data.memberNoteLength, 100, '字数按 Unicode 字符计数，首尾空格不计')
  await notePage.saveMemberNote()
  assert.deepStrictEqual(saveCalls.at(-1), { ref: memberRef, note: '😀'.repeat(100) }, '100 个补充平面字符必须完整提交')

  notePage.editMemberNote(memberEvent(memberRef))
  inputNote(notePage, ' \n ')
  membershipStore.listMembers = async () => summary([{ ...knownMembers.members[1], adminNote: '' }])
  await notePage.saveMemberNote()
  assert.deepStrictEqual(saveCalls.at(-1), { ref: memberRef, note: '' }, '空白备注必须以空串清除')
  assert.strictEqual(notePage.data.joinedMembers[0].adminNote, '')
  assert.strictEqual(toastCalls.at(-1).title, '成员备注已清空')

  membershipStore.listMembers = async () => knownMembers
  await notePage.loadMembers()
  notePage.editMemberNote(memberEvent(memberRef))
  inputNote(notePage, '交接期间提交的备注')
  membershipStore.listMembers = async () => { throw Object.assign(new Error('只有管理员可以管理成员'), { code: 'OWNER_REQUIRED' }) }
  const toastsBeforeDeniedList = toastCalls.length
  await notePage.saveMemberNote()
  assert.strictEqual(notePage.data.joinedMembersState, 'error')
  assert.deepStrictEqual(notePage.data.joinedMembers, [], '写入成功但重新校验权限失败时不得恢复旧备注')
  assert.strictEqual(notePage.data.memberNoteDraft, '')
  assert.strictEqual(toastCalls.length, toastsBeforeDeniedList, '无权读取时不能显示保存成功提示')

  membershipStore.listMembers = async () => knownMembers
  await notePage.loadMembers()
  notePage.editMemberNote(memberEvent(memberRef))
  inputNote(notePage, '服务端拒绝的草稿')
  membershipStore.setMemberNote = async () => { throw Object.assign(new Error('只有管理员可以管理成员'), { code: 'OWNER_REQUIRED' }) }
  membershipStore.listMembers = async () => { throw Object.assign(new Error('只有管理员可以管理成员'), { code: 'OWNER_REQUIRED' }) }
  await notePage.saveMemberNote()
  assert.strictEqual(notePage.data.memberNoteDraft, '', '权限失败不能保留可重试草稿')
  assert.deepStrictEqual(notePage.data.joinedMembers, [])

  membershipStore.listMembers = async () => knownMembers

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
  assert(legacyPage.data.joinedMembers.every((item) => item.adminNote === ''), '旧数据缺少成员备注时应展示为空')

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
  const ordinarySavesBefore = saveCalls.length
  page.setData({ joinedMembers: [{ memberRef, adminNote: '不该保留' }], joinedMembersState: 'ready', editingMemberRef: memberRef, memberNoteDraft: '不该提交' })
  await page.saveMemberNote()
  assert.strictEqual(saveCalls.length, ordinarySavesBefore, '普通成员不能发出管理员备注请求')
  assert.strictEqual(page.data.memberNoteDraft, '')

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
  const roleCycle = deferred()
  membershipStore.listMembers = () => roleCycle.promise
  const roleCyclePage = makePage()
  const roleCycleRequest = roleCyclePage.loadMembers()
  membershipStore.save({ status: 'active', role: 'member', cacheNamespace: namespace })
  setOwner()
  roleCycle.resolve(knownMembers)
  await roleCycleRequest
  assert.deepStrictEqual(roleCyclePage.data.joinedMembers, [], '管理员离任再接任后，上一任期的回包仍必须失效')

  for (const change of ['namespace', 'role', 'role-cycle', 'hide', 'unload', 'clear']) {
    setOwner()
    membershipStore.listMembers = async () => knownMembers
    const pendingPage = makePage()
    await pendingPage.loadMembers()
    pendingPage.editMemberNote(memberEvent(memberRef))
    inputNote(pendingPage, `迟到的私有备注-${change}`)
    const pendingSave = deferred()
    membershipStore.setMemberNote = () => pendingSave.promise
    const pendingRequest = pendingPage.saveMemberNote()
    let lateRefreshes = 0
    membershipStore.listMembers = async () => { lateRefreshes += 1; return knownMembers }
    if (change === 'namespace') setOwner('e'.repeat(32))
    if (change === 'role' || change === 'role-cycle') membershipStore.save({ status: 'active', role: 'member', cacheNamespace: namespace })
    if (change === 'role-cycle') setOwner()
    if (change === 'hide') pendingPage.onHide()
    if (change === 'unload') pendingPage.onUnload()
    if (change === 'clear') pendingPage.clearRenderedPrivateData()
    assert.deepStrictEqual(pendingPage.data.joinedMembers, [], `${change} 应立即清掉已渲染备注，无需等待回包`)
    assert.strictEqual(pendingPage.data.memberNoteDraft, '')
    assert.strictEqual(pendingPage.data.memberNoteError, '')
    const toastsBeforeLateResponse = toastCalls.length
    pendingSave.resolve({ updated: true, memberRef })
    await pendingRequest
    assert.strictEqual(lateRefreshes, 0, `${change} 后旧保存响应不能触发新的成员读取`)
    assert.strictEqual(toastCalls.length, toastsBeforeLateResponse)
    assert(!JSON.stringify(pendingPage.data).includes('迟到的私有备注'))
  }

  setOwner()
  membershipStore.listMembers = async () => knownMembers
  const lateErrorPage = makePage()
  await lateErrorPage.loadMembers()
  lateErrorPage.editMemberNote(memberEvent(memberRef))
  inputNote(lateErrorPage, '旧身份的失败草稿')
  const lateError = deferred()
  membershipStore.setMemberNote = () => lateError.promise
  const lateErrorRequest = lateErrorPage.saveMemberNote()
  setOwner('e'.repeat(32))
  lateError.reject(new Error('旧身份错误'))
  await lateErrorRequest
  assert.strictEqual(lateErrorPage.data.memberNoteError, '', '旧身份失败回包不能恢复错误或可重试草稿')
  assert.strictEqual(lateErrorPage.data.memberNoteDraft, '')

  setOwner()

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
  for (const field of ['displayName', 'roleLabel', 'joinedText', 'inviterLabel', 'invitationLabel', 'phoneText']) {
    assert(joinedMarkup.includes(`{{item.${field}}}`), `已加入成员必须展示 ${field}`)
  }
  assert(!/<text[^>]*>[^<]*\{\{item.memberRef\}\}/.test(joinedMarkup) && !/phoneNumber|avatar|openid|unionid|health|codeHash/.test(joinedMarkup),
    '已加入成员行仅新增安全尾号，不显示成员引用或其他私人字段')
  assert(joinedMarkup.includes('手机尾号') && joinedMarkup.includes('可能重复'), '尾号仅辅助识别，不得当成唯一身份')
  assert(joinedMarkup.includes('重新加载') && joinedMarkup.includes('暂无可展示的成员') && joinedMarkup.includes('正在加载已加入成员'),
    '已加入成员必须提供加载、空白和可重试错误反馈')
  assert(/\.joined-members-refresh\s*\{[^}]*max-width:\s*72px/.test(profileWxss),
    'refresh must not expand to the platform default button width')
  assert(/\.joined-members-refresh, \.joined-members-retry\s*\{[^}]*min-height:\s*48px/.test(profileWxss),
    '新刷新和重试按钮触控高度必须至少 48px')
  assert(/\.joined-member-value\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/.test(profileWxss),
    '成员长昵称和邀请备注必须在窄屏内换行')
  assert(joinedMarkup.includes('成员备注（仅管理员可见）') && joinedMarkup.includes('邀请备注')
    && joinedMarkup.includes('{{item.adminNote') && joinedMarkup.includes('bindtap="saveMemberNote"')
    && joinedMarkup.includes('bindtap="cancelMemberNote"') && joinedMarkup.includes('重试保存'),
  '已加入成员中应明确区分邀请备注，并提供备注保存、取消和失败重试')
  assert(joinedMarkup.includes('memberNoteLength > maxMemberNoteLength')
    && joinedMarkup.includes('loading="{{savingMemberNote}}"') && joinedMarkup.includes('maxlength="-1"'),
  '备注需通过 Unicode 字数限制及原生保存状态控制，避免原生 UTF-16 上限误截 emoji')
  assert(/\.member-note-edit, \.member-note-cancel, \.member-note-save\s*\{[^}]*min-height:\s*48px/.test(profileWxss),
    '备注添加、保存和取消触控目标必须至少 48px')
  assert(/\.member-note-actions\s*\{[^}]*minmax\(0, 1fr\)[^}]*gap:\s*8px/.test(profileWxss)
    && /\.member-note-input\s*\{[^}]*width:\s*100%[^}]*box-sizing:\s*border-box/.test(profileWxss),
  '备注编辑器与操作按钮必须适应窄屏且按钮间保留 8px 间隔')
  assert(!JSON.stringify(storageWrites).includes('备注'), '管理员备注和草稿不能写入本地持久缓存')
  console.log('profile invitation relationship tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
