'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const {
  CURRENT_HEALTH_SCHEMA,
  assertSupportedHealthSchema,
  assertExpectedRecordRevision,
  currentRecordRevision,
  planDailyUpdate,
  photoTicketCleanupFiles,
} = require('./daily-core')

function functionBody(source, name) {
  const start = source.indexOf(`async function ${name}(`)
  assert(start >= 0, `缺少函数 ${name}`)
  const next = source.indexOf('\nasync function ', start + 1)
  return source.slice(start, next < 0 ? source.length : next)
}

const base = {
  owner: 'owner', date: '2026-08-26', month: '2026-08', schemaVersion: CURRENT_HEALTH_SCHEMA, weight: 60,
  recordRevision: 3, photoFileId: 'cloud://private/photo-old',
  exercise: {
    completed: true, type: '步行', durationMinutes: 30, intensity: 'low',
    futureServerField: { source: 'trusted-record' },
  },
  note: '旧备注',
}
const upload = planDailyUpdate(base, {
  owner: 'owner', date: '2026-08-26', month: '2026-08',
  expectedRecordRevision: 3, uploadedPhotoFileId: 'cloud://private/photo-b', note: '设备 B',
})
assert.strictEqual(upload.data.recordRevision, 4)
assert.strictEqual(upload.activePhotoFileId, 'cloud://private/photo-b')
assert.strictEqual(upload.replacedPhotoFileId, 'cloud://private/photo-old')
assert.strictEqual(upload.data.weight, 60, '未显式提交的字段必须保留事务内当前值')
assert.deepStrictEqual(upload.data.exercise, base.exercise)

const exerciseUpdate = planDailyUpdate(upload.data, {
  owner: 'owner', date: '2026-08-26', month: '2026-08', expectedRecordRevision: 4,
  futureClientTopLevel: 'must-not-be-stored',
  exercise: {
    completed: true, type: '骑行', durationMinutes: 45, intensity: 'high',
    futureClientField: 'must-not-be-stored',
  },
})
assert.deepStrictEqual(exerciseUpdate.data.exercise, {
  completed: true, type: '骑行', durationMinutes: 45, intensity: 'high',
  futureServerField: { source: 'trusted-record' },
}, '运动更新必须保留可信记录的未知字段，但不能注入客户端未知字段')
assert.strictEqual(Object.prototype.hasOwnProperty.call(exerciseUpdate.data, 'futureClientTopLevel'), false)

const staleEdit = planDailyUpdate(upload.data, {
  owner: 'owner', date: '2026-08-26', month: '2026-08', expectedRecordRevision: 4, weight: 61,
})
assert.strictEqual(staleEdit.activePhotoFileId, 'cloud://private/photo-b', '无照片操作不能回写事务外的旧 fileID')
assert.strictEqual(staleEdit.data.note, '设备 B')
assert.strictEqual(staleEdit.replacedPhotoFileId, '')

const concurrentUpload = planDailyUpdate(upload.data, {
  owner: 'owner', date: '2026-08-26', month: '2026-08',
  expectedRecordRevision: 4, uploadedPhotoFileId: 'cloud://private/photo-a',
})
assert.strictEqual(concurrentUpload.replacedPhotoFileId, 'cloud://private/photo-b')

const clear = planDailyUpdate(concurrentUpload.data, {
  owner: 'owner', date: '2026-08-26', month: '2026-08', expectedRecordRevision: 5, clearPhoto: true,
})
assert.strictEqual(clear.activePhotoFileId, '')
assert.strictEqual(clear.replacedPhotoFileId, 'cloud://private/photo-a', '清除只能删除事务内实际替换掉的照片')

