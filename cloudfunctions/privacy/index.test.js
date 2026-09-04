'use strict'

const assert = require('assert')
const fs = require('fs')
const Module = require('module')
const path = require('path')
const { CONTROL_ID } = require('./membership-core')

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) }

class MemoryDatabase {
  constructor() { this.reset() }

  reset(seed = {}) {
    this.docs = new Map(Object.entries(seed).map(([name, records]) => [
      name, new Map(Object.entries(records).map(([id, value]) => [id, clone(value)])),
    ]))
    this.tail = Promise.resolve()
    this.clock = 1000
    this.beforeQueryGet = null
  }

  bucket(name, source = this.docs) {
    if (!source.has(name)) source.set(name, new Map())
    return source.get(name)
  }

  collection(name, source = null) {
    const database = this
    const resolve = () => source || database.docs
    return {
      doc(id) { return database.document(name, id, resolve) },
      where(criteria) {
        if (source) throw new Error('Bulk queries are unsupported in transactions')
        return database.query(name, criteria, resolve)
      },
    }
  }

  document(name, id, resolve) {
    const database = this
    return {
      async get() {
        const value = database.bucket(name, resolve()).get(id)
        if (value === undefined) throw new Error('DATABASE_DOCUMENT_NOT_FOUND')
        return { data: clone(value) }
      },
      async set({ data }) { database.bucket(name, resolve()).set(id, clone(data)) },
      async update({ data }) {
        const bucket = database.bucket(name, resolve())
        if (!bucket.has(id)) throw new Error('DATABASE_DOCUMENT_NOT_FOUND')
        bucket.set(id, { ...clone(bucket.get(id)), ...clone(data) })
      },
      async remove() { database.bucket(name, resolve()).delete(id) },
    }
  }

  query(name, criteria, resolve, offset = 0, maximum = Infinity) {
    const database = this
    return {
      skip(value) { return database.query(name, criteria, resolve, Number(value) || 0, maximum) },
      limit(value) { return database.query(name, criteria, resolve, offset, Number(value) || 0) },
      async get() {
        if (database.beforeQueryGet) await database.beforeQueryGet({ name, criteria })
        return { data: [...database.bucket(name, resolve()).entries()]
          .filter(([, record]) => Object.entries(criteria).every(([key, value]) => record[key] === value))
          .slice(offset, offset + maximum)
          .map(([id, record]) => ({ _id: id, ...clone(record) })) }
      },
    }
  }

  runTransaction(callback) {
    const run = this.tail.then(async () => {
      const draft = new Map([...this.docs.entries()].map(([name, records]) => [
        name, new Map([...records.entries()].map(([id, value]) => [id, clone(value)])),
      ]))
      const result = await callback({ collection: (name) => this.collection(name, draft) })
      this.docs = draft
      return result
    })
    this.tail = run.catch(() => {})
    return run
  }

  serverDate() { this.clock += 1; return this.clock }
  record(name, id) { return clone(this.bucket(name).get(id)) }
  snapshot() {
    return clone(Object.fromEntries([...this.docs.entries()].map(([name, records]) => [
      name, Object.fromEntries(records),
    ])))
  }
}

const database = new MemoryDatabase()
let deletedFiles = []
let uploadedPaths = []
let uploadFailureCount = 0
let beforeDeleteFile = null
let beforeUploadFile = null
let deleteOutcomes = []

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

const fakeCloud = {
  DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => database,
  getWXContext: () => ({ OPENID: 'member' }),
  deleteFile: async ({ fileList }) => {
    if (beforeDeleteFile) await beforeDeleteFile({ fileList })
    deletedFiles.push(...fileList)
    if (deleteOutcomes.length) {
      const outcome = deleteOutcomes.shift()
      if (outcome instanceof Error) throw outcome
      if (typeof outcome === 'function') return outcome(fileList)
      return clone(outcome)
    }
    return { fileList: fileList.map((fileID) => ({ fileID, status: 0 })) }
  },
  uploadFile: async ({ cloudPath }) => {
    if (beforeUploadFile) await beforeUploadFile({ cloudPath })
    uploadedPaths.push(cloudPath)
    if (uploadFailureCount > 0) {
      uploadFailureCount -= 1
      throw new Error('simulated orphan cleanup failure')
    }
    return { fileID: `cloud://test/${cloudPath}` }
  },
}
const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'wx-server-sdk') return fakeCloud
  return originalLoad.call(this, request, parent, isMain)
}
const modulePath = path.resolve(__dirname, 'index.js')
delete require.cache[modulePath]
const privacy = require(modulePath)
Module._load = originalLoad

const { notFound } = require('./not-found')
const { ownerHash } = require('./upload-ticket')
const CACHE_NAMESPACE = '9'.repeat(32)

function resetEffects() {
  deletedFiles = []
  uploadedPaths = []
  uploadFailureCount = 0
  beforeDeleteFile = null
  beforeUploadFile = null
  deleteOutcomes = []
}

function assertStrictNotFoundClassification() {
  assert.strictEqual(notFound({
    errCode: -1,
    message: 'document.get:fail document with _id absent-record does not exist',
    errMsg: 'document.get:fail document with _id absent-record does not exist',
  }), true)
  assert.strictEqual(notFound({
    code: 'PERMISSION_DENIED',
    errMsg: 'document.get:fail document with _id misleading-record does not exist',
  }), false)
  assert.strictEqual(notFound({
    code: 'DATABASE_DOCUMENT_NOT_FOUND',
    message: 'private permission detail',
  }), false)
  assert.strictEqual(notFound({
    errCode: -1,
    message: 'document.get:fail document with _id hidden-record does not exist',
    errMsg: 'private network detail',
  }), false)
}

function assertFixedPublicErrors() {
  const privateDetail = 'attacker-controlled private privacy detail'
  const known = privacy._test.publicError(Object.assign(new Error(privateDetail), { code: 'DELETE_INCOMPLETE' }))
  assert.deepStrictEqual(known, { code: 'DELETE_INCOMPLETE', message: '仍有私人数据未删除，请重试' })
  assert.strictEqual(JSON.stringify(known).includes(privateDetail), false)
  const uploading = privacy._test.publicError(Object.assign(new Error(privateDetail), {
    code: 'PRIVATE_UPLOAD_IN_PROGRESS', retryable: true,
  }))
  assert.deepStrictEqual(uploading, {
    code: 'PRIVATE_UPLOAD_IN_PROGRESS',
    message: '私人图片仍在处理中，请稍后重试',
    retryable: true,
  })
  assert.strictEqual(JSON.stringify(uploading).includes(privateDetail), false)
  const stale = privacy._test.publicError(Object.assign(new Error(privateDetail), {
    code: 'STALE_DATA_GENERATION',
  }))
  assert.deepStrictEqual(stale, {
    code: 'STALE_DATA_GENERATION',
    message: '账号数据版本已变化，请刷新后重试',
  })
  assert.strictEqual(JSON.stringify(stale).includes(privateDetail), false)
  const unknown = privacy._test.publicError(Object.assign(new Error(privateDetail), { code: 'PRIVATE_BACKEND_FAILURE' }))
  assert.deepStrictEqual(unknown, { code: 'PRIVACY_DELETE_FAILED', message: '数据删除未完成，请重试' })
  assert.strictEqual(JSON.stringify(unknown).includes(privateDetail), false)
}

