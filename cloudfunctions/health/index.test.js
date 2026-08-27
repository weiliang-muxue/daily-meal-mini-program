'use strict'

const assert = require('assert')
const Module = require('module')
const { CURRENT_HEALTH_SCHEMA } = require('./daily-core')

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

const stores = new Map()
let failHealthWriteOnce = false
let failHealthQueryOnce = false
let memberReadError = null

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
      store(name, source).set(id, { ...clone(current), ...clone(data) })
    },
    async remove() { store(name, source).delete(id) },
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
  command: { gte: (value) => ({ value, and: () => ({}) }) },
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
  async deleteFile() { return { fileList: [] } },
  async getTempFileURL() { return { fileList: [] } },
  async uploadFile() { return { fileID: 'cloud://env/placeholder' } },
}

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloudStub
  return originalLoad.call(this, request, parent, isMain)
}
let health
try { health = require('./index') } finally { Module._load = originalLoad }

const owner = 'openid-health-owner'
const date = '2026-08-26'
const recordId = health._test.documentId(owner, date)

function put(name, id, value) { store(name).set(id, clone(value)) }
function get(name, id) { return clone(store(name).get(id)) }
function reset() {
  stores.clear()
  failHealthWriteOnce = false
  failHealthQueryOnce = false
  memberReadError = null
  put('meal_members', owner, { status: 'active' })
}

async function tests() {
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
    owner, state: 'staged', targetDate: date, permanentFileId: stagedFile,
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
    owner, state: 'staged', targetDate: date, permanentFileId: futureFile,
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
