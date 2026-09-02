'use strict'

const assert = require('assert')
const childProcess = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const validator = path.join(root, 'scripts/validate.js')
const collectionNames = [
  'meal_users',
  'meal_user_states',
  'meal_avatar_uploads',
  'meal_members',
  'meal_invites',
  'health_daily',
  'health_photo_uploads',
  'meal_ai_tasks',
  'meal_ai_shards',
  'meal_ai_controls',
]

function validRules() {
  return Object.fromEntries(collectionNames.map((name) => [name, { read: false, write: false }]))
}

function runValidation(rules) {
  return childProcess.spawnSync(process.execPath, [validator, '--validate-database-rules-stdin'], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify(rules),
  })
}

function assertAccepted(rules, message) {
  const result = runValidation(rules)
  assert.strictEqual(result.status, 0, `${message}: ${result.stderr}`)
}

function assertRejected(rules, message) {
  const result = runValidation(rules)
  assert.notStrictEqual(result.status, 0, message)
  assert.strictEqual(result.stderr, '数据库安全规则验证失败\n')
}

assert.strictEqual(collectionNames.length, 10)
assertAccepted(JSON.parse(fs.readFileSync(path.join(root, 'database.rules.json'), 'utf8')),
  '仓库数据库规则必须通过精确校验')

const missingCollection = validRules()
delete missingCollection.meal_users
assertRejected(missingCollection, '缺少固定集合时必须拒绝')

assertRejected({
  ...validRules(),
  unexpected_collection: { read: false, write: false },
}, '出现额外集合时必须拒绝')

const missingPermission = validRules()
delete missingPermission.meal_members.write
assertRejected(missingPermission, '集合缺少 write 规则时必须拒绝')

assertRejected({
  ...validRules(),
  health_daily: { read: false, write: false, remove: false },
}, '集合出现额外权限字段时必须拒绝')

assertRejected({
  ...validRules(),
  meal_invites: { read: 'false', write: false },
}, '字符串 false 不能替代布尔 false')

collectionNames.forEach((collectionName) => {
  ;['read', 'write'].forEach((permission) => {
    const rules = validRules()
    rules[collectionName][permission] = true
    assertRejected(rules, `${collectionName}.${permission} 放开时必须拒绝`)
  })
})

console.log('数据库安全规则精确校验测试通过')