const activeControl = (overrides = {}) => ({
  kind: 'control', status: 'control', schemaVersion: 2,
  phase: 'active', bootstrapRequestId: '', ownerOpenid: 'owner',
  activeMemberCount: 2, reservedInviteCount: 0, revision: 10,
  ...overrides,
})
const member = (role = 'member', status = 'active', cacheNamespace = CACHE_NAMESPACE) => ({
  status, role, cacheNamespace, joinedAt: 1, updatedAt: 1,
})

async function memberDeletionUsesControl() {
  resetEffects()
  database.reset({ meal_members: {
    [CONTROL_ID]: activeControl(), owner: member('owner'), member: member(),
  } })
  await privacy._test.prepareMembershipDeletion('member', CACHE_NAMESPACE)
  assert.strictEqual(database.record('meal_members', 'member').status, 'deleting')
  assert.strictEqual(database.record('meal_members', CONTROL_ID).activeMemberCount, 1)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).revision, 11)
  const finalized = await privacy._test.finalizeMembershipDeletion('member', CACHE_NAMESPACE)
  assert.deepStrictEqual(finalized, { membershipDeleted: true, ownerAccessRetained: false })
  assert.strictEqual(database.record('meal_members', 'member'), undefined)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).revision, 12)
  await assert.rejects(
    privacy._test.finalizeMembershipDeletion('member', CACHE_NAMESPACE),
    (error) => error.code === 'STALE_DATA_GENERATION',
  )
  assert.strictEqual(database.record('meal_members', CONTROL_ID).revision, 12,
    '重复收尾已删除成员不得再次推进 control')
}

async function inactiveMemberMarkUsesControl() {
  database.reset({ meal_members: {
    [CONTROL_ID]: activeControl({ activeMemberCount: 1 }), owner: member('owner'), disabled: member('member', 'disabled'),
  } })
  await privacy._test.prepareMembershipDeletion('disabled', CACHE_NAMESPACE)
  assert.strictEqual(database.record('meal_members', 'disabled').status, 'deleting')
  assert.strictEqual(database.record('meal_members', CONTROL_ID).activeMemberCount, 1)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).revision, 11)
}

async function initialNamespaceMismatchIsFailClosed() {
  for (const expectedCacheNamespace of [
    undefined, '9'.repeat(31), '9'.repeat(33), 'A'.repeat(32), '8'.repeat(32),
  ]) {
    resetEffects()
    database.reset({
      meal_members: {
        [CONTROL_ID]: activeControl(), owner: member('owner'), member: member(),
      },
      meal_invites: { invite: { active: true, createdBy: 'member', usedCount: 0, maxUses: 1 } },
      meal_users: { member: { nickname: 'private', avatarFileId: 'cloud://env/private-avatar' } },
    })
    const before = database.snapshot()
    const result = await privacy.main({ action: 'clearMyData', expectedCacheNamespace })
    assert.deepStrictEqual(result, {
      success: false,
      code: 'STALE_DATA_GENERATION',
      message: '账号数据版本已变化，请刷新后重试',
    })
    assert.deepStrictEqual(database.snapshot(), before, '首次旧代际请求不得产生数据库副作用')
    assert.deepStrictEqual(deletedFiles, [])
    assert.deepStrictEqual(uploadedPaths, [])
  }
}

async function everyDeletionStageRejectsRotatedNamespace() {
  const rotatedNamespace = '8'.repeat(32)
  const data = {
    user: { nickname: 'private', avatarFileId: 'cloud://env/private-avatar' },
    health: [{ _id: 'health', owner: 'member', date: '2026-08-28' }],
    avatarTickets: [], photoTickets: [],
    invites: [{ _id: 'invite', active: false, usedBy: 'member' }],
    aiTasks: [], aiShards: [], aiControls: [],
  }
  const stages = [
    ['preflight', 'active', () => privacy._test.preflightMembershipDeletion('member', rotatedNamespace)],
    ['list invites', 'active', () => privacy._test.listActiveOwnedInvites('member', rotatedNamespace)],
    ['deactivate invite', 'active', () => privacy._test.deactivateOwnedInvite('invite', 'member', rotatedNamespace)],
    ['prepare active member', 'active', () => privacy._test.prepareMembershipDeletion('member', rotatedNamespace)],
    ['prepare inactive member', 'disabled', () => privacy._test.prepareMembershipDeletion('member', rotatedNamespace)],
    ['collect private data', 'deleting', () => privacy._test.collectPrivateData('member', rotatedNamespace)],
    ['delete private data', 'deleting', () => privacy._test.deletePrivateData('member', data, rotatedNamespace)],
    ['remove private documents', 'deleting', () => privacy._test.removePrivateDocuments('member', data, rotatedNamespace)],
    ['remove related invite', 'deleting', () => privacy._test.removeRelatedInvite('invite', 'member', rotatedNamespace)],
    ['verify cleared', 'deleting', () => privacy._test.verifyCleared('member', rotatedNamespace)],
    ['finalize membership', 'deleting', () => privacy._test.finalizeMembershipDeletion('member', rotatedNamespace)],
  ]
  for (const [name, status, runStage] of stages) {
    resetEffects()
    database.reset({
      meal_members: {
        [CONTROL_ID]: activeControl({ activeMemberCount: status === 'active' ? 2 : 1 }),
        owner: member('owner'), member: member('member', status),
      },
      meal_invites: { invite: { active: true, createdBy: 'member', usedBy: 'member', usedCount: 0, maxUses: 1 } },
      meal_users: { member: clone(data.user) },
      health_daily: { health: clone(data.health[0]) },
    })
    const before = database.snapshot()
    await assert.rejects(runStage(), (error) => error.code === 'STALE_DATA_GENERATION', name)
    assert.deepStrictEqual(database.snapshot(), before, `${name} 必须在旧代际下 fail closed`)
    assert.deepStrictEqual(deletedFiles, [], `${name} 不得删除云文件`)
    assert.deepStrictEqual(uploadedPaths, [], `${name} 不得覆盖云对象`)
  }
}

