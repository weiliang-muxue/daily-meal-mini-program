'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const {
  PROFILE_SCHEMA_VERSION, maskedPhone, phoneBindingFromResponse, profileMigration,
  planProfileUpdate, avatarTicketCleanupFiles,
} = require('./profile-core')

assert.strictEqual(PROFILE_SCHEMA_VERSION, 2)
assert.strictEqual(maskedPhone('00008000'), '****8000')
assert.strictEqual(maskedPhone('+00 0000-8000'), '****8000')
assert.strictEqual(maskedPhone('123'), '')
assert.deepStrictEqual(phoneBindingFromResponse({
  phoneInfo: { phoneNumber: '+0000008000', purePhoneNumber: '00008000', countryCode: '00' },
}), { phoneBound: true, maskedPhone: '****8000' })
assert.throws(() => phoneBindingFromResponse({ phoneInfo: {} }), (error) => error.code === 'PHONE_BIND_UNAVAILABLE')
assert.deepStrictEqual(profileMigration({ schemaVersion: 1 }), {
  schemaVersion: 2, phoneBound: false, maskedPhone: '', phoneBoundAt: null,
})
assert.deepStrictEqual(profileMigration({ schemaVersion: 2, phoneBound: true, maskedPhone: '****8000' }), {
  schemaVersion: 2, phoneBound: true, maskedPhone: '****8000',
})

function functionBody(source, name) {
  const start = source.indexOf(`async function ${name}(`)
  assert(start >= 0, `缺少函数 ${name}`)
  const next = source.indexOf('\nasync function ', start + 1)
  return source.slice(start, next < 0 ? source.length : next)
}

const firstUpload = planProfileUpdate(
  { nickname: '旧昵称', avatarFileId: 'cloud://private/avatar-old' },
  { nickname: '设备 B', uploadedAvatarFileId: 'cloud://private/avatar-b' },
)
assert.strictEqual(firstUpload.activeAvatarFileId, 'cloud://private/avatar-b')
assert.strictEqual(firstUpload.replacedAvatarFileId, 'cloud://private/avatar-old')

const staleNicknameSave = planProfileUpdate(firstUpload.profile, { nickname: '设备 A' })
assert.strictEqual(staleNicknameSave.profile.avatarFileId, 'cloud://private/avatar-b', '事务重读后，纯昵称保存不能回写旧头像')
assert.deepStrictEqual(staleNicknameSave.data, { nickname: '设备 A' })
assert.strictEqual(staleNicknameSave.replacedAvatarFileId, '')

const secondUpload = planProfileUpdate(firstUpload.profile, {
  nickname: '设备 A', uploadedAvatarFileId: 'cloud://private/avatar-a',
})
assert.strictEqual(secondUpload.replacedAvatarFileId, 'cloud://private/avatar-b', '并发上传只能替换事务中实际读到的头像')
assert.strictEqual(secondUpload.activeAvatarFileId, 'cloud://private/avatar-a')

assert.deepStrictEqual(avatarTicketCleanupFiles({
  inboxFileId: 'cloud://private/avatar-inbox',
  permanentFileId: 'cloud://private/avatar-a',
  cleanupFileId: 'cloud://private/avatar-b',
}, 'cloud://private/avatar-a'), [
  'cloud://private/avatar-inbox', 'cloud://private/avatar-b',
], '补偿清理必须保护当前仍被档案引用的新头像')

const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')
const commit = functionBody(source, 'commitProfileUpdate')
const profileRead = commit.indexOf('await reference.get()')
assert(profileRead >= 0 && commit.indexOf('planProfileUpdate(current', profileRead) > profileRead,
  '档案提交必须先在事务内重读当前档案，再规划更新')
assert(commit.includes("transaction.collection('meal_avatar_uploads')"), '头像票据必须加入档案提交事务')
assert(commit.includes('ticketConsumable(ticket'), '档案提交必须按服务端有效期和 staged 状态消费票据')
assert(commit.includes('await ticketReference.update') && commit.includes('await reference.update'),
  '头像票据消费与档案写入必须在同一个事务函数中完成')

const claim = functionBody(source, 'claimAvatarTicketCleanup')
assert(claim.includes('ticketCleanupClaimable(ticket'), '头像清理必须遵守过期与 cleaning 租约重试规则')
const activeRead = claim.indexOf('await profileReference.get()')
assert(activeRead >= 0 && claim.indexOf('avatarTicketCleanupFiles(ticket, activeAvatarFileId)', activeRead) > activeRead,
  '头像清理领取必须在事务内重读活跃头像后过滤候选文件')

const compensation = functionBody(source, 'compensateAvatarUpdate')
assert(compensation.includes('cleanupAvatarTicket(openid, avatarTicketToken)'), '失败补偿必须走受保护的票据清理')
assert(!compensation.includes('deletePrivateFiles'), '失败补偿不能根据事务外快照直接删除头像')

const phoneBinding = functionBody(source, 'bindPhoneNumber')
assert(phoneBinding.includes('cloud.openapi.phonenumber.getPhoneNumber({ code, openid })'),
  '手机号动态 code 必须仅由云端携可信 OPENID 调用微信官方接口')
assert(!/console\.(?:log|info|warn|error)/.test(phoneBinding), '手机号动态 code 和完整号码处理函数不得写日志')
assert(!/phoneInfo\.(?:phoneNumber|purePhoneNumber|countryCode)/.test(phoneBinding),
  '完整手机号只能在纯函数内生成掩码，数据库写入路径不得直接引用微信完整号码字段')
assert(phoneBinding.includes('...binding') && phoneBinding.includes('phoneBoundAt: db.serverDate()'),
  '手机号绑定只应持久化最小绑定状态、掩码和服务端时间')

console.log('auth profile concurrency tests passed')
