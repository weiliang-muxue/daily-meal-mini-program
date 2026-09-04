'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const {
  AI_PRIVATE_COLLECTIONS, UPLOAD_FILE_FIELDS, deletionMembershipState, validateDeletionControl,
  uniqueById, relatedInvite, ticketFileIds, privateFileIds, legacyInboxPath,
  privateUploadCleanupPlan, privateOrphanPaths, runDeletionSequence,
} = require('./core')

const members = [
  { _id: 'deleted', status: 'active', role: 'owner', joinedAt: '2026-01-01T00:00:00.000Z' },
  { _id: 'later', status: 'active', role: 'member', joinedAt: '2026-02-01T00:00:00.000Z' },
  { _id: 'earliest-b', status: 'active', role: 'member', joinedAt: '2026-01-15T00:00:00.000Z' },
  { _id: 'earliest-a', status: 'active', role: 'member', joinedAt: '2026-01-15T00:00:00.000Z' },
  { _id: 'disabled', status: 'disabled', role: 'owner', joinedAt: '2025-01-01T00:00:00.000Z' },
]

const ownerDeletion = deletionMembershipState(members, 'deleted')
assert.strictEqual(ownerDeletion.deletingIsOwner, true)
assert.strictEqual(ownerDeletion.transferRequired, true)
assert.deepStrictEqual(new Set(ownerDeletion.active.map((item) => item._id)), new Set(['later', 'earliest-b', 'earliest-a']))

const memberDeletion = deletionMembershipState([
  { _id: 'member', status: 'active', role: 'member', joinedAt: 1 },
  { _id: 'owner', status: 'active', role: 'owner', joinedAt: 2 },
], 'member')
assert.strictEqual(memberDeletion.deletingIsOwner, false)
assert.strictEqual(memberDeletion.transferRequired, false)
assert.deepStrictEqual(deletionMembershipState([{ _id: 'deleted', status: 'deleting', role: 'member' }], 'deleted'), {
  active: [], deletingIsOwner: false, transferRequired: false,
})
assert.throws(() => deletionMembershipState([
  { _id: 'deleted', status: 'active', role: 'member' },
  { _id: 'owner-a', status: 'active', role: 'owner' },
  { _id: 'owner-b', status: 'active', role: 'owner' },
], 'deleted'), /多个管理员/)

const soleOwner = deletionMembershipState([{ _id: 'deleted', status: 'active', role: 'owner' }], 'deleted')
assert.strictEqual(soleOwner.deletingIsOwner, true)
assert.strictEqual(soleOwner.transferRequired, false)

assert.deepStrictEqual(validateDeletionControl(
  [{ _id: 'owner', status: 'active', role: 'owner' }],
  'owner',
  { ownerOpenid: 'owner', activeMemberCount: 1, reservedInviteCount: 0 },
), { deletingIsOwner: true, activeCount: 1 })
assert.throws(() => validateDeletionControl(
  [{ _id: 'owner', status: 'active', role: 'owner' }],
  'owner',
  { ownerOpenid: 'owner', activeMemberCount: 1, reservedInviteCount: 1 },
), (error) => error.code === 'MEMBERSHIP_INVARIANT_FAILED')
assert.throws(() => validateDeletionControl(
  [{ _id: 'owner', status: 'active', role: 'owner' }],
  'owner',
  { ownerOpenid: 'owner', activeMemberCount: 2, reservedInviteCount: 0 },
), (error) => error.code === 'MEMBERSHIP_INVARIANT_FAILED')
assert.throws(() => validateDeletionControl(members, 'deleted', {
  ownerOpenid: 'deleted', activeMemberCount: 4, reservedInviteCount: 0,
}), (error) => error.code === 'OWNER_TRANSFER_REQUIRED')
assert.deepStrictEqual(validateDeletionControl([
  { _id: 'member', status: 'active', role: 'member' },
  { _id: 'owner', status: 'active', role: 'owner' },
], 'member', { ownerOpenid: 'owner', activeMemberCount: 2, reservedInviteCount: 0 }), {
  deletingIsOwner: false, activeCount: 2,
})
assert.throws(() => validateDeletionControl([
  { _id: 'member', status: 'active', role: 'member' },
  { _id: 'owner', status: 'active', role: 'owner' },
], 'member', { ownerOpenid: 'member', activeMemberCount: 2, reservedInviteCount: 0 }), (
  error
) => error.code === 'MEMBERSHIP_INVARIANT_FAILED')

