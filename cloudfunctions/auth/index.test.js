'use strict'

const assert = require('assert')
const crypto = require('crypto')
const Module = require('module')
const path = require('path')
const { EventEmitter } = require('events')
const { downloadImageSource: realDownloadImageSource } = require('./image-source')

const OPENID = 'test-user'
const CACHE_NAMESPACE = 'a'.repeat(32)
const ROTATED_NAMESPACE = 'b'.repeat(32)
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const AVATAR_INPUT = {
  sourceUrl: 'https://example.test/avatar.png', sourceSize: PNG.length,
  sourceSha256: crypto.createHash('sha256').update(PNG).digest('hex'),
}

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) }

const stores = new Map()
let transactionError = null
let memberReadError = null
let beforeTransaction = null
let downloadHandler = async () => PNG
let phoneHandler
let uploadHook = null
let deleteFailureCount = 0
let deletedFiles = []
let uploadedPaths = []

function bucket(name, source = stores) {
  if (!source.has(name)) source.set(name, new Map())
  return source.get(name)
}

function applyUpdate(current, data) {
  const next = { ...clone(current || {}) }
  Object.entries(data || {}).forEach(([key, value]) => {
    if (value && value.__operation === 'remove') delete next[key]
    else if (value && value.__operation === 'inc') next[key] = Number(next[key] || 0) + value.value
    else next[key] = clone(value)
  })
  return next
}

function reference(name, id, source = stores) {
  return {
    async get() {
      if (name === 'meal_members' && memberReadError) {
        const error = memberReadError
        memberReadError = null
        throw error
      }
      return { data: clone(bucket(name, source).get(id)) || null }
    },
    async set({ data }) { bucket(name, source).set(id, clone(data)) },
    async update({ data }) {
      const records = bucket(name, source)
      records.set(id, applyUpdate(records.get(id), data))
    },
    async remove() { bucket(name, source).delete(id) },
  }
}

function query(name, criteria, source = stores) {
  return {
    limit() { return this },
    async get() {
      const data = [...bucket(name, source).entries()]
        .map(([id, value]) => ({ _id: id, ...clone(value) }))
        .filter((record) => Object.entries(criteria || {}).every(([key, value]) => record[key] === value))
      return { data }
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
  stores.forEach((records, name) => {
    result.set(name, new Map([...records].map(([id, value]) => [id, clone(value)])))
  })
  return result
}

const database = {
  command: {
    inc: (value) => ({ __operation: 'inc', value }),
    remove: () => ({ __operation: 'remove' }),
  },
  collection,
  serverDate() { return { $serverDate: true } },
  async runTransaction(callback) {
    if (transactionError) {
      const error = transactionError
      transactionError = null
      throw error
    }
    if (beforeTransaction) {
      const hook = beforeTransaction
      beforeTransaction = null
      await hook()
    }
    const working = snapshot()
    const result = await callback({ collection: (name) => collection(name, working) })
    stores.clear()
    working.forEach((records, name) => stores.set(name, records))
    return result
  },
}

const cloudStub = {
  DYNAMIC_CURRENT_ENV: 'dynamic-current-env',
  init() {},
  database() { return database },
  getWXContext() { return { OPENID } },
  async deleteFile({ fileList }) {
    if (deleteFailureCount > 0) {
      deleteFailureCount -= 1
      throw new Error('simulated cleanup failure')
    }
    deletedFiles.push(...fileList)
    return { fileList: fileList.map((fileID) => ({ fileID, status: 0 })) }
  },
  async getTempFileURL({ fileList }) {
    return { fileList: fileList.map((fileID) => ({ fileID, tempFileURL: `temp://${fileID}` })) }
  },
  async uploadFile({ cloudPath, fileContent }) {
    uploadedPaths.push(cloudPath)
    if (uploadHook) await uploadHook({ cloudPath, fileContent })
    return { fileID: `cloud://env/${cloudPath}` }
  },
  openapi: { phonenumber: { getPhoneNumber: (...args) => phoneHandler(...args) } },
}

function validMetadata(input = {}, maxBytes, label) {
  const size = Number(input.sourceSize)
  const sha256 = typeof input.sourceSha256 === 'string' ? input.sourceSha256 : ''
  if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes || !/^[a-f0-9]{64}$/.test(sha256)) {
    const error = new Error(`${label}文件信息无效，请重新选择`)
    error.code = 'IMAGE_METADATA_INVALID'
    throw error
  }
  return { size, sha256 }
}

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloudStub
  if (request === './image-source' && parent && parent.filename.endsWith(path.join('auth', 'index.js'))) {
    return { validMetadata, downloadImageSource: (...args) => downloadHandler(...args) }
  }
  return originalLoad.call(this, request, parent, isMain)
}
let auth
try { auth = require('./index') } finally { Module._load = originalLoad }