async function namespaceRotationBetweenQueryAndTransactionIsFailClosed() {
  resetEffects()
  const rotatedNamespace = '8'.repeat(32)
  database.reset({ meal_members: {
    [CONTROL_ID]: activeControl(), owner: member('owner'), member: member(),
  } })
  let rotated = false
  database.beforeQueryGet = async ({ name, criteria }) => {
    if (rotated || name !== 'meal_members' || criteria.status !== 'active') return
    rotated = true
    database.bucket('meal_members').set('member', member('member', 'active', rotatedNamespace))
  }
  await assert.rejects(
    privacy._test.prepareMembershipDeletion('member', CACHE_NAMESPACE),
    (error) => error.code === 'STALE_DATA_GENERATION',
  )
  assert.strictEqual(rotated, true)
  assert.deepStrictEqual(database.record('meal_members', 'member'), member('member', 'active', rotatedNamespace))
  assert.deepStrictEqual(database.record('meal_members', CONTROL_ID), activeControl())
  assert.deepStrictEqual(deletedFiles, [])
  assert.deepStrictEqual(uploadedPaths, [])
}

async function namespaceRotationDuringDeleteFileWaitStopsLaterSideEffects() {
  resetEffects()
  const rotatedNamespace = '8'.repeat(32)
  const privateAvatar = 'cloud://env/private-avatar'
  const enteredDeleteFile = deferred()
  const resumeDeleteFile = deferred()
  database.reset({
    meal_members: {
      [CONTROL_ID]: activeControl({ activeMemberCount: 1 }),
      member: member('member', 'deleting'),
    },
    meal_users: { member: { nickname: 'private', avatarFileId: privateAvatar } },
    meal_invites: {
      invite: { active: false, createdBy: 'member', usedBy: 'member', usedCount: 1, maxUses: 1 },
    },
  })
  const data = {
    user: database.record('meal_users', 'member'),
    health: [], avatarTickets: [], photoTickets: [],
    invites: [{ _id: 'invite', ...database.record('meal_invites', 'invite') }],
    aiTasks: [], aiShards: [], aiControls: [],
  }
  beforeDeleteFile = async () => {
    enteredDeleteFile.resolve()
    await resumeDeleteFile.promise
  }

  const deletion = privacy._test.deletePrivateData('member', data, CACHE_NAMESPACE)
  await enteredDeleteFile.promise
  const rotatedMember = member('member', 'active', rotatedNamespace)
  const rotatedControl = activeControl({ activeMemberCount: 1, revision: 11 })
  database.bucket('meal_members').set('member', rotatedMember)
  database.bucket('meal_members').set(CONTROL_ID, rotatedControl)
  resumeDeleteFile.resolve()

  await assert.rejects(deletion, (error) => error.code === 'STALE_DATA_GENERATION')
  assert.deepStrictEqual(deletedFiles, [privateAvatar],
    '外部删除已开始后无法撤销，但返回后必须立即重校验身份代际')
  assert.deepStrictEqual(uploadedPaths, [], '旧代际不得继续执行云对象补偿上传')
  assert.deepStrictEqual(database.record('meal_users', 'member'), data.user,
    '外部等待后发现旧代际时不得继续删除用户档案')
  assert.deepStrictEqual(database.record('meal_invites', 'invite'), {
    active: false, createdBy: 'member', usedBy: 'member', usedCount: 1, maxUses: 1,
  },
    '外部等待后发现旧代际时不得继续删除关联邀请码')
  assert.deepStrictEqual(database.record('meal_members', 'member'), rotatedMember,
    '不得覆盖并发写入的新身份代际')
  assert.deepStrictEqual(database.record('meal_members', CONTROL_ID), rotatedControl,
    '不得覆盖并发推进后的成员 control')
}

async function namespaceRotationDuringUploadFileWaitStopsLaterSideEffects() {
  resetEffects()
  const originalNow = Date.now
  Date.now = () => 500_000
  try {
    const rotatedNamespace = '8'.repeat(32)
    const token = 'a'.repeat(48)
    const inboxPath = `avatar-inbox/${token}.jpeg`
    const enteredUploadFile = deferred()
    const resumeUploadFile = deferred()
    const ticket = { owner: 'member', extension: 'jpeg', expiresAt: 100_000 }
    database.reset({
      meal_members: {
        [CONTROL_ID]: activeControl({ activeMemberCount: 1 }),
        member: member('member', 'deleting'),
      },
      meal_users: { member: { nickname: 'private', avatarFileId: '' } },
      meal_avatar_uploads: { [token]: ticket },
    })
    const data = {
      user: database.record('meal_users', 'member'),
      health: [],
      avatarTickets: [{ _id: token, ...ticket }],
      photoTickets: [], invites: [], aiTasks: [], aiShards: [], aiControls: [],
    }
    beforeUploadFile = async () => {
      enteredUploadFile.resolve()
      await resumeUploadFile.promise
    }

    const deletion = privacy._test.deletePrivateData('member', data, CACHE_NAMESPACE)
    await enteredUploadFile.promise
    const rotatedMember = member('member', 'active', rotatedNamespace)
    const rotatedControl = activeControl({ activeMemberCount: 1, revision: 11 })
    database.bucket('meal_members').set('member', rotatedMember)
    database.bucket('meal_members').set(CONTROL_ID, rotatedControl)
    resumeUploadFile.resolve()

    await assert.rejects(deletion, (error) => error.code === 'STALE_DATA_GENERATION')
    assert.deepStrictEqual(uploadedPaths, [inboxPath],
      '外部补偿上传已开始后无法撤销，但返回后必须立即重校验身份代际')
    assert.deepStrictEqual(deletedFiles, [`cloud://test/${inboxPath}`],
      '补偿上传成功后即使代际变化，也必须删除本次创建的占位对象')
    assert.deepStrictEqual(database.record('meal_users', 'member'), data.user,
      '补偿上传等待后发现旧代际时不得继续删除用户档案')
    assert.deepStrictEqual(database.record('meal_avatar_uploads', token), ticket,
      '补偿上传等待后发现旧代际时必须保留上传票据供新代际判断')
    assert.deepStrictEqual(database.record('meal_members', 'member'), rotatedMember)
    assert.deepStrictEqual(database.record('meal_members', CONTROL_ID), rotatedControl)
  } finally {
    Date.now = originalNow
  }
}