assert.deepStrictEqual(uniqueById([{ _id: 'a' }, { _id: 'a' }, { _id: 'b' }]).map((item) => item._id), ['a', 'b'])
assert.strictEqual(relatedInvite({ createdBy: 'user' }, 'user'), true)
assert.strictEqual(relatedInvite({ usedBy: 'user' }, 'user'), true)
assert.strictEqual(relatedInvite({ createdBy: 'other', usedBy: 'other' }, 'user'), false)

assert.deepStrictEqual(AI_PRIVATE_COLLECTIONS, ['meal_ai_tasks', 'meal_ai_shards', 'meal_ai_controls'])
assert.deepStrictEqual(UPLOAD_FILE_FIELDS, ['inboxFileId', 'permanentFileId', 'cleanupFileId', 'fileID', 'fileId'])
const ticketFiles = ticketFileIds([{
  inboxFileId: 'cloud://env/avatar-inbox',
  permanentFileId: 'cloud://env/avatar-permanent',
  cleanupFileId: 'cloud://env/avatar-old',
  fileID: 'cloud://env/avatar-legacy-upper',
  fileId: 'cloud://env/avatar-legacy-lower',
}, {
  inboxFileId: 'cloud://env/avatar-inbox',
  fileId: 'https://example.invalid/not-a-private-cloud-file',
}])
assert.deepStrictEqual(ticketFiles, [
  'cloud://env/avatar-inbox', 'cloud://env/avatar-permanent', 'cloud://env/avatar-old',
  'cloud://env/avatar-legacy-upper', 'cloud://env/avatar-legacy-lower',
])
assert.deepStrictEqual(privateFileIds({
  user: { avatarFileId: 'cloud://env/active-avatar' },
  health: [{ photoFileId: 'cloud://env/health-active' }, { photoFileId: '' }],
  avatarTickets: [{ inboxFileId: 'cloud://env/avatar-inbox', fileID: 'cloud://env/avatar-legacy' }],
  photoTickets: [{ permanentFileId: 'cloud://env/health-permanent', cleanupFileId: 'cloud://env/health-old' }],
}), [
  'cloud://env/active-avatar', 'cloud://env/health-active', 'cloud://env/avatar-inbox',
  'cloud://env/avatar-legacy', 'cloud://env/health-permanent', 'cloud://env/health-old',
])

const orphanOwner = 'privacy-owner'
const orphanToken = 'b'.repeat(48)
const { ownerHash } = require('./upload-ticket')
const ownerPathHash = ownerHash(orphanOwner)
const cleanupNow = 1_000_000
assert.deepStrictEqual(privateOrphanPaths({
  avatarTickets: [{
    _id: orphanToken, owner: orphanOwner, state: 'cleanup', permanentFileId: '',
    permanentPath: `avatars/${ownerPathHash}/${orphanToken}.jpg`,
  }, {
    _id: 'c'.repeat(48), owner: orphanOwner, state: 'staged', permanentFileId: 'cloud://env/already-known',
    permanentPath: `avatars/${ownerPathHash}/${'c'.repeat(48)}.png`,
  }],
  photoTickets: [{
    _id: 'e'.repeat(48), owner: orphanOwner, state: 'cleaning', targetDate: '2026-08-26', permanentFileId: '',
    permanentPath: `health-photos/${ownerPathHash}/2026-08-26-${'e'.repeat(48)}.webp`,
  }],
}, orphanOwner, cleanupNow), [
  `avatars/${ownerPathHash}/${orphanToken}.jpg`,
  `health-photos/${ownerPathHash}/2026-08-26-${'e'.repeat(48)}.webp`,
], '账号删除只能回收严格归属当前用户且没有 fileID 的预留路径')