function put(name, id, value) { bucket(name).set(id, clone(value)) }
function get(name, id) { return clone(bucket(name).get(id)) }
function records(name) {
  return [...bucket(name).entries()].map(([id, value]) => ({ _id: id, ...clone(value) }))
}

function reset() {
  stores.clear()
  transactionError = null
  memberReadError = null
  beforeTransaction = null
  downloadHandler = async () => PNG
  phoneHandler = async () => { throw Object.assign(new Error('private phone provider detail'), { errCode: 45011 }) }
  uploadHook = null
  deleteFailureCount = 0
  deletedFiles = []
  uploadedPaths = []
  put('meal_members', OPENID, { status: 'active', cacheNamespace: CACHE_NAMESPACE })
  put('meal_users', OPENID, {
    schemaVersion: 2, nickname: '旧昵称', avatarFileId: 'cloud://env/avatar-old',
    phoneBound: false, maskedPhone: '', phoneBoundAt: null, loginCount: 1,
  })
}

function staleResponse() {
  return {
    success: false, code: 'STALE_DATA_GENERATION',
    message: '账号数据版本已变化，请刷新后重试',
  }
}

async function testPublicErrorBoundary() {
  reset()
  const privateDetail = 'private database detail must not escape'
  transactionError = Object.assign(new Error(privateDetail), { code: 'PRIVATE_DATABASE_FAILURE' })
  const unknown = await auth.main({ action: 'login', expectedCacheNamespace: CACHE_NAMESPACE })
  assert.deepStrictEqual(unknown, {
    success: false, code: 'AUTH_FAILED', message: '账号服务暂时不可用',
  })
  assert.strictEqual(JSON.stringify(unknown).includes(privateDetail), false)

  reset()
  memberReadError = Object.assign(new Error(privateDetail), { code: 'MEMBERSHIP_REQUIRED' })
  const known = await auth.main({ action: 'login', expectedCacheNamespace: CACHE_NAMESPACE })
  assert.deepStrictEqual(known, {
    success: false, code: 'MEMBERSHIP_REQUIRED', message: '需要有效邀请才能使用',
  })
  assert.strictEqual(JSON.stringify(known).includes(privateDetail), false)
}

async function testEveryActionRejectsMissingAndStaleGeneration() {
  const events = [
    { action: 'login' },
    { action: 'updateProfile', profile: { nickname: '不得写入' } },
    { action: 'bindPhoneNumber', code: 'single-use-test-code' },
  ]
  for (const event of events) {
    for (const expectedCacheNamespace of [undefined, ROTATED_NAMESPACE]) {
      reset()
      const before = get('meal_users', OPENID)
      const response = await auth.main({ ...event, expectedCacheNamespace })
      assert.deepStrictEqual(response, staleResponse(), `${event.action} 必须拒绝缺失或旧身份世代`)
      assert.deepStrictEqual(get('meal_users', OPENID), before)
      assert.deepStrictEqual(uploadedPaths, [])
    }
  }
}

async function testProfileWriteRechecksGenerationInTransaction() {
  reset()
  beforeTransaction = async () => {
    put('meal_members', OPENID, { status: 'active', cacheNamespace: ROTATED_NAMESPACE })
  }
  const response = await auth.main({
    action: 'updateProfile', expectedCacheNamespace: CACHE_NAMESPACE,
    profile: { nickname: '迟到昵称' },
  })
  assert.deepStrictEqual(response, staleResponse())
  assert.strictEqual(get('meal_users', OPENID).nickname, '旧昵称')
}

