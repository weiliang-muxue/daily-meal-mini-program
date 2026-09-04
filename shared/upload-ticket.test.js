'use strict'

const assert = require('assert')
const {
  orphanPermanentPath, ownerHash, ticketCleanupClaimable, ticketConsumable, validOwnedPermanentPath,
} = require('./upload-ticket')

const now = 2_000_000
const owner = 'openid-test-user'
const token = 'a'.repeat(48)
const avatarBase = `avatars/${ownerHash(owner)}/${token}`
const staged = {
  _id: token,
  owner,
  state: 'staged',
  permanentFileId: 'cloud://env/avatar',
  permanentPath: `${avatarBase}.jpg`,
  cleanupReady: false,
  expiresAt: now + 1,
}

assert.strictEqual(ticketConsumable(staged, { owner, fileId: staged.permanentFileId }, now), true)
assert.strictEqual(ticketConsumable({ ...staged, expiresAt: now }, { owner, fileId: staged.permanentFileId }, now), false,
  '到期边界不能再消费')
assert.strictEqual(ticketConsumable({ ...staged, expiresAt: String(now + 1) }, {
  owner, fileId: staged.permanentFileId,
}, now), false, '非服务端整数有效期必须拒绝')
assert.strictEqual(ticketConsumable({ ...staged, state: 'prepared' }, { owner, fileId: staged.permanentFileId }, now), false)
assert.strictEqual(ticketConsumable({ ...staged, state: 'consumed' }, { owner, fileId: staged.permanentFileId }, now), false)
assert.strictEqual(ticketConsumable({ ...staged, cleanupReady: true }, { owner, fileId: staged.permanentFileId }, now), false)
assert.strictEqual(ticketConsumable(staged, { owner: 'other', fileId: staged.permanentFileId }, now), false)

assert.strictEqual(ticketCleanupClaimable({ ...staged, state: 'prepared' }, owner, now), false,
  '未过期 prepared 票据不能被清理')
assert.strictEqual(ticketCleanupClaimable({ ...staged, expiresAt: now }, owner, now), true,
  '过期 staged 票据必须可清理')
assert.strictEqual(ticketCleanupClaimable({ ...staged, state: 'cleanup', cleanupReady: true }, owner, now), true)
assert.strictEqual(ticketCleanupClaimable({
  ...staged, state: 'cleaning', cleanupReady: true, cleanupClaimedAtMs: now - 100,
}, owner, now, 1000), false, '未过租约的 cleaning 票据不能并发重领')
assert.strictEqual(ticketCleanupClaimable({
  ...staged, state: 'cleaning', cleanupReady: true, cleanupClaimedAtMs: now - 1000,
}, owner, now, 1000), true, '租约边界已到的 cleaning 票据可重试')
assert.strictEqual(ticketCleanupClaimable({ ...staged, expiresAt: undefined }, owner, now), true,
  '旧版缺少有效期的票据按过期数据回收')

const orphanAvatar = { ...staged, permanentFileId: '', state: 'prepared' }
assert.strictEqual(validOwnedPermanentPath(`${avatarBase}.webp`, orphanAvatar, {
  kind: 'avatar', owner, token,
}), true)
assert.strictEqual(orphanPermanentPath(orphanAvatar, { kind: 'avatar', owner, token }), `${avatarBase}.jpg`)
assert.strictEqual(orphanPermanentPath({ ...orphanAvatar, permanentPath: 'avatars/other/file.jpg' }, {
  kind: 'avatar', owner, token,
}), '')
assert.strictEqual(orphanPermanentPath({ ...orphanAvatar, permanentPath: `${avatarBase}.exe` }, {
  kind: 'avatar', owner, token,
}), '')
assert.strictEqual(orphanPermanentPath({ ...orphanAvatar, permanentPath: `${avatarBase}/../other.jpg` }, {
  kind: 'avatar', owner, token,
}), '')
assert.strictEqual(orphanPermanentPath(staged, { kind: 'avatar', owner, token }), '',
  '已有 fileID 的票据不能通过覆盖路径回收')

const healthTicket = {
  _id: token, owner, state: 'prepared', targetDate: '2026-08-26', permanentFileId: '',
  permanentPath: `health-photos/${ownerHash(owner)}/2026-08-26-${token}.png`,
}
assert.strictEqual(orphanPermanentPath(healthTicket, {
  kind: 'health', owner, token, targetDate: healthTicket.targetDate,
}), healthTicket.permanentPath)
assert.strictEqual(orphanPermanentPath({ ...healthTicket, targetDate: '2026-08-27' }, {
  kind: 'health', owner, token, targetDate: '2026-08-26',
}), '')

console.log('upload ticket lifecycle tests passed')