const uploadingToken = 'f'.repeat(48)
const uploadingPath = `health-photos/${ownerPathHash}/2026-08-26-${uploadingToken}.png`
const uploadingTicket = {
  _id: uploadingToken, owner: orphanOwner, state: 'uploading', targetDate: '2026-08-26',
  permanentPath: uploadingPath, permanentFileId: '', uploadStartedAtMs: cleanupNow,
  uploadLeaseExpiresAtMs: cleanupNow + 120 * 1000,
}
assert.throws(
  () => privateUploadCleanupPlan({ photoTickets: [uploadingTicket] }, orphanOwner, cleanupNow + 1),
  (error) => error.code === 'PRIVATE_UPLOAD_IN_PROGRESS' && error.retryable === true,
  '未到期 uploading 租约必须阻断隐私删除',
)
assert.deepStrictEqual(
  privateUploadCleanupPlan(
    { photoTickets: [uploadingTicket] }, orphanOwner, uploadingTicket.uploadLeaseExpiresAtMs + 1,
  ),
  { orphanPaths: [uploadingPath] },
  '到期 uploading 租约只能回收严格校验后的 owner/token/date 路径',
)
assert.throws(
  () => privateUploadCleanupPlan({
    photoTickets: [{ ...uploadingTicket, uploadLeaseExpiresAtMs: cleanupNow + 10 }],
  }, orphanOwner, cleanupNow + 20),
  (error) => error.code === 'PRIVATE_UPLOAD_STATE_INVALID',
  '上传租约时长被篡改时必须 fail closed',
)
assert.throws(
  () => privateUploadCleanupPlan({ avatarTickets: [{
    _id: 'd'.repeat(48), owner: orphanOwner, state: 'prepared', permanentFileId: '',
    permanentPath: 'avatars/another-user/unsafe.jpg',
  }] }, orphanOwner, cleanupNow),
  (error) => error.code === 'PRIVATE_UPLOAD_STATE_INVALID',
  '不可信永久路径不得被回收或在删除票据时静默忽略',
)

const legacyToken = '1'.repeat(48)
assert.strictEqual(legacyInboxPath({
  owner: orphanOwner, extension: 'JPEG', expiresAt: 10,
}, { kind: 'avatar', owner: orphanOwner, token: legacyToken }), `avatar-inbox/${legacyToken}.jpeg`)
assert.throws(
  () => privateUploadCleanupPlan({ avatarTickets: [{
    _id: legacyToken, owner: orphanOwner, extension: 'jpg', expiresAt: cleanupNow,
  }] }, orphanOwner, cleanupNow + 1),
  (error) => error.code === 'PRIVATE_UPLOAD_IN_PROGRESS' && error.retryable === true,
  '旧客户端 inbox 上传在票据到期后的清理宽限期内也必须阻断删除',
)
assert.deepStrictEqual(privateUploadCleanupPlan({
  avatarTickets: [{
    _id: legacyToken, owner: orphanOwner, extension: 'jpg', expiresAt: cleanupNow,
  }],
  photoTickets: [{
    _id: '2'.repeat(48), owner: orphanOwner, extension: 'webp', expiresAt: cleanupNow,
  }],
}, orphanOwner, cleanupNow + 120 * 1000 + 1), {
  orphanPaths: [`avatar-inbox/${legacyToken}.jpg`, `health-inbox/${'2'.repeat(48)}.webp`],
}, '过期旧票据必须从严格 token 与扩展名推导 inbox 对象路径')
for (const invalidLegacy of [
  { _id: 'not-a-token', owner: orphanOwner, extension: 'jpg', expiresAt: 1 },
  { _id: '3'.repeat(48), owner: orphanOwner, extension: '../jpg', expiresAt: 1 },
]) {
  assert.throws(
    () => privateUploadCleanupPlan({ avatarTickets: [invalidLegacy] }, orphanOwner, cleanupNow),
    (error) => error.code === 'PRIVATE_UPLOAD_STATE_INVALID',
    '无法安全推导路径的旧票据必须保留并阻断清理',
  )
}

