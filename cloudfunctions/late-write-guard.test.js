'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const read = (name) => fs.readFileSync(path.join(__dirname, name, 'index.js'), 'utf8')

function functionBody(source, name) {
  const marker = `async function ${name}(`
  const start = source.indexOf(marker)
  assert(start >= 0, `缺少函数 ${name}`)
  const nextFunction = source.indexOf('\nasync function ', start + marker.length)
  const exportsStart = source.indexOf('\nexports.main', start + marker.length)
  const candidates = [nextFunction, exportsStart, source.length].filter((value) => value >= 0)
  return source.slice(start, Math.min(...candidates))
}

function assertTransactionGuard(source, helperName) {
  const helper = functionBody(source, helperName)
  assert(helper.includes("transaction.collection('meal_members').doc(openid).get()"), `${helperName} 必须在事务内重读成员`)
  assert(helper.includes("member.status !== 'active'"), `${helperName} 必须拒绝非 active 成员`)
  assert(source.includes("'ACCOUNT_DELETION_IN_PROGRESS'"), '必须区分账号删除中的错误')
  assert(source.includes("'MEMBERSHIP_REQUIRED'"), '必须区分无有效成员身份的错误')
}

const auth = read('auth')
assertTransactionGuard(auth, 'withActiveMemberTransaction')
assert(!/users\.doc\([^\n]+\)\.(?:set|update)\(/.test(auth), '账号最终写不能绕过事务守卫')
assert(!/avatarUploads\.doc\([^\n]+\)\.(?:set|update)\(/.test(auth), '头像票据写不能绕过事务守卫')
;['login', 'prepareAvatar'].forEach((name) => {
  assert(functionBody(auth, name).includes('withActiveMemberTransaction(openid'), `${name} 的最终写必须使用成员事务守卫`)
})
assert(functionBody(auth, 'updateProfile').includes('commitProfileUpdate(openid'), 'updateProfile 必须委托受保护的档案提交函数')
assert(functionBody(auth, 'commitProfileUpdate').includes('withActiveMemberTransaction(openid'), '档案最终写必须使用成员事务守卫')
assert(functionBody(auth, 'commitProfileUpdate').includes('ticketConsumable(ticket'), '过期头像票据不能在最终事务中消费')
assert(functionBody(auth, 'updateAvatarTicket').includes("transaction.collection('meal_avatar_uploads')"), '头像票据必须在成员事务中更新')
assert(functionBody(auth, 'finalizeAvatar').includes('if (uploadedFileId) await deletePrivateFiles([uploadedFileId])'), '头像永久文件上传后的失败路径必须补偿删除')
assert(functionBody(auth, 'finalizeAvatar').includes('cleanupAvatarTicket(openid, prepared.token)'), '头像失败路径必须登记并领取票据清理')

const health = read('health')
assertTransactionGuard(health, 'withActiveMemberTransaction')
assert(!/daily\.doc\([^\n]+\)\.(?:set|update)\(/.test(health), '健康记录最终写不能绕过事务守卫')
assert(!/uploads\.doc\([^\n]+\)\.(?:set|update)\(/.test(health), '健康照片票据写不能绕过事务守卫')
;['preparePhoto'].forEach((name) => {
  assert(functionBody(health, name).includes('withActiveMemberTransaction(openid'), `${name} 的最终写必须使用成员事务守卫`)
})
assert(functionBody(health, 'saveDaily').includes('commitDailyUpdate(openid'), 'saveDaily 必须委托受保护的健康记录提交函数')
assert(functionBody(health, 'commitDailyUpdate').includes('withActiveMemberTransaction(openid'), '健康记录最终写必须使用成员事务守卫')
assert(functionBody(health, 'commitDailyUpdate').includes('ticketConsumable(ticket'), '过期健康照片票据不能在最终事务中消费')
assert(functionBody(health, 'updatePhotoTicket').includes("transaction.collection('health_photo_uploads')"), '健康照片票据必须在成员事务中更新')
const finalizePhoto = functionBody(health, 'finalizePhoto')
assert(finalizePhoto.includes('if (uploadedFileId) await deletePrivateFiles([uploadedFileId])'), '健康照片永久文件上传后的失败路径必须补偿删除')
assert(finalizePhoto.includes('if (uploadAttempted && permanentPath) await reclaimOrphanPath(permanentPath)'), '健康照片上传结果不确定时必须回收固定对象路径')
assert(finalizePhoto.includes('if (!uploadAttempted)'), '健康照片上传前失败必须进入票据清理分支')
assert(finalizePhoto.includes("state: 'cleanup', cleanupReady: true"), '健康照片上传前失败必须登记可领取的清理票据')
assert(finalizePhoto.includes("}, ['prepared'], expectedCacheNamespace)"), '健康照片上传前失败登记必须受身份世代保护')
assert(finalizePhoto.includes('cleanupPhotoTicket(openid, prepared.token, expectedCacheNamespace)'), '健康照片失败路径必须带身份世代领取票据清理')

const cleanupPhotoTicket = functionBody(health, 'cleanupPhotoTicket')
assert(cleanupPhotoTicket.includes('claimPhotoTicketCleanup(openid, token, expectedCacheNamespace)'), '健康照片票据清理领取必须受身份世代保护')
assert(cleanupPhotoTicket.includes('removeCleanedPhotoTicket(openid, token, expectedCacheNamespace)'), '健康照片票据清理完成必须在相同身份世代移除票据')

const userData = read('userData')
assertTransactionGuard(userData, 'requireActiveMemberInTransaction')
;['bootstrap', 'saveState', 'changePlan'].forEach((name) => {
  const body = functionBody(userData, name)
  assert(body.includes('db.runTransaction'), `${name} 必须在事务中执行`)
  assert(body.includes('await requireActiveMemberInTransaction(transaction, openid)'), `${name} 必须在最终写事务中重读成员`)
})
assert(!/states\.doc\([^\n]+\)\.(?:set|update)\(/.test(userData), '用户状态最终写不能绕过事务守卫')

console.log('迟到回写守卫测试通过：账号、健康与用户状态最终写均受事务内 active 成员检查保护。')