async function testRetiredPhoneCannotBeReintroduced() {
  reset()
  let called = false
  phoneHandler = async () => { called = true; throw Error('must not request phone') }
  for (const code of ['', 'synthetic-code']) {
    const before = get('meal_users', OPENID)
    const result = await auth.main({ action: 'bindPhoneNumber', code, expectedCacheNamespace: CACHE_NAMESPACE })
    assert.strictEqual(result.code, 'PHONE_FEATURE_REMOVED')
    assert.strictEqual(called, false)
    assert.deepStrictEqual(get('meal_users', OPENID), before)
  }
  const legacy = { ...get('meal_users', OPENID), phoneBound: true, maskedPhone: '****0000',
    phoneNumber: 'synthetic-private-phone', purePhoneNumber: 'synthetic-private-phone', countryCode: '00' }
  for (const action of ['login', 'updateProfile']) {
    put('meal_users', OPENID, legacy)
    const result = await auth.main({ action, profile: { nickname: '新昵称', maskedPhone: '****1111' }, expectedCacheNamespace: CACHE_NAMESPACE })
    assert.strictEqual(result.success, true)
    for (const field of ['phoneBound', 'maskedPhone', 'phoneBoundAt', 'phoneNumber', 'purePhoneNumber', 'countryCode']) {
      assert(!Object.hasOwn(get('meal_users', OPENID), field))
      assert(!Object.hasOwn(result.data, field))
    }
    assert.strictEqual(get('meal_users', OPENID).avatarFileId, legacy.avatarFileId)
  }
}

async function testRotationAfterDownloadPreventsUpload() {
  reset()
  downloadHandler = async () => {
    put('meal_members', OPENID, { status: 'active', cacheNamespace: ROTATED_NAMESPACE })
    return PNG
  }
  const response = await auth.main({
    action: 'updateProfile', expectedCacheNamespace: CACHE_NAMESPACE,
    profile: { nickname: '迟到下载', avatarImage: AVATAR_INPUT },
  })
  assert.deepStrictEqual(response, staleResponse())
  assert.deepStrictEqual(uploadedPaths, [], '下载后世代变化时不得开始永久文件上传')
  assert.strictEqual(get('meal_users', OPENID).avatarFileId, 'cloud://env/avatar-old')
  const [ticket] = records('meal_avatar_uploads')
  assert.strictEqual(ticket.cacheNamespace, CACHE_NAMESPACE)
  assert.strictEqual(ticket.state, 'prepared')
}

async function testLateUploadCannotCommitAfterMembershipChange(nextMember, expectedCode) {
  reset()
  let changed = false
  uploadHook = async ({ fileContent }) => {
    if (!changed && Buffer.isBuffer(fileContent) && fileContent.length > 1) {
      changed = true
      put('meal_members', OPENID, nextMember)
    }
  }
  const response = await auth.main({
    action: 'updateProfile', expectedCacheNamespace: CACHE_NAMESPACE,
    profile: { nickname: '迟到上传', avatarImage: AVATAR_INPUT },
  })
  assert.strictEqual(response.success, false)
  assert.strictEqual(response.code, expectedCode)
  assert.strictEqual(get('meal_users', OPENID).nickname, '旧昵称')
  assert.strictEqual(get('meal_users', OPENID).avatarFileId, 'cloud://env/avatar-old')
  const [ticket] = records('meal_avatar_uploads')
  assert.strictEqual(ticket.cacheNamespace, CACHE_NAMESPACE, '头像票据必须固化创建时身份世代')
  assert.strictEqual(ticket.state, 'uploading', '迟到上传必须保留可恢复的 uploading 票据')
  assert(Number.isSafeInteger(ticket.uploadStartedAtMs))
  assert.strictEqual(ticket.uploadLeaseExpiresAtMs, ticket.uploadStartedAtMs + 120 * 1000)
  assert(ticket.permanentPath.endsWith('.png'))
  assert(uploadedPaths.some((value) => value.startsWith('avatars/')), '测试必须实际越过永久文件上传边界')
  assert(deletedFiles.some((value) => value.startsWith('cloud://env/avatars/')),
    '世代变化后必须尽力删除已经上传的永久文件')
  assert(uploadedPaths.filter((value) => value.startsWith('avatars/')).length >= 2,
    '世代变化后必须用占位覆盖尽力回收已知孤儿路径')
}