async function placeholderCleanupFailureKeepsDeletionRetryable() {
  resetEffects()
  const token = 'b'.repeat(48)
  const inboxPath = `avatar-inbox/${token}.jpeg`
  const ticket = { owner: 'member', extension: 'jpeg', expiresAt: 100_000 }
  database.reset({
    meal_members: {
      [CONTROL_ID]: activeControl({ activeMemberCount: 1 }),
      member: member('member', 'deleting'),
    },
    meal_users: { member: { nickname: 'private', avatarFileId: '' } },
    meal_avatar_uploads: { [token]: ticket },
  })
  const data = {
    user: database.record('meal_users', 'member'),
    health: [], avatarTickets: [{ _id: token, ...ticket }], photoTickets: [],
    invites: [], aiTasks: [], aiShards: [], aiControls: [],
  }
  deleteOutcomes.push({
    fileList: [{
      fileID: `cloud://test/${inboxPath}`, status: -1,
      code: 'PERMISSION_DENIED', errMsg: 'storage file not exist',
    }],
  })

  await assert.rejects(
    privacy._test.deletePrivateData('member', data, CACHE_NAMESPACE),
    (error) => error.code === 'FILE_DELETE_FAILED',
    '占位文件权限或未知删除失败不得误报账号已清空',
  )
  assert.deepStrictEqual(uploadedPaths, [inboxPath])
  assert.deepStrictEqual(deletedFiles, [`cloud://test/${inboxPath}`])
  assert.deepStrictEqual(database.record('meal_users', 'member'), data.user,
    '补偿删除失败时必须保留用户文档供后续重试')
  assert.deepStrictEqual(database.record('meal_avatar_uploads', token), ticket,
    '补偿删除失败时必须保留上传票据供后续重试')

  for (const outcome of [
    new Error('simulated placeholder delete network failure'),
    { code: 'STORAGE_REQUEST_FAIL', message: 'storage request fail' },
  ]) {
    resetEffects()
    deleteOutcomes.push(outcome)
    await assert.rejects(
      privacy._test.reclaimOrphanPaths([inboxPath], () => Promise.resolve()),
      (error) => error.code === 'FILE_DELETE_FAILED',
      '占位文件网络或未知响应失败必须保持可重试，不能误报完成',
    )
    assert.deepStrictEqual(uploadedPaths, [inboxPath])
    assert.deepStrictEqual(deletedFiles, [`cloud://test/${inboxPath}`])
  }

  resetEffects()
  deleteOutcomes.push({
    fileList: [{
      fileID: `cloud://test/${inboxPath}`, status: -503003,
      code: 'STORAGE_FILE_NONEXIST', errMsg: 'storage file not exist',
    }],
  })
  await privacy._test.reclaimOrphanPaths([inboxPath], () => Promise.resolve())
  assert.deepStrictEqual(uploadedPaths, [inboxPath], '缺失响应必须作为幂等删除完成')
  assert.deepStrictEqual(deletedFiles, [`cloud://test/${inboxPath}`])
}

async function inviteWritesUseControl() {
  database.reset({
    meal_members: { [CONTROL_ID]: activeControl({ activeMemberCount: 1, reservedInviteCount: 1 }), owner: member('owner') },
    meal_invites: { invite: { active: true, createdBy: 'owner', usedCount: 0, maxUses: 1 } },
  })
  assert.strictEqual(await privacy._test.deactivateOwnedInvite('invite', 'owner', CACHE_NAMESPACE), true)
  assert.strictEqual(database.record('meal_invites', 'invite').active, false)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).reservedInviteCount, 0)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).revision, 11)
  database.bucket('meal_members').set('owner', member('owner', 'deleting'))
  assert.strictEqual(await privacy._test.removeRelatedInvite('invite', 'owner', CACHE_NAMESPACE), true)
  assert.strictEqual(database.record('meal_invites', 'invite'), undefined)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).revision, 12)
}

async function bootstrapSentinelBlocksEveryPrivacyMembershipWrite() {
  for (const phase of ['bootstrap_pending', 'bootstrap_approved']) {
    const sentinel = activeControl({
      phase, bootstrapRequestId: 'a'.repeat(32),
      ownerOpenid: '', activeMemberCount: 0, reservedInviteCount: 0,
    })
    database.reset({
      meal_members: { [CONTROL_ID]: sentinel, owner: member('owner'), deleting: member('member', 'deleting') },
      meal_invites: { invite: { active: true, createdBy: 'owner', usedCount: 0, maxUses: 1 } },
    })
    await assert.rejects(
      privacy._test.prepareMembershipDeletion('owner', CACHE_NAMESPACE),
      (error) => error.code === 'MEMBERSHIP_BOOTSTRAP_IN_PROGRESS',
    )
    await assert.rejects(
      privacy._test.deactivateOwnedInvite('invite', 'owner', CACHE_NAMESPACE),
      (error) => error.code === 'MEMBERSHIP_BOOTSTRAP_IN_PROGRESS',
    )
    await assert.rejects(
      privacy._test.removeRelatedInvite('invite', 'owner', CACHE_NAMESPACE),
      (error) => error.code === 'MEMBERSHIP_BOOTSTRAP_IN_PROGRESS',
    )
    await assert.rejects(
      privacy._test.finalizeMembershipDeletion('deleting', CACHE_NAMESPACE),
      (error) => error.code === 'MEMBERSHIP_BOOTSTRAP_IN_PROGRESS',
    )
    assert.deepStrictEqual(database.record('meal_members', CONTROL_ID), sentinel)
    assert.strictEqual(database.record('meal_invites', 'invite').active, true)
  }
}

async function deletingProfileRemovesPhoneBinding() {
  resetEffects()
  database.reset({
    meal_members: {
      [CONTROL_ID]: activeControl({ activeMemberCount: 1 }),
      owner: member('owner'),
      member: member('member', 'deleting'),
    },
    meal_users: {
      member: { schemaVersion: 2, nickname: '', phoneBound: true, maskedPhone: '****8000', phoneBoundAt: 999 },
    },
  })
  await privacy._test.deletePrivateData('member', {
    user: database.record('meal_users', 'member'),
    health: [], avatarTickets: [], photoTickets: [], invites: [],
    aiTasks: [], aiShards: [], aiControls: [],
  }, CACHE_NAMESPACE)
  assert.strictEqual(database.record('meal_users', 'member'), undefined,
    '删除用户档案必须同步删除手机号绑定状态与掩码')
  await privacy._test.finalizeMembershipDeletion('member', CACHE_NAMESPACE)
  assert.strictEqual(database.record('meal_members', 'member'), undefined)
}

