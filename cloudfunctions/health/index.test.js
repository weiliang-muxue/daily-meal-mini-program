'use strict'

const assert = require('assert')
const crypto = require('crypto')
const Module = require('module')
const path = require('path')
const { CURRENT_HEALTH_SCHEMA } = require('./daily-core')

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PHOTO_INPUT = {
  sourceUrl: 'https://example.test/health.png', sourceSize: PNG.length,
  sourceSha256: crypto.createHash('sha256').update(PNG).digest('hex'),
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

const stores = new Map()
let failHealthWriteOnce = false
let failHealthQueryOnce = false
let memberReadError = null
let deletedFiles = []
let deleteOutcomes = []
let uploadedPaths = []
let uploadHook = null
let downloadHandler = async () => PNG

function applyUpdate(current, data) {
  const next = { ...clone(current || {}) }
  Object.entries(data || {}).forEach(([key, value]) => {
    if (value && value.__operation === 'remove') delete next[key]
    else next[key] = clone(value)
  })
  return next
}

function store(name, source = stores) {
  if (!source.has(name)) source.set(name, new Map())
  return source.get(name)
}

function reference(name, id, source = stores) {
  return {
    async get() {
      if (name === 'meal_members' && memberReadError) {
        const error = memberReadError
        memberReadError = null
        throw error
      }
      const value = store(name, source).get(id)
      return { data: value === undefined ? null : clone(value) }
    },
    async set({ data }) {
      if (name === 'health_daily' && failHealthWriteOnce) {
        failHealthWriteOnce = false
        throw new Error('simulated record write failure')
      }
      store(name, source).set(id, clone(data))
    },
    async update({ data }) {
      if (name === 'health_daily' && failHealthWriteOnce) {
        failHealthWriteOnce = false
        throw new Error('simulated record write failure')
      }
      const current = store(name, source).get(id) || {}
      store(name, source).set(id, applyUpdate(current, data))
    },
    async remove() {
      if (name === 'health_daily' && failHealthWriteOnce) {
        failHealthWriteOnce = false
        throw new Error('simulated record write failure')
      }
      store(name, source).delete(id)
    },
  }
}

function query(name, criteria, source = stores) {
  return {
    orderBy() { return this },
    limit() { return this },
    async get() {
      if (name === 'health_daily' && failHealthQueryOnce) {
        failHealthQueryOnce = false
        throw Object.assign(new Error('private database detail must not escape'), {
          code: 'PRIVATE_DATABASE_FAILURE',
        })
      }
      const values = [...store(name, source).entries()].map(([id, value]) => ({ _id: id, ...clone(value) }))
        .filter((item) => Object.entries(criteria || {}).every(([key, value]) => item[key] === value))
      return { data: values }
    },
  }
}

function collection(name, source = stores) {
  return {
    doc(id) { return reference(name, id, source) },
    where(criteria) { return query(name, criteria, source) },
  }
}

function snapshot() {
  const result = new Map()
  stores.forEach((values, name) => result.set(name, new Map([...values].map(([id, value]) => [id, clone(value)]))))
  return result
}

const database = {
  command: {
    gte: (value) => ({ value, and: () => ({}) }),
    remove: () => ({ __operation: 'remove' }),
  },
  collection,
  serverDate() { return { $serverDate: true } },
  async runTransaction(callback) {
    const working = snapshot()
    const transaction = { collection: (name) => collection(name, working) }
    const result = await callback(transaction)
    stores.clear()
    working.forEach((values, name) => stores.set(name, values))
    return result
  },
}

const cloudStub = {
  DYNAMIC_CURRENT_ENV: 'dynamic-current-env',
  init() {},
  database() { return database },
  getWXContext() { return { OPENID: owner } },
  async deleteFile({ fileList }) {
    deletedFiles.push(...fileList)
    if (deleteOutcomes.length) {
      const outcome = deleteOutcomes.shift()
      if (outcome instanceof Error) throw outcome
      if (typeof outcome === 'function') return outcome(fileList)
      return clone(outcome)
    }
    return { fileList: fileList.map((fileID) => ({ fileID, status: 0 })) }
  },
  async getTempFileURL() { return { fileList: [] } },
  async uploadFile({ cloudPath, fileContent }) {
    uploadedPaths.push(cloudPath)
    if (uploadHook) await uploadHook({ cloudPath, fileContent })
    return { fileID: `cloud://env/${cloudPath}` }
  },
}

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloudStub
  if (request === './image-source' && parent && parent.filename.endsWith(path.join('health', 'index.js'))) {
    return {
      validMetadata: (input = {}, maxBytes, label) => {
        const size = Number(input.sourceSize)
        const sha256 = typeof input.sourceSha256 === 'string' ? input.sourceSha256 : ''
        if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes || !/^[a-f0-9]{64}$/.test(sha256)) {
          const error = new Error(`${label}文件信息无效，请重新选择`)
          error.code = 'IMAGE_METADATA_INVALID'
          throw error
        }
        return { size, sha256 }
      },
      downloadImageSource: (...args) => downloadHandler(...args),
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}
let health
try { health = require('./index') } finally { Module._load = originalLoad }

const owner = 'openid-health-owner'
const date = '2026-08-26'
const cacheNamespace = 'a'.repeat(32)
const rotatedCacheNamespace = 'b'.repeat(32)
const recordId = health._test.documentId(owner, date)
const rawHealthMain = health.main
const rawCommitDailyUpdate = health._test.commitDailyUpdate
health.main = (event) => rawHealthMain({ ...event, expectedCacheNamespace: cacheNamespace })
health._test.commitDailyUpdate = (...args) => rawCommitDailyUpdate(...args, cacheNamespace)

function put(name, id, value) { store(name).set(id, clone(value)) }
function get(name, id) { return clone(store(name).get(id)) }
function reset() {
  stores.clear()
  failHealthWriteOnce = false
  failHealthQueryOnce = false
  memberReadError = null
  deletedFiles = []
  deleteOutcomes = []
  uploadedPaths = []
  uploadHook = null
  downloadHandler = async () => PNG
  put('meal_members', owner, { status: 'active', cacheNamespace })
}

async function tests() {
  reset()
  const missingGenerationWrite = await rawHealthMain({
    action: 'saveDaily', record: { date, expectedRecordRevision: 0, note: '旧客户端写入' },
  })
  assert.deepStrictEqual(missingGenerationWrite, {
    success: false,
    code: 'STALE_DATA_GENERATION',
    message: '账号数据版本已变化，请刷新后重试',
  }, '缺少 expectedCacheNamespace 的旧客户端必须被拒绝')
  assert.strictEqual(get('health_daily', recordId), undefined)
  const missingGenerationRead = await rawHealthMain({ action: 'getMonth', month: '2026-08' })
  assert.strictEqual(missingGenerationRead.code, 'STALE_DATA_GENERATION', '读请求也必须强制数据世代')

  const prepared = await health._test.preparePhoto(owner, {
    sourceSize: 1, sourceSha256: 'c'.repeat(64),
  }, date, cacheNamespace)
  assert.strictEqual(get('health_photo_uploads', prepared.token).cacheNamespace, cacheNamespace,
    '照片票据创建时必须固化当前数据世代')

  reset()
  const staged = await health._test.finalizePhoto(owner, PHOTO_INPUT, date, cacheNamespace)
  const stagedTicket = get('health_photo_uploads', staged.token)
  assert.strictEqual(stagedTicket.state, 'staged')
  assert.strictEqual(stagedTicket.permanentFileId, staged.fileID)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(stagedTicket, 'uploadStartedAtMs'), false,
    'staged 票据必须清除上传租约起始时间')
  assert.strictEqual(Object.prototype.hasOwnProperty.call(stagedTicket, 'uploadLeaseExpiresAtMs'), false,
    'staged 票据必须清除上传租约截止时间')

  reset()
  let observedUploading = null
  uploadHook = async ({ fileContent }) => {
    if (!Buffer.isBuffer(fileContent) || fileContent.length <= 1) return
    const [entry] = [...store('health_photo_uploads').entries()]
    observedUploading = { token: entry[0], ...get('health_photo_uploads', entry[0]) }
    put('meal_members', owner, { status: 'deleting', cacheNamespace })
  }
  await assert.rejects(
    () => health._test.finalizePhoto(owner, PHOTO_INPUT, date, cacheNamespace),
    (error) => error.code === 'ACCOUNT_DELETION_IN_PROGRESS',
    '上传后成员进入 deleting 时不得将票据推进到 staged',
  )
  assert(observedUploading, '测试必须在外部上传边界观察票据')
  assert.strictEqual(observedUploading.state, 'uploading')
  assert(Number.isSafeInteger(observedUploading.uploadStartedAtMs))
  assert.strictEqual(
    observedUploading.uploadLeaseExpiresAtMs,
    observedUploading.uploadStartedAtMs + 120 * 1000,
  )
  assert.strictEqual(observedUploading.permanentPath, uploadedPaths[0],
    '外部上传必须使用票据中已持久化的可信路径')
  const uploadingReceipt = get('health_photo_uploads', observedUploading.token)
  assert.strictEqual(uploadingReceipt.state, 'uploading',
    '外部上传开始后即使即时补偿完成，也必须保留租约票据供隐私删除协调')
  assert(deletedFiles.includes(`cloud://env/${observedUploading.permanentPath}`),
    'staged 写回失败后必须尽力删除已知 fileID')
  assert(uploadedPaths.filter((value) => value === observedUploading.permanentPath).length >= 2,
    'staged 写回失败后必须尽力覆盖并回收已知永久路径')

  put('meal_members', owner, { status: 'active', cacheNamespace })
  const originalNow = Date.now
  try {
    Date.now = () => uploadingReceipt.uploadLeaseExpiresAtMs - 1
    assert.strictEqual(await health._test.cleanupPhotoTicket(owner, observedUploading.token, cacheNamespace), false,
      '未到期 uploading 租约不得被普通清理领取')
    assert.strictEqual(get('health_photo_uploads', observedUploading.token).state, 'uploading')
    Date.now = () => uploadingReceipt.uploadLeaseExpiresAtMs + 1
    assert.strictEqual(await health._test.cleanupPhotoTicket(owner, observedUploading.token, cacheNamespace), true,
      '租约到期后普通清理应可回收 uploading 票据')
    assert.strictEqual(get('health_photo_uploads', observedUploading.token), undefined)
    assert.strictEqual(await health._test.cleanupPhotoTicket(owner, observedUploading.token, cacheNamespace), false,
      '已完成的租约清理必须幂等')
  } finally {
    Date.now = originalNow
  }

  reset()
  const lateToken = 'c'.repeat(48)
  const lateFile = 'cloud://env/photo-from-old-generation'
  const lateTicket = {
    owner, cacheNamespace, state: 'staged', targetDate: date,
    permanentFileId: lateFile, permanentPath: `health-photos/path/${lateToken}.jpg`,
    cleanupReady: true, expiresAt: Date.now() + 60_000,
  }
  put('health_photo_uploads', lateToken, lateTicket)
  put('meal_members', owner, { status: 'active', cacheNamespace: rotatedCacheNamespace })
  const staleGenerationWrite = await rawHealthMain({
    action: 'saveDaily', expectedCacheNamespace: cacheNamespace,
    record: { date, expectedRecordRevision: 0, note: '清空后的旧设备写入' },
  })
  assert.strictEqual(staleGenerationWrite.code, 'STALE_DATA_GENERATION')
  assert.strictEqual(get('health_daily', recordId), undefined,
    '清空轮换 namespace 后旧设备不得写回健康记录')
  await assert.rejects(
    () => health._test.updatePhotoTicket(
      owner, lateToken, { state: 'consumed' }, ['staged'], rotatedCacheNamespace,
    ),
    (error) => error.code === 'STALE_DATA_GENERATION',
    '当前世代不得更新旧世代票据',
  )
  await assert.rejects(
    () => health._test.cleanupPhotoTicket(owner, lateToken, rotatedCacheNamespace),
    (error) => error.code === 'STALE_DATA_GENERATION',
    '当前世代不得认领并清理旧世代票据',
  )
  await assert.rejects(
    () => rawCommitDailyUpdate(owner, {
      date, expectedRecordRevision: 0, note: '晚到的旧上传',
    }, lateFile, lateToken, rotatedCacheNamespace),
    (error) => error.code === 'STALE_DATA_GENERATION',
    '晚到的旧世代照片票据不得被最终提交',
  )
  assert.deepStrictEqual(get('health_photo_uploads', lateToken), lateTicket)
  assert.strictEqual(get('health_daily', recordId), undefined)
  assert.deepStrictEqual(deletedFiles, [], '拒绝旧世代票据时不能误删未获授权的文件')

  reset()
  const exerciseOnly = {
    owner, date, month: '2026-08', schemaVersion: CURRENT_HEALTH_SCHEMA, recordRevision: 4,
    weight: null, note: '', photoFileId: '',
    exercise: { completed: true, type: '步行', durationMinutes: 20, intensity: 'low' },
    futureTopLevelField: { retainedByTombstone: true },
  }
  put('health_daily', recordId, exerciseOnly)
  const otherOwner = 'openid-health-other'
  const otherRecordId = health._test.documentId(otherOwner, date)
  put('health_daily', otherRecordId, { ...exerciseOnly, owner: otherOwner })
  const cancelled = await health.main({
    action: 'saveDaily',
    record: { date, expectedRecordRevision: 4, weight: null, note: '', exercise: null },
  })
  assert.strictEqual(cancelled.success, true)
  assert.deepStrictEqual(cancelled.data, { date, recordRevision: 5, empty: true },
    '删除后的响应只返回当前空态版本，不泄露 tombstone 正文')
  assert.deepStrictEqual(get('health_daily', recordId), {
    owner, date, month: '2026-08', schemaVersion: CURRENT_HEALTH_SCHEMA, recordRevision: 5,
    weight: null, note: '', photoFileId: '', exercise: null, tombstone: true,
    futureTopLevelField: { retainedByTombstone: true },
    updatedAt: { $serverDate: true },
  }, 'tombstone 必须保留单调 revision 和可信未知字段')
  assert.deepStrictEqual(get('health_daily', otherRecordId), { ...exerciseOnly, owner: otherOwner },
    '服务端派生文档 ID 的删除不能影响同日期的其他 owner')
  const emptyMonth = await health.main({ action: 'getMonth', month: '2026-08' })
  assert.deepStrictEqual(emptyMonth, {
    success: true, data: [{ date, recordRevision: 5, empty: true }],
  }, '月查询必须返回内容为空的版本标记，不能返回 tombstone 私人字段')

  put('health_daily', recordId, exerciseOnly)
  await health._test.commitDailyUpdate(owner, {
    date, expectedRecordRevision: 4, note: '并发新增备注',
  }, '', '')
  await assert.rejects(
    () => health._test.commitDailyUpdate(owner, {
      date, expectedRecordRevision: 4, weight: null, note: '', exercise: null,
    }, '', ''),
    (error) => error.code === 'HEALTH_RECORD_REVISION_CONFLICT',
    '旧 revision 的取消请求不得删除并发更新后的记录',
  )
  assert.strictEqual(get('health_daily', recordId).note, '并发新增备注')
  assert.strictEqual(get('health_daily', recordId).exercise.completed, true)

  const oldPhoto = 'cloud://env/photo-only'
  put('health_daily', recordId, {
    owner, date, month: '2026-08', schemaVersion: CURRENT_HEALTH_SCHEMA, recordRevision: 8,
    weight: null, note: '', exercise: null, photoFileId: oldPhoto,
  })
  failHealthWriteOnce = true
  const failedPhotoClear = await health.main({
    action: 'saveDaily',
    record: { date, expectedRecordRevision: 8, weight: null, note: '', exercise: null, clearPhoto: true },
  })
  assert.strictEqual(failedPhotoClear.success, false)
  assert.strictEqual(get('health_daily', recordId).photoFileId, oldPhoto,
    '删除事务失败时必须保留当天记录及照片引用')
  assert.deepStrictEqual(deletedFiles, [], '删除事务失败时不能清理仍被记录引用的旧照片')
  assert.strictEqual(store('health_photo_uploads').size, 0,
    '健康记录事务回滚时待清理票据也必须一并回滚')
  deleteOutcomes.push(new Error('simulated storage request failure'))
  const clearedPhoto = await health.main({
    action: 'saveDaily',
    record: { date, expectedRecordRevision: 8, weight: null, note: '', exercise: null, clearPhoto: true },
  })
  assert.strictEqual(clearedPhoto.success, true)
  assert.strictEqual(get('health_daily', recordId).tombstone, true)
  assert.strictEqual(get('health_daily', recordId).recordRevision, 9)
  assert.deepStrictEqual(deletedFiles, [oldPhoto], '删除提交成功后必须清理事务内旧照片引用')
  assert.strictEqual(store('health_photo_uploads').size, 1,
    '云文件删除失败后必须保留事务内创建的持久清理票据')
  const [cleanupEntry] = [...store('health_photo_uploads').entries()]
  assert(/^[a-f0-9]{48}$/.test(cleanupEntry[0]))
  assert.deepStrictEqual(cleanupEntry[1], {
    owner, cacheNamespace, state: 'cleaning', targetDate: date,
    cleanupFileId: oldPhoto, cleanupReady: true,
    createdAt: { $serverDate: true }, updatedAt: { $serverDate: true },
    cleanupClaimedAt: { $serverDate: true }, cleanupClaimedAtMs: cleanupEntry[1].cleanupClaimedAtMs,
  }, '待清理票据只能包含当前用户、代次、日期和待删文件，不泄露给客户端')
  put('health_photo_uploads', cleanupEntry[0], { ...cleanupEntry[1], cleanupClaimedAtMs: 1 })
  deleteOutcomes.push({
    fileList: [{ fileID: oldPhoto, status: -1, code: 'STORAGE_FILE_NONEXIST', errMsg: 'storage file not exist' }],
  })
  const idempotentCleanup = await health.main({
    action: 'saveDaily', record: { date, expectedRecordRevision: 9, note: '照片清理后继续记录' },
  })
  assert.strictEqual(idempotentCleanup.success, true,
    '旧文件已不存在时必须允许持久票据幂等完成并继续保存')
  assert.strictEqual(store('health_photo_uploads').size, 0)
  assert.strictEqual(get('health_daily', recordId).note, '照片清理后继续记录')

  const permissionFile = 'cloud://env/permission-protected'
  deleteOutcomes.push({
    fileList: [{ fileID: permissionFile, status: -1, code: 'PERMISSION_DENIED', errMsg: 'permission denied' }],
  })
  await assert.rejects(
    () => health._test.deletePrivateFiles([permissionFile]),
    /健康照片清理失败/,
    '权限失败不能被误判成文件已不存在',
  )
  deleteOutcomes.push({ code: 'STORAGE_REQUEST_FAIL', message: 'storage request fail' })
  await assert.rejects(
    () => health._test.deletePrivateFiles([permissionFile]),
    /健康照片清理失败/,
    '顶层存储失败响应不能被误判成成功',
  )

  put('health_daily', recordId, {
    owner, date, month: '2026-08', schemaVersion: CURRENT_HEALTH_SCHEMA, recordRevision: 2,
    weight: null, note: '  ', exercise: null, photoFileId: '',
  })
  const filteredLegacyEmpty = await health.main({ action: 'getMonth', month: '2026-08' })
  assert.deepStrictEqual(filteredLegacyEmpty, {
    success: true, data: [{ date, recordRevision: 2, empty: true }],
  }, '部署前遗留空记录必须迁移为不含正文的版本标记')
  const replaceLegacyEmpty = await health.main({
    action: 'saveDaily', record: { date, expectedRecordRevision: 2, note: '重新记录' },
  })
  assert.strictEqual(replaceLegacyEmpty.success, true,
    '客户端使用月查询得到的历史空态版本后必须能重新记录')
  assert.strictEqual(get('health_daily', recordId).note, '重新记录')
  assert.strictEqual(get('health_daily', recordId).recordRevision, 3,
    '历史空文档重建必须从其已存 revision 继续递增')

  reset()
  put('health_daily', recordId, {
    owner, date, month: '2026-08', schemaVersion: CURRENT_HEALTH_SCHEMA, recordRevision: 1,
    weight: null, note: '设备 A 初始内容', exercise: null, photoFileId: '',
  })
  const deletedToTombstone = await health.main({
    action: 'saveDaily',
    record: { date, expectedRecordRevision: 1, weight: null, note: '', exercise: null },
  })
  assert.strictEqual(deletedToTombstone.success, true)
  assert.deepStrictEqual(deletedToTombstone.data, { date, recordRevision: 2, empty: true },
    '客户端只接收当前空态版本，不接收 tombstone 正文')
  assert.strictEqual(get('health_daily', recordId).recordRevision, 2)
  assert.strictEqual(get('health_daily', recordId).tombstone, true)
  const rebuiltByDeviceB = await health.main({
    action: 'saveDaily',
    record: { date, expectedRecordRevision: 2, weight: 62.1, note: '设备 B 重建' },
  })
  assert.strictEqual(rebuiltByDeviceB.success, true)
  assert.strictEqual(rebuiltByDeviceB.data.recordRevision, 3,
    '重建必须从 tombstone 的 revision 继续单调递增')
  const staleDeviceA = await health.main({
    action: 'saveDaily',
    record: { date, expectedRecordRevision: 1, weight: 58.8, note: '设备 A 删除前旧表单' },
  })
  assert.deepStrictEqual(staleDeviceA, {
    success: false, code: 'HEALTH_RECORD_REVISION_CONFLICT',
    message: '这一天已在其他设备更新，请刷新后重新确认',
  }, '删除前旧 revision 在另一设备重建后必须冲突，不能发生 ABA')
  assert.strictEqual(get('health_daily', recordId).weight, 62.1)
  assert.strictEqual(get('health_daily', recordId).note, '设备 B 重建')
  assert.strictEqual(get('health_daily', recordId).recordRevision, 3)

  reset()
  const initialEmptyDeviceARevision = 0
  const createdByDeviceB = await health.main({
    action: 'saveDaily',
    record: { date, expectedRecordRevision: 0, note: '设备 B 从空态创建' },
  })
  assert.strictEqual(createdByDeviceB.data.recordRevision, 1)
  const clearedByDeviceB = await health.main({
    action: 'saveDaily',
    record: { date, expectedRecordRevision: 1, note: '' },
  })
  assert.deepStrictEqual(clearedByDeviceB.data, { date, recordRevision: 2, empty: true })
  const staleInitialEmptyWrite = await health.main({
    action: 'saveDaily',
    record: { date, expectedRecordRevision: initialEmptyDeviceARevision, note: '设备 A 的旧空态写入' },
  })
  assert.deepStrictEqual(staleInitialEmptyWrite, {
    success: false, code: 'HEALTH_RECORD_REVISION_CONFLICT',
    message: '这一天已在其他设备更新，请刷新后重新确认',
  }, '空到有再回空后，最初看到 revision 0 的旧设备必须冲突')
  const refreshedEmptyMonth = await health.main({ action: 'getMonth', month: '2026-08' })
  assert.deepStrictEqual(refreshedEmptyMonth, {
    success: true, data: [{ date, recordRevision: 2, empty: true }],
  }, '冲突刷新只能返回当前空态版本，不得返回已清空正文')
  const rebuiltAfterEmptyRefresh = await health.main({
    action: 'saveDaily',
    record: { date, expectedRecordRevision: 2, note: '刷新空态后安全重建' },
  })
  assert.strictEqual(rebuiltAfterEmptyRefresh.success, true)
  assert.strictEqual(rebuiltAfterEmptyRefresh.data.recordRevision, 3)
  assert.strictEqual(get('health_daily', recordId).note, '刷新空态后安全重建')

  reset()
  const firstPhotoSave = await health.main({
    action: 'saveDaily',
    record: { date, expectedRecordRevision: 0, note: '首次照片', photoImage: PHOTO_INPUT },
  })
  assert.strictEqual(firstPhotoSave.success, true)
  assert.strictEqual(get('health_daily', recordId).photoFileId.startsWith('cloud://env/health-photos/'), true)
  assert.strictEqual(store('health_photo_uploads').size, 0,
    '首次照片没有旧文件待删时必须在提交事务内移除 consumed 票据')

  reset()
  const legacyToken = 'd'.repeat(48)
  const legacyPath = `health-photos/${crypto.createHash('sha256').update(owner).digest('hex').slice(0, 24)}/${date}-${legacyToken}.png`
  const legacyFile = `cloud://env/${legacyPath}`
  put('health_photo_uploads', legacyToken, {
    owner, state: 'staged', targetDate: date,
    permanentPath: legacyPath, permanentFileId: legacyFile,
    cleanupReady: false, expiresAt: Date.now() - 1,
  })
  const migratedLegacyCleanup = await health.main({
    action: 'saveDaily', record: { date, expectedRecordRevision: 0, note: '升级后记录' },
  })
  assert.strictEqual(migratedLegacyCleanup.success, true)
  assert.strictEqual(get('health_photo_uploads', legacyToken), undefined,
    '升级前无 cacheNamespace 的过期票据必须经严格归属校验后完成清理')
  assert(deletedFiles.includes(legacyFile))

  reset()
  const liveLegacyToken = 'e'.repeat(48)
  const liveLegacyPath = `health-photos/${crypto.createHash('sha256').update(owner).digest('hex').slice(0, 24)}/${date}-${liveLegacyToken}.png`
  const liveLegacyFile = `cloud://env/${liveLegacyPath}`
  const liveLegacyTicket = {
    owner, state: 'staged', targetDate: date,
    permanentPath: liveLegacyPath, permanentFileId: liveLegacyFile,
    cleanupReady: false, expiresAt: Date.now() + 60_000,
  }
  put('health_photo_uploads', liveLegacyToken, liveLegacyTicket)
  await assert.rejects(
    () => rawCommitDailyUpdate(owner, {
      date, expectedRecordRevision: 0, note: '不得消费旧世代照片',
    }, liveLegacyFile, liveLegacyToken, cacheNamespace),
    (error) => error.code === 'STALE_DATA_GENERATION',
    '无 cacheNamespace 的旧票据只能安全清理，不能绑定后跨世代消费',
  )
  assert.deepStrictEqual(get('health_photo_uploads', liveLegacyToken), liveLegacyTicket)
  assert.strictEqual(get('health_daily', recordId), undefined)

  const unsafeLegacyToken = 'f'.repeat(48)
  put('health_photo_uploads', unsafeLegacyToken, {
    owner, state: 'cleanup', targetDate: date,
    permanentPath: 'health-photos/another-user/private.png',
    cleanupReady: true, expiresAt: Date.now() - 1,
  })
  await assert.rejects(
    () => health._test.cleanupPhotoTicket(owner, unsafeLegacyToken, cacheNamespace),
    /照片上传凭证已失效/,
    '不匹配当前 owner/date/token 的旧路径不得绑定或清理',
  )
  assert.deepStrictEqual(deletedFiles, [])
  assert(get('health_photo_uploads', unsafeLegacyToken), '不可信旧票据必须保留供安全迁移或人工审计')

  const wrongDateCleanupToken = '1'.repeat(48)
  put('health_photo_uploads', wrongDateCleanupToken, {
    owner, state: 'consumed', targetDate: date,
    permanentPath: '', permanentFileId: '',
    cleanupFileId: `cloud://env/health-photos/${crypto.createHash('sha256').update(owner).digest('hex').slice(0, 24)}/2026-08-25-old.png`,
    cleanupReady: true, expiresAt: Date.now() - 1,
  })
  await assert.rejects(
    () => health._test.cleanupPhotoTicket(owner, wrongDateCleanupToken, cacheNamespace),
    /照片上传凭证已失效/,
    '旧票据不得清理当前 owner 在其他日期的照片',
  )
  assert(get('health_photo_uploads', wrongDateCleanupToken))
  assert.deepStrictEqual(deletedFiles, [])

  reset()
  put('health_daily', recordId, {
    owner, date, month: '2026-08', schemaVersion: 1,
    weight: 60, note: '旧备注', exercise: null, photoFileId: '',
  })
  const migrated = await health._test.commitDailyUpdate(owner, {
    date, expectedRecordRevision: 0, note: '迁移后备注',
  }, '', '')
  assert.strictEqual(migrated.data.recordRevision, 1)
  assert.strictEqual(get('health_daily', recordId).recordRevision, 1)
  assert.strictEqual(health._test.publicRecord({ date }).recordRevision, 0)

  const deviceA = await health._test.commitDailyUpdate(owner, {
    date, expectedRecordRevision: 1, note: '设备 A 新备注',
  }, '', '')
  assert.strictEqual(deviceA.data.recordRevision, 2)
  await assert.rejects(
    () => health._test.commitDailyUpdate(owner, {
      date, expectedRecordRevision: 1, weight: 61,
    }, '', ''),
    (error) => error.code === 'HEALTH_RECORD_REVISION_CONFLICT',
  )
  const afterConflict = get('health_daily', recordId)
  assert.strictEqual(afterConflict.note, '设备 A 新备注')
  assert.strictEqual(afterConflict.weight, 60, '旧设备的不同字段也不能自动合并覆盖')
  assert.strictEqual(afterConflict.recordRevision, 2)

  put('health_daily', recordId, {
    ...afterConflict,
    exercise: {
      completed: true, type: '步行', durationMinutes: 20, intensity: 'low',
      futureServerField: { retained: true },
    },
    futureTopLevelField: { retainedByPatch: true },
  })
  const exerciseSave = await health.main({
    action: 'saveDaily',
    record: {
      date, expectedRecordRevision: 2,
      exercise: {
        completed: true, type: '骑行', durationMinutes: 45, intensity: 'high',
        futureClientField: 'must-not-be-stored',
      },
      futureClientTopLevel: 'must-not-be-stored',
    },
  })
  assert.strictEqual(exerciseSave.success, true)
  const afterExercise = get('health_daily', recordId)
  assert.strictEqual(afterExercise.recordRevision, 3)
  assert.deepStrictEqual(afterExercise.exercise, {
    completed: true, type: '骑行', durationMinutes: 45, intensity: 'high',
    futureServerField: { retained: true },
  }, '公开入口必须只接收运动白名单字段，同时保留可信记录中的未来字段')
  assert.strictEqual(Object.prototype.hasOwnProperty.call(afterExercise.exercise, 'futureClientField'), false)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(afterExercise, 'futureClientTopLevel'), false)
  assert.deepStrictEqual(afterExercise.futureTopLevelField, { retainedByPatch: true },
    '局部更新不得删除可信记录的顶层未来字段')

  const stagedToken = 'a'.repeat(48)
  const stagedFile = 'cloud://env/photo-new'
  put('health_photo_uploads', stagedToken, {
    owner, cacheNamespace, state: 'staged', targetDate: date, permanentFileId: stagedFile,
    permanentPath: `health-photos/path/${stagedToken}.jpg`, cleanupReady: false,
    expiresAt: Date.now() + 60_000,
  })
  await assert.rejects(
    () => health._test.commitDailyUpdate(owner, {
      date, expectedRecordRevision: 1, note: '旧设备照片备注',
    }, stagedFile, stagedToken),
    (error) => error.code === 'HEALTH_RECORD_REVISION_CONFLICT',
  )
  assert.strictEqual(get('health_photo_uploads', stagedToken).state, 'staged', '版本冲突不能消费照片票据')
  assert.strictEqual(get('health_photo_uploads', stagedToken).permanentFileId, stagedFile)
  assert.strictEqual(get('health_daily', recordId).photoFileId, '')

  failHealthWriteOnce = true
  await assert.rejects(
    () => health._test.commitDailyUpdate(owner, {
      date, expectedRecordRevision: 3, note: '事务失败',
    }, stagedFile, stagedToken),
    /simulated record write failure/,
  )
  assert.strictEqual(get('health_photo_uploads', stagedToken).state, 'staged', '记录写失败必须回滚票据消费')
  assert.strictEqual(get('health_daily', recordId).note, '设备 A 新备注')

  const publicConflict = await health.main({
    action: 'saveDaily',
    record: { date, expectedRecordRevision: 1, weight: 62 },
  })
  assert.deepStrictEqual(publicConflict, {
    success: false,
    code: 'HEALTH_RECORD_REVISION_CONFLICT',
    message: '这一天已在其他设备更新，请刷新后重新确认',
  }, '公开云函数入口必须稳定返回记录冲突码')

  const futureToken = 'b'.repeat(48)
  const futureFile = 'cloud://env/photo-future'
  const futureRecord = {
    ...get('health_daily', recordId),
    schemaVersion: CURRENT_HEALTH_SCHEMA + 1,
    recordRevision: 9,
    note: '未来版本记录',
  }
  const futureTicket = {
    owner, cacheNamespace, state: 'staged', targetDate: date, permanentFileId: futureFile,
    permanentPath: `health-photos/path/${futureToken}.jpg`, cleanupReady: false,
    expiresAt: Date.now() + 60_000,
  }
  put('health_daily', recordId, futureRecord)
  put('health_photo_uploads', futureToken, futureTicket)
  await assert.rejects(
    () => health._test.commitDailyUpdate(owner, {
      date, expectedRecordRevision: 9, note: '禁止降级覆盖',
    }, futureFile, futureToken),
    (error) => error.code === 'HEALTH_RECORD_SCHEMA_UNSUPPORTED',
  )
  assert.deepStrictEqual(get('health_daily', recordId), futureRecord,
    '未来 schema 被拒绝后不得改写健康记录')
  assert.deepStrictEqual(get('health_photo_uploads', futureToken), futureTicket,
    '未来 schema 必须在读取或消费照片票据前被拒绝')

  const publicFutureSchema = await health.main({
    action: 'saveDaily',
    record: { date, expectedRecordRevision: 9, weight: 62 },
  })
  assert.deepStrictEqual(publicFutureSchema, {
    success: false,
    code: 'HEALTH_RECORD_SCHEMA_UNSUPPORTED',
    message: '健康记录来自较新版本，请更新小程序后再保存',
  }, '公开云函数入口必须稳定返回未来健康 schema 错误码')
  assert.deepStrictEqual(get('health_daily', recordId), futureRecord)

  const privateDetail = 'private database detail must not escape'
  failHealthQueryOnce = true
  const unknown = await health.main({ action: 'getMonth', month: '2026-08' })
  assert.deepStrictEqual(unknown, {
    success: false,
    code: 'HEALTH_FAILED',
    message: '健康记录服务暂时不可用',
  })
  assert.strictEqual(JSON.stringify(unknown).includes(privateDetail), false)

  memberReadError = Object.assign(new Error(privateDetail), { code: 'MEMBERSHIP_REQUIRED' })
  const known = await health.main({ action: 'getMonth', month: '2026-08' })
  assert.deepStrictEqual(known, {
    success: false,
    code: 'MEMBERSHIP_REQUIRED',
    message: '需要有效邀请才能使用',
  })
  assert.strictEqual(JSON.stringify(known).includes(privateDetail), false)

  console.log('health transaction CAS tests passed')
}

tests().catch((error) => { console.error(error); process.exitCode = 1 })