async function testFailedCompensationKeepsReceiptUntilLeaseRetry() {
  reset()
  let firstUpload = true
  uploadHook = async ({ fileContent }) => {
    if (firstUpload && Buffer.isBuffer(fileContent) && fileContent.length > 1) {
      firstUpload = false
      transactionError = new Error('simulated staging failure')
    }
  }
  deleteFailureCount = 2
  const response = await auth.main({
    action: 'updateProfile', expectedCacheNamespace: CACHE_NAMESPACE,
    profile: { nickname: '不得提交', avatarImage: AVATAR_INPUT },
  })
  assert.deepStrictEqual(response, {
    success: false, code: 'AUTH_FAILED', message: '账号服务暂时不可用',
  })
  const [receipt] = records('meal_avatar_uploads')
  assert.strictEqual(receipt.state, 'uploading')
  assert.strictEqual(receipt.cacheNamespace, CACHE_NAMESPACE)
  assert.strictEqual(get('meal_users', OPENID).nickname, '旧昵称')
  assert.strictEqual(deletedFiles.length, 0, '模拟的两次即时清理都必须失败')

  const originalNow = Date.now
  Date.now = () => receipt.uploadLeaseExpiresAtMs + 1
  try {
    uploadHook = null
    const firstRetry = await auth.main({ action: 'login', expectedCacheNamespace: CACHE_NAMESPACE })
    assert.strictEqual(firstRetry.success, true)
    assert.deepStrictEqual(records('meal_avatar_uploads'), [], '租约过期后登录必须重试并删除清理票据')
    const cleanupCount = deletedFiles.length
    const secondRetry = await auth.main({ action: 'login', expectedCacheNamespace: CACHE_NAMESPACE })
    assert.strictEqual(secondRetry.success, true)
    assert.strictEqual(deletedFiles.length, cleanupCount, '已完成的租约清理必须幂等')
  } finally {
    Date.now = originalNow
  }
}

async function testCleanupReadyCannotOverrideLiveUploadLease() {
  reset()
  const token = 'c'.repeat(48)
  const uploadStartedAtMs = Date.now()
  const ticket = {
    owner: OPENID, cacheNamespace: CACHE_NAMESPACE,
    state: 'uploading', cleanupReady: true,
    permanentPath: `avatars/${crypto.createHash('sha256').update(OPENID).digest('hex').slice(0, 24)}/${token}.png`,
    uploadStartedAtMs, uploadLeaseExpiresAtMs: uploadStartedAtMs + 120 * 1000,
    expiresAt: uploadStartedAtMs + 15 * 60 * 1000,
  }
  put('meal_avatar_uploads', token, ticket)
  const response = await auth.main({ action: 'login', expectedCacheNamespace: CACHE_NAMESPACE })
  assert.strictEqual(response.success, true)
  assert.deepStrictEqual(get('meal_avatar_uploads', token), ticket,
    'cleanupReady 不能绕过尚未到期的上传租约')
  assert.deepStrictEqual(deletedFiles, [])
  assert.deepStrictEqual(uploadedPaths, [])
}

async function testLateUploadsAreBlocked() {
  await testLateUploadCannotCommitAfterMembershipChange(
    { status: 'active', cacheNamespace: ROTATED_NAMESPACE }, 'STALE_DATA_GENERATION',
  )
  await testLateUploadCannotCommitAfterMembershipChange(
    { status: 'deleting', cacheNamespace: CACHE_NAMESPACE }, 'ACCOUNT_DELETION_IN_PROGRESS',
  )
}

async function testSuccessfulAvatarCommitConsumesAndCleansTicket() {
  reset()
  const response = await auth.main({
    action: 'updateProfile', expectedCacheNamespace: CACHE_NAMESPACE,
    profile: { nickname: '新昵称', avatarImage: AVATAR_INPUT },
  })
  assert.strictEqual(response.success, true)
  const profile = get('meal_users', OPENID)
  assert.strictEqual(profile.nickname, '新昵称')
  assert(profile.avatarFileId.startsWith('cloud://env/avatars/'))
  assert.deepStrictEqual(records('meal_avatar_uploads'), [], '成功提交后必须完成同世代票据清理')
  assert(deletedFiles.includes('cloud://env/avatar-old'), '成功替换后必须清理旧头像')
}

