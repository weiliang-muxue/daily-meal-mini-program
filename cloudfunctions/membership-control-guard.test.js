'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = __dirname
const read = (name) => fs.readFileSync(path.join(root, name, 'index.js'), 'utf8')

function functionBody(source, name) {
  const marker = `async function ${name}(`
  const start = source.indexOf(marker)
  assert(start >= 0, `缺少函数 ${name}`)
  const nextFunction = source.indexOf('\nasync function ', start + marker.length)
  const exportsStart = source.indexOf('\nexports.main', start + marker.length)
  const candidates = [nextFunction, exportsStart, source.length].filter((value) => value >= 0)
  return source.slice(start, Math.min(...candidates))
}

function assertControlTransaction(source, name, mutationMarkers) {
  const body = functionBody(source, name)
  assert(body.includes('db.runTransaction'), `${name} 必须使用数据库事务`)
  assert(body.includes("transaction.collection('meal_members').doc(CONTROL_ID)"), `${name} 必须读取固定 control 文档`)
  assert(/(?:assertOperationalControl|reviseOperationalControl|reserveInvite|consumeInvite|releaseInvite|transferOwnerControl|removeMember|controlFromSnapshot|decideRequest|decideApproval|decideBootstrap)/.test(body), `${name} 必须校验或推进 control 状态`)
  mutationMarkers.forEach((marker) => assert(body.includes(marker), `${name} 缺少受保护写点 ${marker}`))
  assert(/controlReference\.(?:set|update|remove)\(/.test(body) || /reference\.set\(/.test(body), `${name} 必须写回 control 版本`)
}

const owner = read('ownerBootstrapOnce')
const membership = read('membership')
const privacy = read('privacy')

;[owner, membership, privacy].forEach((source) => {
  assert(!/transaction\.collection\([^)]*\)\.(?:where|limit|skip|orderBy|count)\(/.test(source), '事务内不得使用批量查询 API')
})

const requestBody = functionBody(owner, 'createRequest')
assert(requestBody.indexOf('await assertEmptyMembershipState()') < requestBody.indexOf('db.runTransaction'), '空库审计必须先于哨兵占用事务')
assertControlTransaction(owner, 'createRequest', ['controlReference.set(', 'requestReference.set('])
assertControlTransaction(owner, 'approve', ['requestReference.set(', 'controlReference.update('])
assertControlTransaction(owner, 'activate', ['memberReference.set(', 'controlReference.set(', 'requestReference.remove('])

assertControlTransaction(membership, 'ensureControl', ['reference.set('])
assertControlTransaction(membership, 'ensureMemberIdentity', ['reference.update(', 'controlReference.update('])
assertControlTransaction(membership, 'expireInvite', ['inviteReference.update(', 'controlReference.update('])
assertControlTransaction(membership, 'revokeExcessInvite', ['inviteReference.update(', 'controlReference.update('])
assertControlTransaction(membership, 'upgradeControlConfiguration', ['controlReference.update('])
assertControlTransaction(membership, 'createInvite', ['inviteReference.set(', 'controlReference.update('])
assertControlTransaction(membership, 'acceptInvite', ['inviteReference.update(', 'memberReference.set(', 'controlReference.update('])
assertControlTransaction(membership, 'revokeInvite', ['inviteReference.update(', 'controlReference.update('])
assertControlTransaction(membership, 'transferOwner', ['ownerReference.update(', 'targetReference.update(', 'controlReference.update('])

assertControlTransaction(privacy, 'prepareMembershipDeletion', [
  "const freshCurrent = await getDocument('meal_members', openid, transaction)",
  'memberReference.update(', 'controlReference.update(',
])
assertControlTransaction(privacy, 'deactivateOwnedInvite', ['inviteReference.update(', 'controlReference.update('])
assertControlTransaction(privacy, 'removeRelatedInvite', ['inviteReference.remove(', 'controlReference.update('])
assertControlTransaction(privacy, 'finalizeMembershipDeletion', [
  'memberReference.set(', 'memberReference.remove(', 'controlReference.update(',
])
const finalizationBody = functionBody(privacy, 'finalizeMembershipDeletion')
assert(finalizationBody.startsWith('async function finalizeMembershipDeletion(openid, expectedCacheNamespace)'),
  '成员收尾必须只接收 openid 与客户端确认的 cache namespace')
assert(!/\bdeletionState\b/.test(finalizationBody), '成员收尾不得信任栈内删除授权态')
assert(finalizationBody.includes('assertExpectedCacheNamespace(member, expectedCacheNamespace)'),
  '成员收尾必须在事务内重读并校验确认时的数据代际')
assert(finalizationBody.includes('member.preserveOwnerAfterClear === true'), '成员收尾必须读取持久化 owner 恢复标记')
assert(finalizationBody.includes('control.ownerOpenid === openid'), '成员收尾必须核对 control 中的 owner')

const allSources = fs.readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'index.js')))
  .map((entry) => fs.readFileSync(path.join(root, entry.name, 'index.js'), 'utf8'))
  .join('\n')
assert(!/\b(?:members|invites)\.doc\([^\n]+\)\.(?:set|update|remove)\(/.test(allSources), '成员或邀请码写入不能绕过事务')
assert(!/db\.collection\(['"]meal_(?:members|invites)['"]\)\.doc\([^\n]+\)\.(?:set|update|remove)\(/.test(allSources), '成员或邀请码不能由 db 引用直接写入')
assert(!/removeDocument\(['"]meal_members['"]/.test(privacy), '成员物理删除必须使用 control 事务')
assert(!/removeDocuments\(['"]meal_invites['"]/.test(privacy), '邀请码物理删除必须使用 control 事务')

console.log('membership control guard tests passed')