async function healthCleanupTicketSurvivesFailureAndClearReclaimsIt() {
  resetEffects()
  const cleanupFileId = 'cloud://env/health-photo-awaiting-cleanup'
  const token = '7'.repeat(48)
  database.reset({
    meal_members: {
      [CONTROL_ID]: activeControl(), owner: member('owner'), member: member(),
    },
    health_photo_uploads: {
      [token]: {
        owner: 'member', cacheNamespace: CACHE_NAMESPACE,
        state: 'cleaning', targetDate: '2026-08-28', cleanupFileId,
        cleanupReady: true, cleanupClaimedAtMs: 1,
      },
    },
  })
  deleteOutcomes.push(new Error('simulated storage request failure'))
  await assert.rejects(
    privacy._test.clearMyData('member', CACHE_NAMESPACE),
    /simulated storage request failure/,
  )
  assert(database.record('health_photo_uploads', token),
    '账号清空遇到云文件删除失败时必须保留健康照片清理票据供重试')
  assert.strictEqual(database.record('meal_members', 'member').status, 'deleting')

  deleteOutcomes.push({
    fileList: [{
      fileID: cleanupFileId, status: -1,
      code: 'STORAGE_FILE_NONEXIST', errMsg: 'storage file not exist',
    }],
  })
  const cleared = await privacy._test.clearMyData('member', CACHE_NAMESPACE)
  assert.strictEqual(cleared.cleared, true,
    '文件已被首次请求删除但响应丢失时，重试必须幂等完成账号清空')
  assert.strictEqual(database.record('health_photo_uploads', token), undefined)
  assert.strictEqual(database.record('meal_members', 'member'), undefined)
  assert.deepStrictEqual(deletedFiles, [cleanupFileId, cleanupFileId])

  resetEffects()
  database.reset({ meal_members: {
    [CONTROL_ID]: activeControl({ activeMemberCount: 1 }),
    member: member('member', 'deleting'),
  } })
  const privateFile = 'cloud://env/private-file'
  deleteOutcomes.push({
    fileList: [{
      fileID: privateFile, status: -1,
      code: 'PERMISSION_DENIED', errMsg: 'storage file not exist',
    }],
  })
  await assert.rejects(
    privacy._test.deleteFiles([privateFile], () => Promise.resolve()),
    (error) => error.code === 'FILE_DELETE_FAILED',
    '权限错误即使夹带缺失文案也必须阻断删除',
  )
  deleteOutcomes.push({ code: 'STORAGE_REQUEST_FAIL', message: 'storage request fail' })
  await assert.rejects(
    privacy._test.deleteFiles([privateFile], () => Promise.resolve()),
    (error) => error.code === 'FILE_DELETE_FAILED',
    '顶层存储失败响应必须阻断删除',
  )
}

async function batchDeleteAmbiguityFallsBackSafely() {
  const files = ['cloud://env/private-a', 'cloud://env/private-b']

  resetEffects()
  deleteOutcomes.push(Object.assign(new Error('storage file not exists'), {
    code: 'STORAGE_FILE_NONEXIST',
  }))
  await privacy._test.deleteFiles(files, () => Promise.resolve())
  assert.deepStrictEqual(deletedFiles, [...files, ...files],
    '批量删除抛出顶层 missing 时必须逐文件确认')

  resetEffects()
  deleteOutcomes.push({
    code: 'STORAGE_FILE_NONEXIST', message: 'storage file not exist',
  })
  await privacy._test.deleteFiles(files, () => Promise.resolve())
  assert.deepStrictEqual(deletedFiles, [...files, ...files],
    '批量删除返回顶层 missing 时必须逐文件确认')

  resetEffects()
  deleteOutcomes.push({ fileList: [{ fileID: files[0], status: 0 }] })
  await privacy._test.deleteFiles(files, () => Promise.resolve())
  assert.deepStrictEqual(deletedFiles, [...files, ...files],
    '批量删除返回缺项歧义响应时必须逐文件确认全部文件')

  resetEffects()
  deleteOutcomes.push(
    { fileList: [{ fileID: files[0], status: 0 }] },
    { fileList: [{
      fileID: files[0], status: -1, code: 'PERMISSION_DENIED', errMsg: 'permission denied',
    }] },
  )
  await assert.rejects(
    privacy._test.deleteFiles(files, () => Promise.resolve()),
    (error) => error.code === 'FILE_DELETE_FAILED',
    '逐文件确认遇到真实失败必须 fail closed',
  )
  assert.deepStrictEqual(deletedFiles, [...files, files[0]],
    '逐文件真实失败后不得继续删除后续文件')

  resetEffects()
  let currentGeneration = true
  let deleteCalls = 0
  beforeDeleteFile = async () => {
    deleteCalls += 1
    if (deleteCalls === 2) currentGeneration = false
  }
  deleteOutcomes.push({ fileList: [{ fileID: files[0], status: 0 }] })
  const assertCurrentGeneration = async () => {
    if (!currentGeneration) {
      const error = new Error('generation rotated')
      error.code = 'STALE_DATA_GENERATION'
      throw error
    }
  }
  await assert.rejects(
    privacy._test.deleteFiles(files, assertCurrentGeneration),
    (error) => error.code === 'STALE_DATA_GENERATION',
    '逐文件删除等待期间身份世代变化必须立即停止',
  )
  assert.deepStrictEqual(deletedFiles, [...files, files[0]],
    '身份世代变化后不得继续触及后续文件')
}

async function memberUploadLeaseBlocksAndRetries() {
  resetEffects()
  const originalNow = Date.now
  let now = 50_000
  Date.now = () => now
  try {
    const token = 'a'.repeat(48)
    const permanentPath = `health-photos/${ownerHash('member')}/2026-08-28-${token}.png`
    const ticket = {
      owner: 'member', state: 'uploading', targetDate: '2026-08-28', permanentPath,
      permanentFileId: '', uploadStartedAtMs: now,
      uploadLeaseExpiresAtMs: now + 120 * 1000,
      expiresAt: now + 15 * 60 * 1000, cleanupReady: false,
    }
    database.reset({
      meal_members: {
        [CONTROL_ID]: activeControl(), owner: member('owner'), member: member(),
      },
      health_photo_uploads: { [token]: ticket },
    })

    const blocked = await privacy.main({
      action: 'clearMyData', expectedCacheNamespace: CACHE_NAMESPACE,
    })
    assert.deepStrictEqual(blocked, {
      success: false, code: 'PRIVATE_UPLOAD_IN_PROGRESS',
      message: '私人图片仍在处理中，请稍后重试', retryable: true,
    })
    const deleting = database.record('meal_members', 'member')
    assert.strictEqual(deleting.status, 'deleting')
    assert.strictEqual(deleting.preserveOwnerAfterClear, false)
    assert.deepStrictEqual(database.record('health_photo_uploads', token), ticket,
      '租约未到期时必须保留上传票据供重试')
    assert.strictEqual(database.record('meal_members', CONTROL_ID).revision, 11)
    assert.deepStrictEqual(uploadedPaths, [])
    assert.deepStrictEqual(deletedFiles, [])

    now = ticket.uploadLeaseExpiresAtMs + 1
    const cleared = await privacy.main({
      action: 'clearMyData', expectedCacheNamespace: CACHE_NAMESPACE,
    })
    assert.strictEqual(cleared.success, true)
    assert.deepStrictEqual(cleared.data, {
      cleared: true, healthRecordCount: 0, inviteRecordCount: 0,
      aiTaskRecordCount: 0, aiShardRecordCount: 0, aiControlRecordCount: 0,
      membershipDeleted: true, ownerAccessRetained: false,
    })
    assert.deepStrictEqual(uploadedPaths, [permanentPath])
    assert(deletedFiles.includes(`cloud://test/${permanentPath}`))
    assert.strictEqual(database.record('health_photo_uploads', token), undefined)
    assert.strictEqual(database.record('meal_members', 'member'), undefined)
    assert.strictEqual(database.record('meal_members', CONTROL_ID).revision, 12)

    const effects = { uploadedPaths: [...uploadedPaths], deletedFiles: [...deletedFiles] }
    const repeated = await privacy.main({
      action: 'clearMyData', expectedCacheNamespace: CACHE_NAMESPACE,
    })
    assert.strictEqual(repeated.code, 'STALE_DATA_GENERATION')
    assert.deepStrictEqual(uploadedPaths, effects.uploadedPaths,
      '普通成员删除完成后的重试不得再次回收对象')
    assert.deepStrictEqual(deletedFiles, effects.deletedFiles)
    assert.strictEqual(database.record('meal_members', CONTROL_ID).revision, 12)
  } finally {
    Date.now = originalNow
  }
}