const privacyIndex = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')
const planCall = 'const uploadCleanup = privateUploadCleanupPlan(data, openid, Date.now())'
const reclaimCall = 'await reclaimOrphanPaths(uploadCleanup.orphanPaths, assertCurrentGeneration)'
assert(privacyIndex.includes(planCall), '账号删除必须在任何文件或文档删除前验证全部上传票据')
assert(privacyIndex.includes(reclaimCall), '账号删除必须在删除票据前回收无 fileID 的预留对象')
assert(privacyIndex.indexOf(planCall) < privacyIndex.indexOf('await deleteFiles(privateFileIds(data), assertCurrentGeneration)'),
  '上传租约与路径校验必须先于任何文件删除')
assert(privacyIndex.indexOf(reclaimCall) < privacyIndex.indexOf('await removePrivateDocuments(openid, data, expectedCacheNamespace)'),
  '只有预留对象回收成功后才能删除上传票据')

async function testDeletionOrder() {
  const calls = []
  let markedDeleting = false
  const result = await runDeletionSequence({
    preflight: async () => calls.push('preflight'),
    listActiveOwnedInvites: async () => { calls.push('list-invites'); return [{ _id: 'invite-a' }, { _id: 'invite-b' }] },
    deactivateInvite: async (invite) => {
      assert.strictEqual(markedDeleting, false, '活跃邀请必须在成员进入 deleting 前撤销')
      calls.push(`deactivate:${invite._id}`)
    },
    markMembershipDeleting: async () => {
      calls.push('mark-deleting'); markedDeleting = true
      return { preserveOwner: false }
    },
    collectPrivateData: async () => {
      assert.strictEqual(markedDeleting, true, '收集 AI 与用户资源前必须先阻断新任务')
      calls.push('collect-private')
      return { aiTasks: [{ _id: 'task' }], aiShards: [{ _id: 'shard' }], aiControls: [{ _id: 'control' }] }
    },
    deletePrivateData: async (data, ...authorizationState) => {
      assert.strictEqual(markedDeleting, true)
      assert.deepStrictEqual(authorizationState, [], '删除私人数据不得接收成员授权态')
      assert.strictEqual(data.aiTasks.length, 1)
      assert.strictEqual(data.aiShards.length, 1)
      assert.strictEqual(data.aiControls.length, 1)
      calls.push('delete-private')
      return { cleared: true }
    },
    verifyCleared: async (...authorizationState) => {
      assert.deepStrictEqual(authorizationState, [], '清除验证不得接收成员授权态')
      calls.push('verify-cleared')
    },
    finalizeMembership: async (...authorizationState) => {
      assert.deepStrictEqual(authorizationState, [], '成员收尾必须只信任事务内状态')
      calls.push('finalize-membership')
      return { membershipDeleted: true, ownerAccessRetained: false }
    },
  })
  assert.deepStrictEqual(result, {
    cleared: true, membershipDeleted: true, ownerAccessRetained: false,
  })
  assert.deepStrictEqual(calls, [
    'preflight', 'list-invites', 'deactivate:invite-a', 'deactivate:invite-b',
    'mark-deleting', 'collect-private', 'delete-private', 'verify-cleared', 'finalize-membership',
  ])
}

testDeletionOrder()
  .then(() => console.log('privacy core tests passed'))
  .catch((error) => { console.error(error); process.exitCode = 1 })