const legacy = planDailyUpdate({ owner: 'owner', date: '2026-08-25', note: '旧记录' }, {
  owner: 'owner', date: '2026-08-25', month: '2026-08', expectedRecordRevision: 0, weight: 59,
})
assert.strictEqual(currentRecordRevision({}), 0, '无版本旧记录必须兼容为 0')
assert.strictEqual(legacy.data.recordRevision, 1, '旧记录首次保存必须迁移到版本 1')
assert.strictEqual(legacy.data.schemaVersion, CURRENT_HEALTH_SCHEMA)
assert.strictEqual(assertSupportedHealthSchema({}), 0, '无 schema 的旧记录必须允许向前迁移')
assert.strictEqual(assertSupportedHealthSchema({ schemaVersion: CURRENT_HEALTH_SCHEMA }), CURRENT_HEALTH_SCHEMA)
assert.throws(
  () => planDailyUpdate({ ...base, schemaVersion: CURRENT_HEALTH_SCHEMA + 1 }, {
    owner: 'owner', date: '2026-08-26', month: '2026-08', expectedRecordRevision: 3, note: '禁止降级写入',
  }),
  (error) => error.code === 'HEALTH_RECORD_SCHEMA_UNSUPPORTED',
  '旧服务不得把未来健康 schema 降级覆盖',
)
assert.throws(
  () => assertSupportedHealthSchema({ schemaVersion: '2' }),
  (error) => error.code === 'HEALTH_RECORD_INVALID',
)
assert.throws(
  () => assertExpectedRecordRevision(upload.data, 3),
  (error) => error.code === 'HEALTH_RECORD_REVISION_CONFLICT',
  '另一设备保存后的旧版本必须冲突',
)
assert.throws(
  () => assertExpectedRecordRevision(upload.data),
  (error) => error.code === 'INVALID_HEALTH_RECORD_REVISION',
)

assert.deepStrictEqual(photoTicketCleanupFiles({
  inboxFileId: 'cloud://private/photo-inbox',
  permanentFileId: 'cloud://private/photo-a',
  cleanupFileId: 'cloud://private/photo-b',
  fileID: 'cloud://private/photo-inbox',
}, 'cloud://private/photo-a'), [
  'cloud://private/photo-inbox', 'cloud://private/photo-b',
], '失败补偿不能删除当天记录仍引用的新照片')

const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')
const commit = functionBody(source, 'commitDailyUpdate')
const recordRead = commit.indexOf('await reference.get()')
assert(recordRead >= 0 && commit.indexOf('planDailyUpdate(current || {}', recordRead) > recordRead,
  '健康记录提交必须先在事务内重读当天记录，再合并本次变更')
assert(commit.indexOf('planDailyUpdate(current || {}') < commit.indexOf("transaction.collection('health_photo_uploads')"),
  '记录版本冲突必须在照片票据读取或消费前发生')
assert(commit.includes("transaction.collection('health_photo_uploads')"), '照片票据必须加入健康记录提交事务')
assert(commit.includes('ticketConsumable(ticket'), '健康记录提交必须按服务端有效期和 staged 状态消费票据')
assert(commit.includes('await ticketReference.update')
  && (commit.includes('await reference.update') || commit.includes('await reference.set')),
  '照片票据消费与健康记录写入必须在同一个事务函数中完成')

const claim = functionBody(source, 'claimPhotoTicketCleanup')
assert(claim.includes('ticketCleanupClaimable(ticket'), '照片清理必须遵守过期与 cleaning 租约重试规则')
const activeRead = claim.indexOf('await recordReference.get()')
assert(activeRead >= 0 && claim.indexOf('photoTicketCleanupFiles(ticket, activePhotoFileId)', activeRead) > activeRead,
  '照片清理领取必须在事务内重读当天活跃照片后过滤候选文件')

const compensation = functionBody(source, 'compensatePhotoUpdate')
assert(compensation.includes('cleanupPhotoTicket(openid, photoTicketToken)'), '失败补偿必须走受保护的票据清理')
assert(!compensation.includes('deletePrivateFiles'), '失败补偿不能根据事务外快照直接删除照片')

console.log('health daily concurrency tests passed')