async function soleOwnerUploadLeaseRotatesOnceAcrossConcurrentRetries() {
  resetEffects()
  const originalNow = Date.now
  let now = 100_000
  Date.now = () => now
  try {
    const token = 'b'.repeat(48)
    const permanentPath = `avatars/${ownerHash('owner')}/${token}.webp`
    const oldCacheNamespace = 'c'.repeat(32)
    const ticket = {
      owner: 'owner', state: 'uploading', permanentPath, permanentFileId: '',
      uploadStartedAtMs: now, uploadLeaseExpiresAtMs: now + 120 * 1000,
      expiresAt: now + 15 * 60 * 1000, cleanupReady: false,
    }
    database.reset({
      meal_members: {
        [CONTROL_ID]: activeControl({ activeMemberCount: 1 }),
        owner: {
          ...member('owner'), memberRef: 'd'.repeat(32), cacheNamespace: oldCacheNamespace,
        },
      },
      meal_avatar_uploads: { [token]: ticket },
    })

    await assert.rejects(
      privacy._test.clearMyData('owner', oldCacheNamespace),
      (error) => error.code === 'PRIVATE_UPLOAD_IN_PROGRESS' && error.retryable === true,
    )
    const deleting = database.record('meal_members', 'owner')
    assert.strictEqual(deleting.status, 'deleting')
    assert.strictEqual(deleting.role, 'owner')
    assert.strictEqual(deleting.preserveOwnerAfterClear, true)
    assert.strictEqual(deleting.cacheNamespace, oldCacheNamespace,
      '活跃租约阻断期间不得提前轮换 owner namespace')
    assert.deepStrictEqual(database.record('meal_avatar_uploads', token), ticket)
    assert.strictEqual(database.record('meal_members', CONTROL_ID).revision, 11)

    now = ticket.uploadLeaseExpiresAtMs + 1
    const results = await Promise.allSettled([
      privacy._test.clearMyData('owner', oldCacheNamespace),
      privacy._test.clearMyData('owner', oldCacheNamespace),
    ])
    assert.strictEqual(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.strictEqual(results.filter((result) => (
      result.status === 'rejected' && result.reason.code === 'STALE_DATA_GENERATION'
    )).length, 1, '同一旧 namespace 的并发重试只能有一个完成，另一个必须视为旧代际')
    const completed = results.find((result) => result.status === 'fulfilled').value
    assert.strictEqual(completed.cleared, true)
    assert.strictEqual(completed.membershipDeleted, false)
    assert.strictEqual(completed.ownerAccessRetained, true)
    assert.strictEqual(database.record('meal_avatar_uploads', token), undefined)
    const retained = database.record('meal_members', 'owner')
    assert.strictEqual(retained.status, 'active')
    assert.strictEqual(retained.role, 'owner')
    assert.notStrictEqual(retained.cacheNamespace, oldCacheNamespace)
    const rotatedNamespace = retained.cacheNamespace
    assert.strictEqual(database.record('meal_members', CONTROL_ID).revision, 12,
      '并发重试必须只完成一次 owner 恢复与 namespace 轮换')
    await assert.rejects(
      privacy._test.clearMyData('owner', oldCacheNamespace),
      (error) => error.code === 'STALE_DATA_GENERATION',
      '完成后的旧代际请求顺序重放不得再次轮换 namespace',
    )
    assert.strictEqual(database.record('meal_members', 'owner').cacheNamespace, rotatedNamespace)
    assert.strictEqual(database.record('meal_members', CONTROL_ID).revision, 12)
    assert(uploadedPaths.every((path) => path === permanentPath),
      '并发回收也只能触及票据校验后的 owner/token 路径')

    database.bucket('meal_users').set('owner', {
      schemaVersion: 2, nickname: 'new generation profile', avatarFileId: '',
    })
    const newGeneration = await privacy._test.clearMyData('owner', rotatedNamespace)
    assert.strictEqual(newGeneration.cleared, true)
    assert.strictEqual(newGeneration.ownerAccessRetained, true)
    assert.notStrictEqual(database.record('meal_members', 'owner').cacheNamespace, rotatedNamespace,
      '刷新身份并重新确认后，新 namespace 应能授权一次真正的新清理')
    assert.strictEqual(database.record('meal_members', CONTROL_ID).revision, 14,
      '新代际清理应各推进一次 prepare 与 finalize')
  } finally {
    Date.now = originalNow
  }
}

async function legacyInboxCleanupIsRetryableAndFailClosed() {
  resetEffects()
  const originalNow = Date.now
  Date.now = () => 500_000
  try {
    const token = 'e'.repeat(48)
    const inboxPath = `avatar-inbox/${token}.jpeg`
    database.reset({
      meal_members: {
        [CONTROL_ID]: activeControl(), owner: member('owner'), member: member(),
      },
      meal_avatar_uploads: {
        [token]: { owner: 'member', extension: 'jpeg', expiresAt: 100_000 },
      },
    })
    uploadFailureCount = 1
    await assert.rejects(
      privacy._test.clearMyData('member', CACHE_NAMESPACE), /simulated orphan cleanup failure/,
    )
    assert(database.record('meal_avatar_uploads', token),
      '旧 inbox 对象回收失败时必须保留票据，不能让 verify 误报完成')
    assert.strictEqual(database.record('meal_members', 'member').status, 'deleting')

    const cleared = await privacy._test.clearMyData('member', CACHE_NAMESPACE)
    assert.strictEqual(cleared.cleared, true)
    assert.deepStrictEqual(uploadedPaths, [inboxPath, inboxPath])
    assert(deletedFiles.includes(`cloud://test/${inboxPath}`))
    assert.strictEqual(database.record('meal_avatar_uploads', token), undefined)
    assert.strictEqual(database.record('meal_members', 'member'), undefined)

    resetEffects()
    const unsafeToken = 'f'.repeat(48)
    database.reset({
      meal_members: {
        [CONTROL_ID]: activeControl(), owner: member('owner'), member: member(),
      },
      meal_avatar_uploads: {
        [unsafeToken]: {
          owner: 'member', state: 'cleanup', permanentPath: 'avatars/another-user/private.jpg',
          permanentFileId: '', expiresAt: 1,
        },
      },
    })
    await assert.rejects(
      privacy._test.clearMyData('member', CACHE_NAMESPACE),
      (error) => error.code === 'PRIVATE_UPLOAD_STATE_INVALID',
    )
    assert.strictEqual(database.record('meal_members', 'member').status, 'deleting')
    assert(database.record('meal_avatar_uploads', unsafeToken),
      '不可信路径票据必须保留供人工审计或安全修复')
    assert.deepStrictEqual(uploadedPaths, [], '不可信永久路径绝不能被覆盖回收')
    assert.deepStrictEqual(deletedFiles, [])
  } finally {
    Date.now = originalNow
  }
}

async function soleOwnerClearRetainsMinimalAdministrator() {
  resetEffects()
  const oldAvatar = 'cloud://env/private-avatar'
  const oldPhoto = 'cloud://env/private-health-photo'
  database.reset({
    meal_members: {
      [CONTROL_ID]: activeControl({ activeMemberCount: 1 }),
      owner: {
        ...member('owner'), memberRef: 'a'.repeat(32), cacheNamespace: 'b'.repeat(32),
        displayLabel: 'private label', inviteId: 'private invite',
      },
    },
    meal_users: { owner: {
      schemaVersion: 2, nickname: 'private nickname', avatarFileId: oldAvatar,
      phoneBound: true, maskedPhone: '****8000', phoneBoundAt: 999,
    } },
    meal_user_states: { owner: { schemaVersion: 6, activePlan: { title: 'private meal' } } },
    health_daily: { health: {
      owner: 'owner', date: '2026-08-28', photoFileId: oldPhoto,
      weight: 60, exercise: { completed: true }, note: 'private note',
    } },
    meal_ai_tasks: { task: { owner: 'owner', status: 'failed', input: { healthNotes: 'private' } } },
    meal_ai_shards: { shard: { owner: 'owner', taskId: 'task', body: 'private' } },
    meal_ai_controls: { owner: { owner: 'owner', activeTaskId: 'task' } },
  })

  const result = await privacy._test.clearMyData('owner', 'b'.repeat(32))
  assert.strictEqual(result.cleared, true)
  assert.strictEqual(result.membershipDeleted, false)
  assert.strictEqual(result.ownerAccessRetained, true)
  for (const collection of [
    'meal_users', 'meal_user_states', 'health_daily',
    'meal_ai_tasks', 'meal_ai_shards', 'meal_ai_controls',
  ]) assert.strictEqual(database.bucket(collection).size, 0, `${collection} must be empty after owner clear`)
  assert.deepStrictEqual(new Set(deletedFiles), new Set([oldAvatar, oldPhoto]))

  const retained = database.record('meal_members', 'owner')
  assert.deepStrictEqual(Object.keys(retained).sort(), [
    'cacheNamespace', 'joinedAt', 'memberRef', 'resetAt', 'role', 'status', 'updatedAt',
  ])
  assert.strictEqual(retained.status, 'active')
  assert.strictEqual(retained.role, 'owner')
  assert(/^[a-f0-9]{32}$/.test(retained.memberRef))
  assert(/^[a-f0-9]{32}$/.test(retained.cacheNamespace))
  assert.notStrictEqual(retained.memberRef, 'a'.repeat(32))
  assert.notStrictEqual(retained.cacheNamespace, 'b'.repeat(32))
  const control = database.record('meal_members', CONTROL_ID)
  assert.strictEqual(control.ownerOpenid, 'owner')
  assert.strictEqual(control.activeMemberCount, 1)
  assert.strictEqual(control.reservedInviteCount, 0)
  assert.strictEqual(control.revision, 12)

  const snapshot = {
    member: database.record('meal_members', 'owner'),
    control: database.record('meal_members', CONTROL_ID),
  }
  await assert.rejects(
    privacy._test.finalizeMembershipDeletion('owner', 'b'.repeat(32)),
    (error) => error.code === 'STALE_DATA_GENERATION',
  )
  assert.deepStrictEqual(database.record('meal_members', 'owner'), snapshot.member)
  assert.deepStrictEqual(database.record('meal_members', CONTROL_ID), snapshot.control)
}

async function ownerRecoveryRejectsInvalidState() {
  const cases = [
    { name: 'missing member', member: null },
    { name: 'ordinary deleting member', member: { ...member('member', 'deleting'), preserveOwnerAfterClear: true } },
    { name: 'owner without preservation marker', member: member('owner', 'deleting') },
    { name: 'wrong control owner', member: { ...member('owner', 'deleting'), preserveOwnerAfterClear: true }, control: { ownerOpenid: 'other' } },
    { name: 'wrong active count', member: { ...member('owner', 'deleting'), preserveOwnerAfterClear: true }, control: { activeMemberCount: 2 } },
    { name: 'reserved invite remains', member: { ...member('owner', 'deleting'), preserveOwnerAfterClear: true }, control: { reservedInviteCount: 1 } },
  ]
  for (const scenario of cases) {
    const records = { [CONTROL_ID]: activeControl({ activeMemberCount: 1, ...scenario.control }) }
    if (scenario.member) records.owner = scenario.member
    database.reset({ meal_members: records })
    const beforeMember = database.record('meal_members', 'owner')
    const beforeControl = database.record('meal_members', CONTROL_ID)
    await assert.rejects(
      privacy._test.finalizeMembershipDeletion('owner', scenario.member && scenario.member.cacheNamespace || CACHE_NAMESPACE),
      (error) => error.code === 'MEMBERSHIP_INVARIANT_FAILED',
      scenario.name,
    )
    assert.deepStrictEqual(database.record('meal_members', 'owner'), beforeMember, scenario.name)
    assert.deepStrictEqual(database.record('meal_members', CONTROL_ID), beforeControl, scenario.name)
  }

  for (const role of ['owner', 'member']) {
    database.reset({ meal_members: {
      [CONTROL_ID]: activeControl({ activeMemberCount: role === 'owner' ? 1 : 2 }),
      owner: member('owner'),
      ...(role === 'member' ? { member: member() } : {}),
    } })
    const id = role === 'owner' ? 'owner' : 'member'
    const beforeMember = database.record('meal_members', id)
    const beforeControl = database.record('meal_members', CONTROL_ID)
    await assert.rejects(
      privacy._test.finalizeMembershipDeletion(id, CACHE_NAMESPACE),
      (error) => error.code === 'MEMBERSHIP_INVARIANT_FAILED',
    )
    assert.deepStrictEqual(database.record('meal_members', id), beforeMember)
    assert.deepStrictEqual(database.record('meal_members', CONTROL_ID), beforeControl)
  }

  database.reset({ meal_members: {
    [CONTROL_ID]: activeControl({ activeMemberCount: 1 }),
    owner: member('owner'),
    member: { ...member('member', 'deleting'), preserveOwnerAfterClear: 'false' },
  } })
  const invalidMarkerMember = database.record('meal_members', 'member')
  const invalidMarkerControl = database.record('meal_members', CONTROL_ID)
  await assert.rejects(
    privacy._test.finalizeMembershipDeletion('member', CACHE_NAMESPACE),
    (error) => error.code === 'MEMBERSHIP_INVARIANT_FAILED',
  )
  assert.deepStrictEqual(database.record('meal_members', 'member'), invalidMarkerMember)
  assert.deepStrictEqual(database.record('meal_members', CONTROL_ID), invalidMarkerControl)
}

async function concurrentOwnerPreparationCannotDowngradeRecovery() {
  const expectedCacheNamespace = 'b'.repeat(32)
  database.reset({ meal_members: {
    [CONTROL_ID]: activeControl({ activeMemberCount: 1 }),
    owner: {
      ...member('owner'), memberRef: 'a'.repeat(32), cacheNamespace: 'b'.repeat(32),
    },
  } })
  const requestBSnapshotPaused = deferred()
  const resumeRequestBSnapshot = deferred()
  const requestAAfterPreparePaused = deferred()
  const resumeRequestA = deferred()
  let activeSnapshotCount = 0
  let requestACollectionPaused = false
  database.beforeQueryGet = async ({ name, criteria }) => {
    if (name === 'meal_members' && criteria.status === 'active') {
      activeSnapshotCount += 1
      if (activeSnapshotCount !== 2) return
      requestBSnapshotPaused.resolve()
      await resumeRequestBSnapshot.promise
      return
    }
    if (name === 'health_daily' && !requestACollectionPaused) {
      requestACollectionPaused = true
      requestAAfterPreparePaused.resolve()
      await resumeRequestA.promise
    }
  }

  // Request B has read the owner as active, then pauses before reading its
  // non-transactional active-member snapshot.
  const requestB = privacy._test.clearMyData('owner', expectedCacheNamespace)
  await requestBSnapshotPaused.promise
  assert.strictEqual(activeSnapshotCount, 2, 'B 必须暂停在 prepare 的 active-member 快照')

  // Request A commits the authoritative deleting-owner marker, then pauses
  // during private-data collection so B can resume with an empty snapshot.
  const requestA = privacy._test.clearMyData('owner', expectedCacheNamespace)
  await requestAAfterPreparePaused.promise
  const deleting = database.record('meal_members', 'owner')
  assert.strictEqual(deleting.status, 'deleting')
  assert.strictEqual(deleting.role, 'owner')
  assert.strictEqual(deleting.preserveOwnerAfterClear, true)

  // B observes no active member, re-reads the deleting owner in its prepare
  // transaction, and restores from persisted state instead of a stack value.
  resumeRequestBSnapshot.resolve()
  assert.deepStrictEqual(await requestB, {
    cleared: true,
    healthRecordCount: 0,
    inviteRecordCount: 0,
    aiTaskRecordCount: 0,
    aiShardRecordCount: 0,
    aiControlRecordCount: 0,
    membershipDeleted: false,
    ownerAccessRetained: true,
  })

  // A then reaches finalize after B has restored the minimal owner identity;
  // this second finalization must be idempotent and must not rotate it again.
  const restored = database.record('meal_members', 'owner')
  const restoredControl = database.record('meal_members', CONTROL_ID)
  resumeRequestA.resolve()
  await assert.rejects(requestA, (error) => error.code === 'STALE_DATA_GENERATION')
  assert.deepStrictEqual(database.record('meal_members', 'owner'), restored)
  assert.deepStrictEqual(database.record('meal_members', CONTROL_ID), restoredControl)
  assert.strictEqual(database.record('meal_members', 'owner').status, 'active')
  assert.strictEqual(database.record('meal_members', 'owner').role, 'owner')
  assert.strictEqual(database.record('meal_members', CONTROL_ID).ownerOpenid, 'owner')
  assert.strictEqual(database.record('meal_members', CONTROL_ID).activeMemberCount, 1)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).revision, 12)
}