async function testCdnSourceThroughRealImageValidation() {
  // Exercise the real downloader and file checks, not the default PNG stub.
  // Only DNS/network/storage are fake; no real member or image is involved.
  for (const content of [PNG, Buffer.from('avatar-transport-synthetic-probe')]) {
    reset()
    const originalProfile = get('meal_users', OPENID)
    const contents = []
    uploadHook = async ({ fileContent }) => { contents.push(fileContent) }
    const requests = []
    downloadHandler = (input, options) => realDownloadImageSource(input, {
      ...options,
      dependencies: {
        now: () => Date.now(),
        lookup: async () => [{ address: '8.8.8.8', family: 4 }],
        request(options, callback) {
          requests.push(options)
          const request = new EventEmitter()
          request.setTimeout = () => {}
          request.end = () => {
            const response = new EventEmitter()
            response.statusCode = 200
            response.headers = { 'content-length': String(content.length) }
            response.destroy = () => {}
            callback(response)
            response.emit('data', content)
            response.emit('end')
          }
          return request
        },
      },
    })
    const response = await auth.main({
      action: 'updateProfile', expectedCacheNamespace: CACHE_NAMESPACE,
      profile: {
        nickname: '虚构昵称', avatarImage: {
          sourceUrl: 'http://cdn.example/avatar', sourceSize: content.length,
          sourceSha256: crypto.createHash('sha256').update(content).digest('hex'),
        },
      },
    })
    assert.strictEqual(requests.length, 1)
    assert.strictEqual(requests[0].port, 443)
    assert.strictEqual(requests[0].rejectUnauthorized, true)
    assert.deepStrictEqual(records('meal_avatar_uploads'), [])
    if (content === PNG) {
      assert.strictEqual(response.success, true)
      assert.strictEqual(get('meal_users', OPENID).nickname, '虚构昵称')
      assert.strictEqual(uploadedPaths.length, 1)
    } else {
      assert.strictEqual(response.success, false)
      assert.strictEqual(response.message, '头像必须是 JPG、PNG 或 WebP 图片')
      assert.deepStrictEqual(get('meal_users', OPENID), originalProfile)
      // Existing ticket cleanup may reclaim its own orphan path using a
      // one-byte placeholder; it must never upload the invalid source as an
      // avatar or delete the active avatar.
      assert(contents.every(value => value.equals(Buffer.from([0]))))
      assert(!deletedFiles.includes(originalProfile.avatarFileId))
    }
  }
}

async function testAuthStoreSendsExpectedGeneration() {
  const authStorePath = path.resolve(__dirname, '../../miniprogram/services/auth-store.js')
  const cloudPath = path.resolve(__dirname, '../../miniprogram/utils/cloud.js')
  const membershipPath = path.resolve(__dirname, '../../miniprogram/services/membership-store.js')
  const calls = []
  const memberStore = {
    cacheNamespace: CACHE_NAMESPACE,
    onCacheNamespaceChange() { return () => {} },
  }
  require.cache[cloudPath] = {
    id: cloudPath, filename: cloudPath, loaded: true,
    exports: {
      wxLogin: async () => ({}),
      callFunction: async (name, action, payload) => {
        calls.push({ name, action, payload })
        return { nickname: action }
      },
    },
  }
  require.cache[membershipPath] = {
    id: membershipPath, filename: membershipPath, loaded: true,
    exports: { membershipStore: memberStore },
  }
  const storage = new Map()
  global.wx = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
  }
  delete require.cache[authStorePath]
  const { AuthStore } = require(authStorePath)
  const store = new AuthStore(memberStore)
  await store.init({ force: true })
  await store.updateProfile({ nickname: '客户端昵称' })
  assert.strictEqual(store.bindPhoneNumber, undefined)
  assert.deepStrictEqual(calls, [
    { name: 'auth', action: 'login', payload: { expectedCacheNamespace: CACHE_NAMESPACE } },
    {
      name: 'auth', action: 'updateProfile',
      payload: { profile: { nickname: '客户端昵称' }, expectedCacheNamespace: CACHE_NAMESPACE },
    },
  ])
}

async function tests() {
  await testPublicErrorBoundary()
  await testEveryActionRejectsMissingAndStaleGeneration()
  await testProfileWriteRechecksGenerationInTransaction()
  await testRetiredPhoneCannotBeReintroduced()
  await testRotationAfterDownloadPreventsUpload()
  await testLateUploadsAreBlocked()
  await testFailedCompensationKeepsReceiptUntilLeaseRetry()
  await testCleanupReadyCannotOverrideLiveUploadLease()
  await testSuccessfulAvatarCommitConsumesAndCleansTicket()
  await testCdnSourceThroughRealImageValidation()
  await testAuthStoreSendsExpectedGeneration()
  console.log('auth generation and public boundary tests passed')
}

tests().catch((error) => { console.error(error); process.exitCode = 1 })