async function run() {
  assertStrictNotFoundClassification()
  assertFixedPublicErrors()
  const source = fs.readFileSync(path.resolve(__dirname, 'index.js'), 'utf8')
  assert(!/removeDocument\(['"]meal_members['"]/.test(source), '成员物理删除不能绕过 control 事务')
  assert(!/removeDocuments\(['"]meal_invites['"]/.test(source), '邀请码物理删除不能绕过 control 事务')
  await initialNamespaceMismatchIsFailClosed()
  await everyDeletionStageRejectsRotatedNamespace()
  await namespaceRotationBetweenQueryAndTransactionIsFailClosed()
  await namespaceRotationDuringDeleteFileWaitStopsLaterSideEffects()
  await namespaceRotationDuringUploadFileWaitStopsLaterSideEffects()
  await placeholderCleanupFailureKeepsDeletionRetryable()
  await memberDeletionUsesControl()
  await inactiveMemberMarkUsesControl()
  await inviteWritesUseControl()
  await bootstrapSentinelBlocksEveryPrivacyMembershipWrite()
  await deletingProfileRemovesPhoneBinding()
  await healthCleanupTicketSurvivesFailureAndClearReclaimsIt()
  await batchDeleteAmbiguityFallsBackSafely()
  await memberUploadLeaseBlocksAndRetries()
  await soleOwnerUploadLeaseRotatesOnceAcrossConcurrentRetries()
  await legacyInboxCleanupIsRetryableAndFailClosed()
  await soleOwnerClearRetainsMinimalAdministrator()
  await ownerRecoveryRejectsInvalidState()
  await concurrentOwnerPreparationCannotDowngradeRecovery()
  console.log('privacy membership control entry tests passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
