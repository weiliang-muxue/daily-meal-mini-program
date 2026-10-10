'use strict'

const assert = require('assert')
const crypto = require('crypto')
const Module = require('module')
const path = require('path')
const { CONTROL_ID, LEGAL_CONSENT_VERSION } = require('./core')

const OWNER = 'owner-account'
const MEMBER = 'member-account'
const CONSENT = Object.freeze({ version: LEGAL_CONSENT_VERSION, privacyRead: true, agreementRead: true, accepted: true })
const HOURS_PER_DAY = 24
const LEGACY_MAX_MEMBERS = 14
const LEGACY_CONTROL_CONFIGURATION = Object.freeze({
  inviteSlots: LEGACY_MAX_MEMBERS - 1,
  inviteTtlHours: HOURS_PER_DAY,
})
const V020_CONTROL_CONFIGURATION = Object.freeze({ inviteSlots: 3, inviteTtlHours: 168 })
const PRIVATE_COLLECTIONS = [
  'meal_users', 'meal_user_states', 'meal_avatar_uploads', 'health_daily',
  'health_photo_uploads', 'meal_ai_tasks', 'meal_ai_shards', 'meal_ai_controls',
]
const CONTROL = () => ({
  kind: 'control', status: 'control', schemaVersion: 2, phase: 'active', bootstrapRequestId: '',
  ownerOpenid: OWNER, activeMemberCount: 1, reservedInviteCount: 0, revision: 1,
})
const activeMember = (role, memberRef, cacheNamespace) => ({
  status: 'active', role, memberRef, cacheNamespace, joinedAt: 1, updatedAt: 1,
})
const hash = (code) => crypto.createHash('sha256').update(code.toUpperCase()).digest('hex')

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) }

class MemoryDatabase {
  constructor() {
    this.docs = new Map()
    this.tail = Promise.resolve()
    this.clock = 1000
  }

  reset(seed = {}) {
    this.docs = new Map(Object.entries(seed).map(([collection, records]) => [
      collection, new Map(Object.entries(records).map(([id, value]) => [id, clone(value)])),
    ]))
    this.tail = Promise.resolve()
    this.beforeQueryGet = null
    this.beforeTransaction = null
  }

  bucket(name, source = this.docs) {
    if (!source.has(name)) source.set(name, new Map())
    return source.get(name)
  }

  collection(name, source = null) {
    const database = this
    const resolveSource = () => source || database.docs
    return {
      doc(id) { return database.document(name, id, resolveSource) },
      where(criteria) { return database.query(name, criteria, resolveSource) },
    }
  }

  document(collectionName, id, resolveSource) {
    const database = this
    return {
      async get() {
        const record = database.bucket(collectionName, resolveSource()).get(id)
        if (record === undefined) throw new Error('DATABASE_DOCUMENT_NOT_FOUND')
        return { data: clone(record) }
      },
      async set({ data }) { database.bucket(collectionName, resolveSource()).set(id, clone(data)) },
      async update({ data }) {
        const bucket = database.bucket(collectionName, resolveSource())
        if (!bucket.has(id)) throw new Error('DATABASE_DOCUMENT_NOT_FOUND')
        bucket.set(id, { ...clone(bucket.get(id)), ...clone(data) })
      },
    }
  }

  query(collectionName, criteria, resolveSource, offset = 0, maximum = Infinity) {
    const database = this
    return {
      skip(value) { return database.query(collectionName, criteria, resolveSource, Number(value) || 0, maximum) },
      limit(value) { return database.query(collectionName, criteria, resolveSource, offset, Number(value) || 0) },
      async get() {
        if (database.beforeQueryGet) await database.beforeQueryGet({ collectionName, criteria })
        const rows = [...database.bucket(collectionName, resolveSource()).entries()]
          .filter(([, record]) => Object.entries(criteria).every(([key, value]) => record[key] === value))
          .slice(offset, offset + maximum)
          .map(([id, record]) => ({ _id: id, ...clone(record) }))
        return { data: rows }
      },
    }
  }

  runTransaction(callback) {
    const run = this.tail.then(async () => {
      if (this.beforeTransaction) await this.beforeTransaction()
      const draft = new Map([...this.docs.entries()].map(([name, records]) => [
        name, new Map([...records.entries()].map(([id, value]) => [id, clone(value)])),
      ]))
      const transaction = { collection: (name) => this.collection(name, draft) }
      const result = await callback(transaction)
      this.docs = draft
      return result
    })
    this.tail = run.catch(() => {})
    return run
  }

  serverDate() { this.clock += 1; return this.clock }
  command = {}

  record(collection, id) { return clone(this.bucket(collection).get(id)) }
  records(collection) { return [...this.bucket(collection).entries()].map(([id, value]) => ({ _id: id, ...clone(value) })) }
}

const database = new MemoryDatabase()
let currentIdentity = OWNER
const fakeCloud = {
  DYNAMIC_CURRENT_ENV: 'test-environment',
  init() {},
  database: () => database,
  getWXContext: () => ({ OPENID: currentIdentity }),
}

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'wx-server-sdk') return fakeCloud
  return originalLoad.call(this, request, parent, isMain)
}
const modulePath = path.resolve(__dirname, 'index.js')
delete require.cache[modulePath]
const membership = require(modulePath)
Module._load = originalLoad

const { notFound } = require('./not-found')

function assertStrictNotFoundClassification() {
  assert.strictEqual(notFound({
    errCode: -1,
    message: 'document.get:fail document with _id absent-record does not exist',
    errMsg: 'document.get:fail document with _id absent-record does not exist',
  }), true)
  assert.strictEqual(notFound({
    errCode: -502005,
    message: 'document.get:fail document with _id misleading-record does not exist',
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
  const privateDetail = 'attacker-controlled private membership detail'
  const known = membership._test.publicError(Object.assign(new Error(privateDetail), { code: 'OWNER_REQUIRED' }))
  assert.deepStrictEqual(known, { code: 'OWNER_REQUIRED', message: '只有管理员可以管理成员' })
  assert.strictEqual(JSON.stringify(known).includes(privateDetail), false)
  const unknown = membership._test.publicError(Object.assign(new Error(privateDetail), { code: 'PRIVATE_BACKEND_FAILURE' }))
  assert.deepStrictEqual(unknown, { code: 'MEMBERSHIP_FAILED', message: '成员服务暂时不可用，请重试' })
  assert.strictEqual(JSON.stringify(unknown).includes(privateDetail), false)
  assert.deepStrictEqual(
    membership._test.publicError(Object.assign(new Error(privateDetail), { code: 'INVITE_REFERENCE_INVALID' })),
    { code: 'INVITE_REFERENCE_INVALID', message: '邀请不存在或状态已变化' },
  )
  for (const [code, message] of Object.entries({
    MEMBER_REFERENCE_INVALID: '成员引用无效',
    MEMBER_NOT_FOUND: '成员不存在或状态已变化',
    MEMBER_NOTE_INVALID: '管理员备注最多 100 字',
  })) assert.deepStrictEqual(membership._test.publicError(Object.assign(new Error(privateDetail), { code })), { code, message })
}

function invite(code, expiresAt, label = '') {
  return { codeHash: hash(code), label, active: true, maxUses: 1, usedCount: 0, expiresAt }
}

function seed(invites = {}, members = {}) {
  database.reset({
    meal_members: {
      [CONTROL_ID]: CONTROL(),
      [OWNER]: activeMember('owner', 'a'.repeat(32), '1'.repeat(32)),
      ...members,
    },
    meal_invites: invites,
  })
}

function memberFixtures(count, prefix = 'fixture-member') {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [
    `${prefix}-${index}`,
    activeMember('member', (index + 1).toString(16).padStart(32, '0'), (index + 1001).toString(16).padStart(32, '0')),
  ]))
}

function seedPrivateCollections(accounts) {
  for (const collection of PRIVATE_COLLECTIONS) {
    for (const account of accounts) {
      database.bucket(collection).set(account, {
        fixture: `${collection}-${account}`, nested: { retained: true }, values: ['synthetic-data'],
      })
    }
  }
}

function privateCollectionSnapshot() {
  return Object.fromEntries(PRIVATE_COLLECTIONS.map((collection) => [collection, database.records(collection)]))
}

async function twoAccountsCannotConsumeOneInvite() {
  const now = Date.now()
  seed({ invitation: invite('CODE-A', now + 60000, '家人') })
  database.bucket('meal_members').set(CONTROL_ID, { ...CONTROL(), reservedInviteCount: 1 })
  const results = await Promise.allSettled([
    membership._test.acceptInvite('account-a', 'CODE-A', CONSENT),
    membership._test.acceptInvite('account-b', 'CODE-A', CONSENT),
  ])
  assert.strictEqual(results.filter((item) => item.status === 'fulfilled').length, 1)
  assert.strictEqual(results.filter((item) => item.status === 'rejected').length, 1)
  const joined = ['account-a', 'account-b'].map((id) => database.record('meal_members', id)).filter(Boolean)
  assert.strictEqual(joined.length, 1)
  assert.strictEqual(joined[0].role, 'member', '邀请码永远只能产生普通成员')
  const joinedId = ['account-a', 'account-b'].find((id) => database.record('meal_members', id))
  await assert.rejects(membership._test.createInvite(joinedId, ''), (error) => error.code === 'OWNER_REQUIRED')
  await assert.rejects(membership._test.listMembers(joinedId), (error) => error.code === 'OWNER_REQUIRED')
  await assert.rejects(
    membership._test.revokeInvite(joinedId, 'a'.repeat(32)),
    (error) => error.code === 'OWNER_REQUIRED',
  )
  assert.strictEqual(database.record('meal_members', CONTROL_ID).activeMemberCount, 2)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).reservedInviteCount, 0)
  assert.strictEqual(database.record('meal_invites', 'invitation').active, false)
}

async function oneAccountCannotConsumeTwoInvites() {
  const now = Date.now()
  seed({ first: invite('CODE-B', now + 60000), second: invite('CODE-C', now + 60000) })
  database.bucket('meal_members').set(CONTROL_ID, { ...CONTROL(), reservedInviteCount: 2 })
  const results = await Promise.allSettled([
    membership._test.acceptInvite('same-account', 'CODE-B', CONSENT),
    membership._test.acceptInvite('same-account', 'CODE-C', CONSENT),
  ])
  assert(results.every((item) => item.status === 'fulfilled'))
  const invitations = database.records('meal_invites')
  assert.strictEqual(invitations.filter((item) => item.active === false).length, 1)
  assert.strictEqual(invitations.filter((item) => item.active === true).length, 1)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).activeMemberCount, 2)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).reservedInviteCount, 1)
  assert.strictEqual(database.record('meal_members', 'same-account').role, 'member')
}

async function exactExpiryIsRejected() {
  const expiresAt = 2000000000000
  const originalNow = Date.now
  Date.now = () => expiresAt
  try {
    seed({ expired: invite('CODE-D', expiresAt) })
    database.bucket('meal_members').set(CONTROL_ID, { ...CONTROL(), reservedInviteCount: 1 })
    await assert.rejects(
      membership._test.acceptInvite('late-account', 'CODE-D', CONSENT),
      (error) => error.code === 'INVITE_INVALID',
    )
    assert.strictEqual(database.record('meal_members', 'late-account'), undefined)
    assert.strictEqual(database.record('meal_invites', 'expired').active, false)
    assert.strictEqual(database.record('meal_members', CONTROL_ID).reservedInviteCount, 0)
  } finally { Date.now = originalNow }
}

async function createdInviteUsesStrongOneTimeCode() {
  const now = 2000000000000
  const originalNow = Date.now
  Date.now = () => now
  try {
    seed()
    const created = await membership._test.createInvite(OWNER, '测试成员')
    assert(/^[A-F0-9]{32}$/.test(created.code), '正式邀请码必须是 32 位大写十六进制')
    assert(/^[a-f0-9]{32}$/.test(created.inviteRef), '邀请引用必须是独立随机引用')
    assert.strictEqual(Object.prototype.hasOwnProperty.call(created, 'id'), false)
    assert.strictEqual(created.expiresAt, now + 7 * 24 * 60 * 60 * 1000)
    const stored = database.record('meal_invites', created.inviteRef)
    assert.strictEqual(stored.codeHash, hash(created.code))
    assert.strictEqual(stored.active, true)
    assert.strictEqual(stored.maxUses, 1)
    assert.strictEqual(stored.usedCount, 0)
    assert.strictEqual(stored.expiresAt, created.expiresAt)
    assert.strictEqual(database.record('meal_members', CONTROL_ID).reservedInviteCount, 1)
  } finally { Date.now = originalNow }
}

async function createListRevokeListLifecycle() {
  const now = 2000000000000
  const originalNow = Date.now
  Date.now = () => now
  try {
    seed()
    const created = await membership._test.createInvite(OWNER, '生命周期测试')
    assert.strictEqual(database.record('meal_members', CONTROL_ID).reservedInviteCount, 1)

    const listedAfterCreate = await membership._test.listMembers(OWNER)
    assert.deepStrictEqual(listedAfterCreate.activeInvites, [{
      inviteRef: created.inviteRef,
      label: '生命周期测试',
      expiresAt: created.expiresAt,
    }])
    const serialized = JSON.stringify(listedAfterCreate)
    assert.strictEqual(serialized.includes(created.code), false, '列表响应不得包含邀请明文')
    assert.strictEqual(serialized.includes(hash(created.code)), false, '列表响应不得包含邀请哈希')

    assert.deepStrictEqual(await membership._test.revokeInvite(OWNER, created.inviteRef), { revoked: true })
    assert.strictEqual(database.record('meal_members', CONTROL_ID).reservedInviteCount, 0)
    const listedAfterRevoke = await membership._test.listMembers(OWNER)
    assert.deepStrictEqual(listedAfterRevoke.activeInvites, [])
  } finally { Date.now = originalNow }
}

async function legacyTenCharacterInviteStillCreatesOnlyMember() {
  const legacyCode = 'A1B2C3D4E5'
  const inviteRef = '7'.repeat(32)
  seed({ [inviteRef]: invite(legacyCode, Date.now() + 60000, '旧版邀请') })
  database.bucket('meal_members').set(CONTROL_ID, { ...CONTROL(), reservedInviteCount: 1 })

  const result = await membership._test.acceptInvite('legacy-invite-account', legacyCode.toLowerCase(), CONSENT)
  const joined = database.record('meal_members', 'legacy-invite-account')
  assert.strictEqual(result.status, 'active')
  assert.strictEqual(result.role, 'member')
  assert.strictEqual(joined.status, 'active')
  assert.strictEqual(joined.role, 'member', '旧版邀请码也不能授予管理员权限')
  assert.strictEqual(database.record('meal_invites', inviteRef).active, false)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).activeMemberCount, 2)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).reservedInviteCount, 0)
}

async function listMembersReturnsOnlySafeActiveInvites() {
  const now = Date.now()
  const activeRef = '1'.repeat(32)
  const expiredRef = '2'.repeat(32)
  seed({
    [activeRef]: {
      ...invite('SAFE-CODE', now + 60000, ' 家人 '),
      createdBy: OWNER, usedBy: 'must-not-leak',
    },
    [expiredRef]: { ...invite('OLD-CODE', now - 1, '过期'), createdBy: OWNER },
  })
  database.bucket('meal_members').set(CONTROL_ID, { ...CONTROL(), reservedInviteCount: 2 })
  const summary = await membership._test.listMembers(OWNER)
  assert.deepStrictEqual(summary.activeInvites, [{ inviteRef: activeRef, label: '家人', expiresAt: now + 60000 }])
  const serialized = JSON.stringify(summary.activeInvites)
  ;['codeHash', 'createdBy', 'usedBy', OWNER, 'SAFE-CODE'].forEach((secret) => {
    assert.strictEqual(serialized.includes(secret), false, `待使用邀请响应不得包含 ${secret}`)
  })
  assert.strictEqual(database.record('meal_invites', expiredRef).active, false)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).reservedInviteCount, 1)
}

async function revokeInviteIsAuthorizedAndIdempotent() {
  const now = Date.now()
  const inviteRef = '3'.repeat(32)
  seed({ [inviteRef]: { ...invite('REVOKE-CODE', now + 60000), createdBy: OWNER } })
  database.bucket('meal_members').set(CONTROL_ID, { ...CONTROL(), reservedInviteCount: 1 })

  const revoked = await membership._test.revokeInvite(OWNER, inviteRef)
  assert.deepStrictEqual(revoked, { revoked: true })
  assert.strictEqual(database.record('meal_invites', inviteRef).active, false)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).reservedInviteCount, 0)

  const replay = await membership._test.revokeInvite(OWNER, inviteRef)
  assert.deepStrictEqual(replay, { revoked: false })
  assert.strictEqual(database.record('meal_members', CONTROL_ID).reservedInviteCount, 0,
    '重复撤销不得再次释放名额')

  await assert.rejects(
    membership._test.revokeInvite(OWNER, '4'.repeat(32)),
    (error) => error.code === 'INVITE_REFERENCE_INVALID',
  )
  await assert.rejects(
    membership._test.revokeInvite(MEMBER, inviteRef),
    (error) => error.code === 'OWNER_REQUIRED',
  )
  await assert.rejects(
    membership._test.revokeInvite(MEMBER, 'forged-reference'),
    (error) => error.code === 'OWNER_REQUIRED',
  )
  await assert.rejects(
    membership._test.revokeInvite(OWNER, 'forged-reference'),
    (error) => error.code === 'INVITE_REFERENCE_INVALID',
  )
  await assert.rejects(
    membership._test.revokeInvite(OWNER, `${inviteRef}suffix`),
    (error) => error.code === 'INVITE_REFERENCE_INVALID',
  )
}

async function usedInviteDoesNotReleaseTwice() {
  const inviteRef = '5'.repeat(32)
  seed({
    [inviteRef]: {
      ...invite('USED-CODE', Date.now() + 60000), active: false, usedCount: 1,
      usedBy: MEMBER, createdBy: OWNER,
    },
  })
  const result = await membership._test.revokeInvite(OWNER, inviteRef)
  assert.deepStrictEqual(result, { revoked: false })
  assert.strictEqual(database.record('meal_members', CONTROL_ID).reservedInviteCount, 0)
}

async function redeemAndRevokeAreSerialized() {
  const inviteRef = '6'.repeat(32)
  seed({ [inviteRef]: { ...invite('RACE-CODE', Date.now() + 60000), createdBy: OWNER } })
  database.bucket('meal_members').set(CONTROL_ID, { ...CONTROL(), reservedInviteCount: 1 })
  const results = await Promise.allSettled([
    membership._test.acceptInvite('race-member', 'RACE-CODE', CONSENT),
    membership._test.revokeInvite(OWNER, inviteRef),
  ])
  const joined = database.record('meal_members', 'race-member')
  const storedInvite = database.record('meal_invites', inviteRef)
  const control = database.record('meal_members', CONTROL_ID)
  assert.strictEqual(storedInvite.active, false)
  assert.strictEqual(control.reservedInviteCount, 0)
  if (joined) {
    assert.strictEqual(joined.status, 'active')
    assert.strictEqual(control.activeMemberCount, 2)
    assert.strictEqual(results[1].status, 'fulfilled')
    assert.deepStrictEqual(results[1].value, { revoked: false })
  } else {
    assert.strictEqual(control.activeMemberCount, 1)
    assert.strictEqual(results[0].status, 'rejected')
    assert.strictEqual(results[1].status, 'fulfilled')
    assert.deepStrictEqual(results[1].value, { revoked: true })
  }
}

async function transferAndInviteCreationKeepOneOwner() {
  seed({}, {
    [MEMBER]: activeMember('member', 'b'.repeat(32), '2'.repeat(32)),
  })
  database.bucket('meal_members').set(CONTROL_ID, { ...CONTROL(), activeMemberCount: 2 })
  const results = await Promise.allSettled([
    membership._test.createInvite(OWNER, '交接期间创建'),
    membership._test.transferOwner(OWNER, 'b'.repeat(32), true),
  ])
  assert.strictEqual(results[1].status, 'fulfilled')
  const active = database.records('meal_members').filter((item) => item.status === 'active')
  assert.deepStrictEqual(active.filter((item) => item.role === 'owner').map((item) => item._id), [MEMBER])
  assert.strictEqual(database.record('meal_members', OWNER).role, 'member')
  assert.strictEqual(database.record('meal_members', CONTROL_ID).ownerOpenid, MEMBER)
  const createdInvites = database.records('meal_invites')
  assert(createdInvites.length <= 1)
  if (createdInvites.length) assert.strictEqual(createdInvites[0].active, true)
}

async function memberCannotUseManagementActions() {
  seed({}, {
    [MEMBER]: activeMember('member', 'b'.repeat(32), '2'.repeat(32)),
  })
  await assert.rejects(membership._test.createInvite(MEMBER, ''), (error) => error.code === 'OWNER_REQUIRED')
  await assert.rejects(
    membership._test.transferOwner(MEMBER, 'a'.repeat(32), true),
    (error) => error.code === 'OWNER_REQUIRED',
  )
  await assert.rejects(
    membership._test.revokeInvite(MEMBER, 'a'.repeat(32)),
    (error) => error.code === 'OWNER_REQUIRED',
  )
  await assert.rejects(
    membership._test.setMemberNote(MEMBER, 'a'.repeat(32), '无权备注'),
    (error) => error.code === 'OWNER_REQUIRED',
  )
  currentIdentity = MEMBER
  const response = await membership.main({ action: 'createInvite', label: '' })
  assert.strictEqual(response.success, false)
  assert.strictEqual(response.code, 'OWNER_REQUIRED')
}

async function bootstrapSentinelBlocksEveryMembershipWrite() {
  for (const phase of ['bootstrap_pending', 'bootstrap_approved']) {
    seed({}, {
      [MEMBER]: activeMember('member', 'b'.repeat(32), '2'.repeat(32)),
    })
    database.bucket('meal_members').set(CONTROL_ID, {
      ...CONTROL(), phase, bootstrapRequestId: 'f'.repeat(32),
      ownerOpenid: '', activeMemberCount: 0,
    })
    const before = JSON.stringify(database.records('meal_members'))
    await assert.rejects(
      membership._test.createInvite(OWNER, '初始化竞态'),
      (error) => error.code === 'MEMBERSHIP_BOOTSTRAP_IN_PROGRESS',
    )
    await assert.rejects(
      membership._test.acceptInvite('new-account', 'NO-CODE', CONSENT),
      (error) => error.code === 'MEMBERSHIP_BOOTSTRAP_IN_PROGRESS',
    )
    await assert.rejects(
      membership._test.transferOwner(OWNER, 'b'.repeat(32), true),
      (error) => error.code === 'MEMBERSHIP_BOOTSTRAP_IN_PROGRESS',
    )
    await assert.rejects(
      membership._test.expireInvite('missing-invite', Date.now()),
      (error) => error.code === 'MEMBERSHIP_BOOTSTRAP_IN_PROGRESS',
    )
    await assert.rejects(
      membership._test.revokeInvite(OWNER, 'a'.repeat(32)),
      (error) => error.code === 'MEMBERSHIP_BOOTSTRAP_IN_PROGRESS',
    )
    await assert.rejects(
      membership._test.setMemberNote(OWNER, 'b'.repeat(32), '初始化期间不可写'),
      (error) => error.code === 'MEMBERSHIP_BOOTSTRAP_IN_PROGRESS',
    )
    assert.strictEqual(JSON.stringify(database.records('meal_members')), before)
    assert.deepStrictEqual(database.records('meal_invites'), [])
  }
}

async function legacyControlUpgradesWithoutLosingCounts() {
  seed()
  database.bucket('meal_members').set(CONTROL_ID, {
    kind: 'control', status: 'control', schemaVersion: 1,
    ownerOpenid: OWNER, activeMemberCount: 1, reservedInviteCount: 0, revision: 9,
  })
  const result = await membership._test.status(OWNER)
  assert.strictEqual(result.status, 'active')
  const upgraded = database.record('meal_members', CONTROL_ID)
  assert.strictEqual(upgraded.schemaVersion, 2)
  assert.strictEqual(upgraded.phase, 'active')
  assert.strictEqual(upgraded.bootstrapRequestId, '')
  assert.strictEqual(upgraded.ownerOpenid, OWNER)
  assert.strictEqual(upgraded.activeMemberCount, 1)
  assert.strictEqual(upgraded.reservedInviteCount, 0)
  assert.strictEqual(upgraded.revision, 10)
  assert.strictEqual(upgraded.inviteSlots, 10)
  assert.strictEqual(upgraded.inviteTtlHours, 168)
}

async function capacityExpansionPreservesV020RecordsAndInvites() {
  for (const activeMemberCount of [1, 2, 4]) {
    const existingMembers = memberFixtures(activeMemberCount - 1)
    const reservedInviteCount = 4 - activeMemberCount
    const originalInvites = Object.fromEntries(Array.from({ length: reservedInviteCount }, (_, index) => [
      (index + 1).toString(16).padStart(32, '0'),
      {
        ...invite(`A1B2C3D4E${index}`, Date.now() + (index + 1) * 60 * 60 * 1000, `旧邀请 ${index}`),
        createdBy: OWNER, createdAt: 2,
      },
    ]))
    seed(originalInvites, existingMembers)
    seedPrivateCollections([OWNER, ...Object.keys(existingMembers)])
    const originalControl = {
      ...CONTROL(), ...V020_CONTROL_CONFIGURATION, activeMemberCount, reservedInviteCount, revision: 23,
    }
    database.bucket('meal_members').set(CONTROL_ID, originalControl)
    const beforeMembers = database.records('meal_members').filter((record) => record._id !== CONTROL_ID)
    const beforeInvites = database.records('meal_invites')
    const beforePrivate = privateCollectionSnapshot()

    const statuses = await Promise.all([membership._test.status(OWNER), membership._test.status(OWNER)])
    for (const result of statuses) {
      assert.strictEqual(result.status, 'active')
      assert.strictEqual(result.maxMembers, 11)
      assert.strictEqual(result.inviteSlots, 10)
      assert.strictEqual(result.inviteTtlHours, 168)
      assert.strictEqual(result.capacityExceeded, false)
    }
    const summary = await membership._test.listMembers(OWNER)
    assert.strictEqual(summary.count, activeMemberCount)
    assert.strictEqual(summary.activeInvites.length, reservedInviteCount)
    assert.deepStrictEqual(database.records('meal_members').filter((record) => record._id !== CONTROL_ID), beforeMembers,
      '4 人扩到 11 人不得改写已有成员身份、资料引用或缓存代际')
    assert.deepStrictEqual(database.records('meal_invites'), beforeInvites,
      '扩容必须保留旧有效邀请码的摘要、使用状态和原到期时间')
    assert.deepStrictEqual(privateCollectionSnapshot(), beforePrivate,
      '扩容不得清空或改写任何个人数据集合')
    const { updatedAt, ...upgradedControl } = database.record('meal_members', CONTROL_ID)
    assert(updatedAt > 0)
    assert.deepStrictEqual(upgradedControl, { ...originalControl, inviteSlots: 10, revision: 24 })

    if (reservedInviteCount > 0) {
      const joined = await membership._test.acceptInvite('after-expansion-account', 'A1B2C3D4E0', CONSENT)
      assert.strictEqual(joined.status, 'active', '扩容前发放的有效邀请码仍可兑换')
      assert.strictEqual(joined.role, 'member')
      const consumed = database.record('meal_invites', Object.keys(originalInvites)[0])
      assert.strictEqual(consumed.usedCount, 1)
      assert.strictEqual(consumed.expiresAt, originalInvites[Object.keys(originalInvites)[0]].expiresAt)
      for (const [inviteRef, original] of Object.entries(originalInvites).slice(1)) {
        assert.deepStrictEqual(database.record('meal_invites', inviteRef), original)
      }
      for (const member of beforeMembers) {
        const { _id, ...original } = member
        assert.deepStrictEqual(database.record('meal_members', _id), original)
      }
      assert.deepStrictEqual(privateCollectionSnapshot(), beforePrivate)
    }
  }
}

async function tenInvitedMembersFillElevenTotalSeats() {
  seed()
  const created = await Promise.all(Array.from({ length: 10 }, (_, index) => (
    membership._test.createInvite(OWNER, `第 ${index + 1} 位成员`)
  )))
  assert.strictEqual(created.length, 10)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).activeMemberCount, 1)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).reservedInviteCount, 10)
  await assert.rejects(membership._test.createInvite(OWNER, '第 11 个邀请'), (error) => error.code === 'MEMBERSHIP_FULL')
  const joined = await Promise.all(created.map((invitation, index) => (
    membership._test.acceptInvite(`invited-account-${index}`, invitation.code, CONSENT)
  )))
  assert(joined.every((member) => member.role === 'member' && member.status === 'active'))
  const control = database.record('meal_members', CONTROL_ID)
  assert.strictEqual(control.activeMemberCount, 11)
  assert.strictEqual(control.reservedInviteCount, 0)
  assert.strictEqual(database.records('meal_members').filter((member) => member.role === 'owner').length, 1)
  assert.strictEqual(database.records('meal_members').filter((member) => member.role === 'member').length, 10)
  assert(database.records('meal_invites').every((invitation) => invitation.usedCount === 1 && invitation.active === false))
  await assert.rejects(membership._test.createInvite(OWNER, '满员后邀请'), (error) => error.code === 'MEMBERSHIP_FULL')
  await assert.rejects(membership._test.acceptInvite('twelfth-account', created[0].code, CONSENT),
    (error) => error.code === 'INVITE_INVALID')
  assert.strictEqual(database.record('meal_members', 'twelfth-account'), undefined)
}

async function concurrentRequestsCannotOverbookLastSeat() {
  seed({}, memberFixtures(9))
  database.bucket('meal_members').set(CONTROL_ID, {
    ...CONTROL(), activeMemberCount: 10, inviteSlots: 10, inviteTtlHours: 168,
  })
  const creations = await Promise.allSettled([
    membership._test.createInvite(OWNER, '最后名额甲'),
    membership._test.createInvite(OWNER, '最后名额乙'),
  ])
  const created = creations.filter((result) => result.status === 'fulfilled')
  assert.strictEqual(created.length, 1)
  assert.strictEqual(creations.find((result) => result.status === 'rejected').reason.code, 'MEMBERSHIP_FULL')
  assert.strictEqual(database.record('meal_members', CONTROL_ID).reservedInviteCount, 1)
  const redemptions = await Promise.allSettled([
    membership._test.acceptInvite('last-seat-a', created[0].value.code, CONSENT),
    membership._test.acceptInvite('last-seat-b', created[0].value.code, CONSENT),
  ])
  assert.strictEqual(redemptions.filter((result) => result.status === 'fulfilled').length, 1)
  assert.strictEqual(redemptions.find((result) => result.status === 'rejected').reason.code, 'INVITE_INVALID')
  assert.strictEqual(database.record('meal_members', CONTROL_ID).activeMemberCount, 11)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).reservedInviteCount, 0)
}

async function overCapacityActiveMembersRemainUsableAndUntouched() {
  const extraMembers = memberFixtures(LEGACY_MAX_MEMBERS - 1, 'legacy-member')
  seed({}, extraMembers)
  database.bucket('meal_members').set(CONTROL_ID, {
    ...CONTROL(), activeMemberCount: LEGACY_MAX_MEMBERS, ...LEGACY_CONTROL_CONFIGURATION,
  })
  const before = database.records('meal_members')
    .filter((record) => record._id !== CONTROL_ID)
    .sort((left, right) => left._id.localeCompare(right._id))

  const result = await membership._test.status(OWNER)
  assert.strictEqual(result.status, 'active')
  assert.strictEqual(result.maxMembers, 11)
  assert.strictEqual(result.inviteSlots, 10)
  assert.strictEqual(result.inviteTtlHours, 168)
  assert.strictEqual(result.capacityExceeded, true)
  for (const privateIdentity of Object.keys(extraMembers)) {
    assert.strictEqual(JSON.stringify(result).includes(privateIdentity), false)
  }
  const after = database.records('meal_members')
    .filter((record) => record._id !== CONTROL_ID)
    .sort((left, right) => left._id.localeCompare(right._id))
  assert.deepStrictEqual(after, before, '容量降配不得删除或改写任何已加入成员')
  const control = database.record('meal_members', CONTROL_ID)
  assert.strictEqual(control.activeMemberCount, LEGACY_MAX_MEMBERS)
  assert.strictEqual(control.reservedInviteCount, 0)
  assert.strictEqual(control.inviteSlots, 10)
  assert.strictEqual(control.inviteTtlHours, 168)
  await assert.rejects(
    membership._test.createInvite(OWNER, '不得新增'),
    (error) => error.code === 'MEMBERSHIP_FULL',
  )
  assert.deepStrictEqual(database.records('meal_members')
    .filter((record) => record._id !== CONTROL_ID)
    .sort((left, right) => left._id.localeCompare(right._id)), before)
}

async function migrationRevokesAllInvitesWhenActiveCapacityIsFull() {
  const members = memberFixtures(10, 'legacy-member')
  const expiresAt = Date.now() + 60 * 60 * 1000
  const legacyInvites = {
    ['1'.repeat(32)]: { ...invite('OLD-A', expiresAt), createdAt: 1 },
    ['2'.repeat(32)]: { ...invite('OLD-B', expiresAt), createdAt: 2 },
    ['3'.repeat(32)]: { ...invite('OLD-C', expiresAt), createdAt: 3 },
  }
  seed(legacyInvites, members)
  database.bucket('meal_members').set(CONTROL_ID, {
    ...CONTROL(), activeMemberCount: 11, reservedInviteCount: 3,
    ...LEGACY_CONTROL_CONFIGURATION,
  })
  const before = database.records('meal_members')
    .filter((record) => record._id !== CONTROL_ID)
    .sort((left, right) => left._id.localeCompare(right._id))

  const result = await membership._test.status(OWNER)
  assert.strictEqual(result.capacityExceeded, false)
  const control = database.record('meal_members', CONTROL_ID)
  assert.strictEqual(control.activeMemberCount, 11)
  assert.strictEqual(control.reservedInviteCount, 0)
  assert.strictEqual(database.records('meal_invites').filter((item) => item.active === true).length, 0)
  assert.strictEqual(database.records('meal_invites').filter((item) => item.capacityRevokedAt).length, 3)
  assert.deepStrictEqual(database.records('meal_members')
    .filter((record) => record._id !== CONTROL_ID)
    .sort((left, right) => left._id.localeCompare(right._id)), before)
}

async function concurrentEntrancesRevokeOnlyExcessInvites() {
  const expiresAt = Date.now() + 60 * 60 * 1000
  const legacyInvites = {}
  for (let index = 1; index <= 4; index += 1) {
    legacyInvites[String(index).repeat(32)] = {
      ...invite(`CONCURRENT-${index}`, expiresAt), createdAt: index,
    }
  }
  seed(legacyInvites, {
    [MEMBER]: activeMember('member', 'b'.repeat(32), '2'.repeat(32)),
    ...memberFixtures(7),
  })
  database.bucket('meal_members').set(CONTROL_ID, {
    ...CONTROL(), activeMemberCount: 9, reservedInviteCount: 4,
    ...LEGACY_CONTROL_CONFIGURATION,
  })
  const before = database.records('meal_members')
    .filter((record) => record._id !== CONTROL_ID)
    .sort((left, right) => left._id.localeCompare(right._id))

  const results = await Promise.all([
    membership._test.status(OWNER),
    membership._test.status(MEMBER),
  ])
  assert(results.every((result) => result.capacityExceeded === false))
  const activeInvites = database.records('meal_invites').filter((item) => item.active === true)
  const revokedInvites = database.records('meal_invites').filter((item) => item.capacityRevokedAt)
  assert.deepStrictEqual(activeInvites.map((item) => item._id).sort(), ['1'.repeat(32), '2'.repeat(32)])
  assert.deepStrictEqual(revokedInvites.map((item) => item._id).sort(), ['3'.repeat(32), '4'.repeat(32)])
  const control = database.record('meal_members', CONTROL_ID)
  assert.strictEqual(control.activeMemberCount, 9)
  assert.strictEqual(control.reservedInviteCount, 2)
  assert.deepStrictEqual(database.records('meal_members')
    .filter((record) => record._id !== CONTROL_ID)
    .sort((left, right) => left._id.localeCompare(right._id)), before)
}

async function deletingIdentityReceivesOnlyItsRecoveryHandle() {
  seed({}, {
    [MEMBER]: {
      ...activeMember('member', 'b'.repeat(32), '2'.repeat(32)),
      status: 'deleting',
      preserveOwnerAfterClear: false,
      displayLabel: 'private label',
      deletionRequestedAt: 100,
    },
    'another-account': {
      ...activeMember('member', 'c'.repeat(32), '3'.repeat(32)),
      displayLabel: 'another private label',
    },
  })
  const result = await membership._test.status(MEMBER)
  assert.deepStrictEqual(result, {
    status: 'deleting',
    cacheNamespace: '2'.repeat(32),
  })
  const serialized = JSON.stringify(result)
  for (const privateValue of [
    MEMBER, OWNER, 'another-account', 'private label', 'another private label',
    'b'.repeat(32), 'c'.repeat(32), '3'.repeat(32),
  ]) assert.strictEqual(serialized.includes(privateValue), false)
  await assert.rejects(
    membership._test.acceptInvite(MEMBER, 'ANY-CODE', CONSENT),
    (error) => error.code === 'ACCOUNT_DELETION_IN_PROGRESS',
    '清理中的可信身份不能通过邀请码重新加入',
  )

  database.bucket('meal_members').set(MEMBER, {
    status: 'deleting', role: 'member', cacheNamespace: 'invalid-recovery-handle',
  })
  await assert.rejects(
    membership._test.status(MEMBER),
    (error) => error.code === 'MEMBERSHIP_INVARIANT_FAILED',
    '缺失可信旧 namespace 时必须拒绝返回可恢复状态',
  )
}

async function missingOrInvalidConsentCannotWrite() {
  const inviteRef = 'e'.repeat(32)
  seed({ [inviteRef]: { ...invite('CONSENT-CODE', Date.now() + 60000), createdBy: OWNER, createdAt: 2 } })
  database.bucket('meal_members').set(CONTROL_ID, { ...CONTROL(), reservedInviteCount: 1 })
  const beforeMembers = database.records('meal_members')
  const beforeInvites = database.records('meal_invites')
  for (const legalConsent of [
    undefined, null, {}, true, { accepted: true }, { ...CONSENT, privacyRead: false },
    { ...CONSENT, agreementRead: false }, { ...CONSENT, accepted: false },
    { ...CONSENT, accepted: 'true' }, { ...CONSENT, version: 1 }, { ...CONSENT, version: 3 }, { ...CONSENT, version: '2' },
    { ...CONSENT, acceptedAt: 123 },
  ]) {
    await assert.rejects(
      membership._test.acceptInvite(MEMBER, 'CONSENT-CODE', legalConsent),
      (error) => error.code === 'LEGAL_CONSENT_REQUIRED',
    )
    await assert.rejects(
      membership._test.acceptLegalConsent(OWNER, legalConsent, '1'.repeat(32)),
      (error) => error.code === 'LEGAL_CONSENT_REQUIRED',
    )
    assert.deepStrictEqual(database.records('meal_members'), beforeMembers)
    assert.deepStrictEqual(database.records('meal_invites'), beforeInvites)
  }
}

async function existingMembersExplicitlyAcceptOnceForTheirOwnGeneration() {
  seed({}, { [MEMBER]: activeMember('member', 'b'.repeat(32), '2'.repeat(32)) })
  database.bucket('meal_members').set(CONTROL_ID, {
    ...CONTROL(), activeMemberCount: 2, inviteSlots: 3, inviteTtlHours: 168,
  })
  const initial = await membership._test.status(MEMBER)
  assert.strictEqual(initial.legalConsentVersion, LEGAL_CONSENT_VERSION)
  assert.strictEqual(initial.legalConsentAccepted, false)
  assert.strictEqual(database.record('meal_members', MEMBER).legalConsent, undefined)
  assert.strictEqual((await membership._test.status('unjoined-account')).legalConsentAccepted, false)
  assert.strictEqual((await membership._test.acceptInvite(MEMBER, 'UNUSED', CONSENT)).legalConsentAccepted, false)
  const ownerBefore = database.record('meal_members', OWNER)
  currentIdentity = MEMBER
  const accepted = await membership.main({
    action: 'acceptLegalConsent', legalConsent: CONSENT, cacheNamespace: '2'.repeat(32),
    openid: OWNER, OPENID: OWNER, role: 'owner', acceptedAt: 9999999999999,
  })
  assert.strictEqual(accepted.success, true)
  assert.strictEqual(accepted.data.legalConsentAccepted, true)
  assert.strictEqual(accepted.data.role, 'member')
  const after = database.record('meal_members', MEMBER)
  assert.deepStrictEqual(Object.keys(after.legalConsent).sort(), ['acceptedAt', 'version'])
  assert.strictEqual(after.legalConsent.version, LEGAL_CONSENT_VERSION)
  assert(after.legalConsent.acceptedAt > 1000 && after.legalConsent.acceptedAt < 9999999999999)
  assert.deepStrictEqual(database.record('meal_members', OWNER), ownerBefore)
  const controlAfter = database.record('meal_members', CONTROL_ID)
  await membership._test.acceptLegalConsent(MEMBER, CONSENT, '2'.repeat(32))
  assert.deepStrictEqual(database.record('meal_members', MEMBER), after, '重复同意必须保留首次服务器时间')
  assert.deepStrictEqual(database.record('meal_members', CONTROL_ID), controlAfter)
  for (const cacheNamespace of [undefined, '', 'invalid', '1'.repeat(32), '3'.repeat(32)]) {
    await assert.rejects(membership._test.acceptLegalConsent(MEMBER, CONSENT, cacheNamespace),
      (error) => error.code === 'ACCOUNT_GENERATION_CHANGED')
    assert.deepStrictEqual(database.record('meal_members', MEMBER), after)
  }
  await assert.rejects(membership._test.acceptLegalConsent('unjoined-account', CONSENT, '2'.repeat(32)),
    (error) => error.code === 'MEMBERSHIP_REQUIRED')
  currentIdentity = ''
  assert.strictEqual((await membership.main({
    action: 'acceptLegalConsent', legalConsent: CONSENT, cacheNamespace: '2'.repeat(32), OPENID: MEMBER,
  })).code, 'IDENTITY_REQUIRED')
  currentIdentity = OWNER
}

async function consentCannotArriveAfterDeletionOrGenerationChange() {
  for (const changed of [
    { status: 'deleting' }, { cacheNamespace: '9'.repeat(32) },
  ]) {
    seed({}, { [MEMBER]: activeMember('member', 'b'.repeat(32), '2'.repeat(32)) })
    database.beforeTransaction = async () => {
      database.beforeTransaction = null
      database.bucket('meal_members').set(MEMBER, { ...database.record('meal_members', MEMBER), ...changed })
    }
    await assert.rejects(membership._test.acceptLegalConsent(MEMBER, CONSENT, '2'.repeat(32)),
      (error) => error.code === (changed.status ? 'ACCOUNT_DELETION_IN_PROGRESS' : 'ACCOUNT_GENERATION_CHANGED'))
    assert.strictEqual(database.record('meal_members', MEMBER).legalConsent, undefined)
  }
  seed({}, { [MEMBER]: {
    ...activeMember('member', 'b'.repeat(32), '2'.repeat(32)), legalConsent: { version: 1, acceptedAt: 0 },
  } })
  assert.strictEqual((await membership._test.status(MEMBER)).legalConsentAccepted, false)
  assert.strictEqual((await membership._test.acceptLegalConsent(MEMBER, CONSENT, '2'.repeat(32))).legalConsentAccepted, true)
}

async function acceptedInvitationExposesOnlyDisplayRelationship() {
  seed()
  database.bucket('meal_members').set(CONTROL_ID, { ...CONTROL(), createdAt: 1 })
  database.bucket('meal_users').set(OWNER, { nickname: ' 邀请人的昵称 ', unionid: '<fixture-owner-identity>' })
  database.bucket('meal_users').set(MEMBER, {
    nickname: ' 受邀用户的昵称 ', avatarFileId: 'private-avatar-file', maskedPhone: '****9876',
    phoneNumber: 'private-phone', unionid: '<fixture-member-identity>', health: 'private-health',
  })
  const created = await membership._test.createInvite(OWNER, '家人备注')
  currentIdentity = MEMBER
  const joined = await membership.main({
    action: 'acceptInvite', code: created.code, legalConsent: CONSENT,
    role: 'owner', OPENID: OWNER, inviterMemberRef: 'f'.repeat(32), createdBy: 'forged-inviter',
  })
  assert.strictEqual(joined.success, true)
  assert.strictEqual(joined.data.role, 'member')
  assert.strictEqual(joined.data.legalConsentAccepted, true)
  const record = database.record('meal_members', MEMBER)
  assert.strictEqual(record.inviterMemberRef, 'a'.repeat(32))
  assert.strictEqual(record.joinSource, 'invite')
  assert.deepStrictEqual(Object.keys(record.legalConsent).sort(), ['acceptedAt', 'version'])
  const summary = await membership._test.listMembers(OWNER)
  assert.strictEqual(summary.count, 2)
  assert.deepStrictEqual(summary.activeInvites, [])
  const visible = summary.members.find((item) => item.memberRef === record.memberRef)
  assert.deepStrictEqual(visible, {
    memberRef: record.memberRef, role: 'member', label: '家人备注', joinedAt: record.joinedAt,
    displayName: '受邀用户的昵称', inviterLabel: '邀请人的昵称', invitationLabel: '家人备注', joinSource: 'invite',
    adminNote: '', adminNoteUpdatedAt: null,
    maskedPhone: '', phoneStatus: 'consent_required',
  })
  assert.strictEqual(summary.members.find((item) => item.role === 'owner').joinSource, 'owner')
  const serialized = JSON.stringify(summary)
  for (const forbidden of [
    OWNER, MEMBER, '<fixture-owner-identity>', 'private-avatar-file', '****9876', 'private-phone',
    '<fixture-member-identity>', 'private-health', created.code, hash(created.code), record.cacheNamespace,
  ]) assert.strictEqual(serialized.includes(forbidden), false, `不得返回私有值 ${forbidden}`)
  assert.strictEqual((await membership.main({ action: 'listMembers', role: 'owner', OPENID: OWNER })).code, 'OWNER_REQUIRED')

  await membership._test.transferOwner(OWNER, record.memberRef, true)
  const transferred = await membership._test.listMembers(MEMBER)
  const newOwner = transferred.members.find((item) => item.memberRef === record.memberRef)
  assert.strictEqual(newOwner.role, 'owner')
  assert.strictEqual(newOwner.joinSource, 'invite')
  assert.strictEqual(newOwner.inviterLabel, '邀请人的昵称')
  assert.strictEqual(database.record('meal_members', MEMBER).inviterMemberRef, 'a'.repeat(32))
  database.bucket('meal_members').delete(OWNER)
  database.bucket('meal_users').delete(OWNER)
  database.bucket('meal_invites').delete(created.inviteRef)
  database.bucket('meal_members').set(CONTROL_ID, { ...database.record('meal_members', CONTROL_ID), activeMemberCount: 1 })
  assert.strictEqual((await membership._test.listMembers(MEMBER)).members[0].inviterLabel, '原邀请人已退出')
  database.bucket('meal_members').set(OWNER, activeMember('member', 'c'.repeat(32), '3'.repeat(32)))
  database.bucket('meal_users').set(OWNER, { nickname: '同账号重新加入后的昵称' })
  database.bucket('meal_members').set(CONTROL_ID, { ...database.record('meal_members', CONTROL_ID), activeMemberCount: 2 })
  assert.strictEqual((await membership._test.listMembers(MEMBER)).members
    .find((item) => item.memberRef === record.memberRef).inviterLabel, '原邀请人已退出')
  currentIdentity = OWNER
}

async function legacyRelationshipsRequireEvidenceAndKeepUnknowns() {
  const inviteRef = 'e'.repeat(32)
  seed({ [inviteRef]: {
    ...invite('LEGACY-RELATION', Date.now() + 60000, '旧邀请备注'), active: false,
    createdBy: OWNER, createdAt: 2, usedBy: MEMBER, usedCount: 1,
  } }, { [MEMBER]: {
    ...activeMember('member', 'b'.repeat(32), '2'.repeat(32)), inviteId: inviteRef, joinedAt: 3,
  } })
  database.bucket('meal_members').set(CONTROL_ID, { ...CONTROL(), activeMemberCount: 2 })
  database.bucket('meal_users').set(OWNER, { nickname: '原邀请人的昵称' })
  let row = (await membership._test.listMembers(OWNER)).members.find((item) => item.role === 'member')
  assert.strictEqual(row.joinSource, 'invite')
  assert.strictEqual(row.inviterLabel, '原邀请人的昵称')
  assert.strictEqual(row.invitationLabel, '旧邀请备注')
  database.bucket('meal_members').set(OWNER, {
    ...activeMember('owner', 'c'.repeat(32), '3'.repeat(32)), joinedAt: 4,
  })
  row = (await membership._test.listMembers(OWNER)).members.find((item) => item.role === 'member')
  assert.strictEqual(row.inviterLabel, '原邀请人已退出', '旧邀请不能归给同账号的新代际')
  database.bucket('meal_invites').delete(inviteRef)
  row = (await membership._test.listMembers(OWNER)).members.find((item) => item.role === 'member')
  assert.strictEqual(row.joinSource, 'legacy')
  assert.strictEqual(row.inviterLabel, '邀请人信息未记录')
  assert.strictEqual(row.invitationLabel, '')
  assert.strictEqual((await membership._test.listMembers(OWNER)).members[0].joinSource, 'legacy',
    '当前管理员身份不能作为初始加入来源的证据')
}

async function memberListRechecksOwnerAndDeletionBeforeProjection() {
  for (const mutation of ['transfer', 'delete']) {
    seed({}, { [MEMBER]: {
      ...activeMember('member', 'b'.repeat(32), '2'.repeat(32)),
      adminNote: '即将退出成员的管理员私有备注', adminNoteUpdatedAt: 50,
    } })
    database.bucket('meal_members').set(CONTROL_ID, { ...CONTROL(), activeMemberCount: 2 })
    database.bucket('meal_users').set(MEMBER, { nickname: '即将退出的昵称' })
    let activeReads = 0
    database.beforeQueryGet = async ({ collectionName, criteria }) => {
      if (collectionName !== 'meal_members' || criteria.status !== 'active') return
      activeReads += 1
      if (activeReads !== 2) return
      database.beforeTransaction = async () => {
        database.beforeTransaction = null
        const control = database.record('meal_members', CONTROL_ID)
        if (mutation === 'transfer') {
          database.bucket('meal_members').set(OWNER, { ...database.record('meal_members', OWNER), role: 'member' })
          database.bucket('meal_members').set(MEMBER, { ...database.record('meal_members', MEMBER), role: 'owner' })
          database.bucket('meal_members').set(CONTROL_ID, { ...control, ownerOpenid: MEMBER })
        } else {
          database.bucket('meal_members').delete(MEMBER)
          database.bucket('meal_users').delete(MEMBER)
          database.bucket('meal_members').set(CONTROL_ID, { ...control, activeMemberCount: 1 })
        }
      }
    }
    if (mutation === 'transfer') {
      await assert.rejects(membership._test.listMembers(OWNER), (error) => error.code === 'OWNER_REQUIRED')
    } else {
      const summary = await membership._test.listMembers(OWNER)
      assert.strictEqual(summary.count, 1)
      assert.strictEqual(JSON.stringify(summary).includes('即将退出的昵称'), false)
      assert.strictEqual(JSON.stringify(summary).includes('即将退出成员的管理员私有备注'), false)
    }
  }
}

async function administratorNotesStaySeparateAndPrivate() {
  const memberRef = 'b'.repeat(32)
  const inviteRef = 'e'.repeat(32)
  seed({ [inviteRef]: {
    ...invite('ORIGINAL-INVITE', Date.now() + 60000, '原始邀请备注'), active: false,
    usedCount: 1, usedBy: MEMBER, createdBy: OWNER, createdAt: 2,
  } }, { [MEMBER]: {
    ...activeMember('member', memberRef, '2'.repeat(32)),
    inviteId: inviteRef, displayLabel: '原始邀请备注',
  } })
  database.bucket('meal_members').set(CONTROL_ID, {
    ...CONTROL(), activeMemberCount: 2, inviteSlots: 10, inviteTtlHours: 168,
  })
  seedPrivateCollections([OWNER, MEMBER])
  const beforeMember = database.record('meal_members', MEMBER)
  const beforeOwner = database.record('meal_members', OWNER)
  const beforeControl = database.record('meal_members', CONTROL_ID)
  const beforeInvites = database.records('meal_invites')
  const beforePrivate = privateCollectionSnapshot()
  currentIdentity = OWNER
  const response = await membership.main({
    action: 'setMemberNote', memberRef: memberRef.toUpperCase(), note: '  管理员私有备注🙂  ',
    openid: MEMBER, role: 'member', adminNoteUpdatedAt: 9999999999999,
  })
  assert.deepStrictEqual(response, { success: true, data: { updated: true, memberRef } })
  const stored = database.record('meal_members', MEMBER)
  assert.deepStrictEqual(stored, {
    ...beforeMember, adminNote: '管理员私有备注🙂', adminNoteUpdatedAt: stored.adminNoteUpdatedAt,
  }, '备注只允许增加自身字段及服务端时间，不改邀请备注、身份、加入时间或缓存代际')
  assert(stored.adminNoteUpdatedAt > 1000 && stored.adminNoteUpdatedAt < 9999999999999)
  assert.deepStrictEqual(database.record('meal_members', OWNER), beforeOwner)
  const { updatedAt, ...controlAfter } = database.record('meal_members', CONTROL_ID)
  assert(updatedAt > 0)
  assert.deepStrictEqual(controlAfter, { ...beforeControl, revision: beforeControl.revision + 1 })
  assert.deepStrictEqual(database.records('meal_invites'), beforeInvites)
  assert.deepStrictEqual(privateCollectionSnapshot(), beforePrivate)
  const visible = (await membership._test.listMembers(OWNER)).members.find((member) => member.memberRef === memberRef)
  assert.strictEqual(visible.adminNote, '管理员私有备注🙂')
  assert.strictEqual(visible.adminNoteUpdatedAt, stored.adminNoteUpdatedAt)
  assert.strictEqual(visible.invitationLabel, '原始邀请备注')

  currentIdentity = MEMBER
  for (const event of [
    { action: 'status' }, { action: 'acceptInvite', code: 'UNUSED', legalConsent: CONSENT },
  ]) {
    const result = await membership.main(event)
    assert.strictEqual(result.success, true)
    assert.strictEqual(JSON.stringify(result).includes('adminNote'), false)
    assert.strictEqual(JSON.stringify(result).includes('管理员私有备注🙂'), false)
  }
  for (const event of [
    { action: 'setMemberNote', memberRef, note: '伪造管理员身份' }, { action: 'listMembers' },
  ]) {
    const result = await membership.main({ ...event, OPENID: OWNER, openid: OWNER, role: 'owner' })
    assert.strictEqual(result.success, false)
    assert.strictEqual(result.code, 'OWNER_REQUIRED')
    assert.strictEqual(JSON.stringify(result).includes('adminNote'), false)
  }
  assert.deepStrictEqual(database.record('meal_members', MEMBER), stored)
  currentIdentity = OWNER
  await membership._test.setMemberNote(OWNER, memberRef, '🙂'.repeat(100))
  assert.strictEqual(database.record('meal_members', MEMBER).adminNote, '🙂'.repeat(100),
    '100 个 Unicode 字符包括补充平面字符应完整保存')
  assert.strictEqual((await membership._test.listMembers(OWNER)).members.find((member) => member.memberRef === memberRef).adminNote,
    '🙂'.repeat(100))
  await membership._test.setMemberNote(OWNER, memberRef, ' \n\t ')
  const cleared = database.record('meal_members', MEMBER)
  assert.strictEqual(cleared.adminNote, '')
  assert(cleared.adminNoteUpdatedAt > stored.adminNoteUpdatedAt)
  assert.strictEqual(cleared.displayLabel, '原始邀请备注')
  await membership._test.setMemberNote(OWNER, 'a'.repeat(32), '管理员自身备注')
  assert.strictEqual(JSON.stringify(await membership._test.status(OWNER)).includes('adminNote'), false)
  assert.strictEqual(JSON.stringify(await membership._test.status(OWNER)).includes('管理员自身备注'), false)
  assert.deepStrictEqual(privateCollectionSnapshot(), beforePrivate)
}

async function invalidMemberNotesCannotWrite() {
  const memberRef = 'b'.repeat(32)
  seed({}, { [MEMBER]: {
    ...activeMember('member', memberRef, '2'.repeat(32)), adminNote: '原有备注', adminNoteUpdatedAt: 10,
  } })
  database.bucket('meal_members').set(CONTROL_ID, {
    ...CONTROL(), activeMemberCount: 2, inviteSlots: 10, inviteTtlHours: 168,
  })
  const before = database.records('meal_members')
  for (const invalid of [undefined, null, 123, true, {}, [], '字'.repeat(101), '🙂'.repeat(101)]) {
    await assert.rejects(membership._test.setMemberNote(OWNER, memberRef, invalid),
      (error) => error.code === 'MEMBER_NOTE_INVALID')
    assert.deepStrictEqual(database.records('meal_members'), before)
  }
  for (const invalid of [undefined, null, 123, '', 'not-a-reference', `${memberRef}0`]) {
    await assert.rejects(membership._test.setMemberNote(OWNER, invalid, '不应写入'),
      (error) => error.code === 'MEMBER_REFERENCE_INVALID')
    assert.deepStrictEqual(database.records('meal_members'), before)
  }
  await assert.rejects(membership._test.setMemberNote(OWNER, 'f'.repeat(32), '不存在的成员'),
    (error) => error.code === 'MEMBER_NOT_FOUND')
  assert.deepStrictEqual(database.records('meal_members'), before)
  database.bucket('meal_members').set('duplicate-member', activeMember('member', memberRef, '3'.repeat(32)))
  const duplicateBefore = database.records('meal_members')
  await assert.rejects(membership._test.setMemberNote(OWNER, memberRef, '重复引用不可写'),
    (error) => error.code === 'MEMBER_NOT_FOUND')
  assert.deepStrictEqual(database.records('meal_members'), duplicateBefore)
}

async function onlyCurrentOwnerCanReadAndWriteMemberNotes() {
  const targetRef = 'c'.repeat(32)
  seed({}, {
    [MEMBER]: activeMember('member', 'b'.repeat(32), '2'.repeat(32)),
    'note-target': activeMember('member', targetRef, '3'.repeat(32)),
  })
  database.bucket('meal_members').set(CONTROL_ID, {
    ...CONTROL(), activeMemberCount: 3, inviteSlots: 10, inviteTtlHours: 168,
  })
  await membership._test.setMemberNote(OWNER, targetRef, '交接前备注')
  await membership._test.transferOwner(OWNER, 'b'.repeat(32), true)
  await assert.rejects(membership._test.setMemberNote(OWNER, targetRef, '旧管理员不得覆盖'),
    (error) => error.code === 'OWNER_REQUIRED')
  await assert.rejects(membership._test.listMembers(OWNER), (error) => error.code === 'OWNER_REQUIRED')
  assert.strictEqual((await membership._test.listMembers(MEMBER)).members.find((member) => member.memberRef === targetRef).adminNote,
    '交接前备注')
  await membership._test.setMemberNote(MEMBER, targetRef, '新管理员备注')
  assert.strictEqual(database.record('meal_members', 'note-target').adminNote, '新管理员备注')
  assert.strictEqual(JSON.stringify(await membership._test.status('note-target')).includes('adminNote'), false)
}

async function memberNoteWritesRecheckOwnerAndTargetInsideTransaction() {
  const targetRef = 'c'.repeat(32)
  for (const mutation of ['owner-transfer', 'owner-control', 'owner-deleting', 'target-delete', 'target-deleting', 'target-generation']) {
    seed({}, {
      [MEMBER]: activeMember('member', 'b'.repeat(32), '2'.repeat(32)),
      'note-target': {
        ...activeMember('member', targetRef, '3'.repeat(32)), adminNote: '不得被覆盖', adminNoteUpdatedAt: 10,
      },
    })
    database.bucket('meal_members').set(CONTROL_ID, {
      ...CONTROL(), activeMemberCount: 3, inviteSlots: 10, inviteTtlHours: 168,
    })
    database.beforeTransaction = async () => {
      database.beforeTransaction = null
      const control = database.record('meal_members', CONTROL_ID)
      if (mutation.startsWith('owner-')) {
        database.bucket('meal_members').set(CONTROL_ID, { ...control, ownerOpenid: MEMBER })
        if (mutation === 'owner-transfer') {
          database.bucket('meal_members').set(OWNER, { ...database.record('meal_members', OWNER), role: 'member' })
          database.bucket('meal_members').set(MEMBER, { ...database.record('meal_members', MEMBER), role: 'owner' })
        } else if (mutation === 'owner-deleting') {
          database.bucket('meal_members').set(OWNER, { ...database.record('meal_members', OWNER), status: 'deleting' })
        }
      } else if (mutation === 'target-delete') {
        database.bucket('meal_members').delete('note-target')
      } else {
        database.bucket('meal_members').set('note-target', {
          ...database.record('meal_members', 'note-target'),
          ...(mutation === 'target-deleting' ? { status: 'deleting' } : { memberRef: 'd'.repeat(32), cacheNamespace: '4'.repeat(32) }),
        })
      }
    }
    await assert.rejects(membership._test.setMemberNote(OWNER, targetRef, '竞态中的过期写入'),
      (error) => error.code === (mutation.startsWith('owner-') ? 'OWNER_REQUIRED' : 'MEMBER_NOT_FOUND'))
    const target = database.record('meal_members', 'note-target')
    assert.strictEqual(target && target.adminNote, mutation === 'target-delete' ? undefined : '不得被覆盖')
    assert.strictEqual(target && target.adminNoteUpdatedAt, mutation === 'target-delete' ? undefined : 10)
    assert.strictEqual(database.record('meal_members', CONTROL_ID).revision, 1)
  }
}

async function maskedPhonesRequireCurrentConsentAndOwner() {
  seed({}, { [MEMBER]: {
    ...activeMember('member', 'b'.repeat(32), '2'.repeat(32)),
    legalConsent: { version: 1, acceptedAt: 10 },
  } })
  database.bucket('meal_members').set(CONTROL_ID, {
    ...CONTROL(), activeMemberCount: 2, inviteSlots: 10, inviteTtlHours: 168,
  })
  database.bucket('meal_users').set(MEMBER, { phoneBound: true, maskedPhone: '****1234', phoneNumber: 'never-return-raw-phone' })
  const beforeProfile = clone(database.record('meal_users', MEMBER))
  const row = async () => (await membership._test.listMembers(OWNER)).members.find(item => item.role === 'member')
  await membership._test.acceptLegalConsent(OWNER, CONSENT, '1'.repeat(32))
  assert.strictEqual((await row()).phoneStatus, 'consent_required')
  assert.strictEqual((await row()).maskedPhone, '', '旧版同意不能被当作尾号展示许可')
  await membership._test.acceptLegalConsent(MEMBER, CONSENT, '2'.repeat(32))
  assert.strictEqual((await row()).maskedPhone, '****1234')
  assert.strictEqual((await row()).phoneStatus, 'available')
  assert.deepStrictEqual(database.record('meal_users', MEMBER), beforeProfile, '确认新版说明及读取不能改写个人档案')
  assert(!JSON.stringify(await row()).includes('never-return-raw-phone'))
  currentIdentity = MEMBER
  const denied = await membership.main({ action: 'listMembers', OPENID: OWNER, role: 'owner' })
  assert.strictEqual(denied.code, 'OWNER_REQUIRED')
  assert(!JSON.stringify(denied).includes('1234'))
  currentIdentity = OWNER
  for (const invalid of [null, 1234, ['****1234'], '12345678901', '****12345', '****1234\n', ' ****1234', '****１２３４']) {
    database.bucket('meal_users').set(MEMBER, { phoneBound: true, maskedPhone: invalid })
    assert.strictEqual((await row()).maskedPhone, '')
    assert.strictEqual((await row()).phoneStatus, 'unavailable', '异常值不能退回原值或截取完整号码')
  }
  for (const profile of [{}, { phoneBound: false, maskedPhone: '****1234' }, { phoneBound: 'true', maskedPhone: '****1234' }]) {
    database.bucket('meal_users').set(MEMBER, profile)
    assert.strictEqual((await row()).phoneStatus, 'unbound')
    assert.strictEqual((await row()).maskedPhone, '')
  }
  database.bucket('meal_users').delete(MEMBER)
  assert.strictEqual((await row()).phoneStatus, 'unbound')
  database.bucket('meal_users').set(MEMBER, beforeProfile)
  database.bucket('meal_members').set(OWNER, { ...database.record('meal_members', OWNER), legalConsent: { version: 1, acceptedAt: 10 } })
  assert.strictEqual((await row()).maskedPhone, '', '旧版管理员不能在未确认本版说明时获取尾号')
  await membership._test.acceptLegalConsent(OWNER, CONSENT, '1'.repeat(32))
  database.beforeTransaction = async () => {
    database.beforeTransaction = null
    database.bucket('meal_members').set(MEMBER, { ...database.record('meal_members', MEMBER), legalConsent: { version: 1, acceptedAt: 10 } })
  }
  assert.strictEqual((await row()).maskedPhone, '', '同意状态必须在读取事务内重新核验')
  await membership._test.acceptLegalConsent(MEMBER, CONSENT, '2'.repeat(32))
  await membership._test.transferOwner(OWNER, 'b'.repeat(32), true)
  await assert.rejects(membership._test.listMembers(OWNER), { code: 'OWNER_REQUIRED' })
  assert.strictEqual((await membership._test.listMembers(MEMBER)).members.find(item => item.role === 'owner').maskedPhone, '****1234')
}

async function run() {
  assertStrictNotFoundClassification()
  assertFixedPublicErrors()
  assert.strictEqual(membership._test.inviteExpired(100, 100), true)
  assert.strictEqual(membership._test.inviteExpired(101, 100), false)
  await twoAccountsCannotConsumeOneInvite()
  await oneAccountCannotConsumeTwoInvites()
  await exactExpiryIsRejected()
  await createdInviteUsesStrongOneTimeCode()
  await createListRevokeListLifecycle()
  await legacyTenCharacterInviteStillCreatesOnlyMember()
  await listMembersReturnsOnlySafeActiveInvites()
  await revokeInviteIsAuthorizedAndIdempotent()
  await usedInviteDoesNotReleaseTwice()
  await redeemAndRevokeAreSerialized()
  await transferAndInviteCreationKeepOneOwner()
  await memberCannotUseManagementActions()
  await bootstrapSentinelBlocksEveryMembershipWrite()
  await legacyControlUpgradesWithoutLosingCounts()
  await capacityExpansionPreservesV020RecordsAndInvites()
  await tenInvitedMembersFillElevenTotalSeats()
  await concurrentRequestsCannotOverbookLastSeat()
  await overCapacityActiveMembersRemainUsableAndUntouched()
  await migrationRevokesAllInvitesWhenActiveCapacityIsFull()
  await concurrentEntrancesRevokeOnlyExcessInvites()
  await deletingIdentityReceivesOnlyItsRecoveryHandle()
  await missingOrInvalidConsentCannotWrite()
  await existingMembersExplicitlyAcceptOnceForTheirOwnGeneration()
  await consentCannotArriveAfterDeletionOrGenerationChange()
  await acceptedInvitationExposesOnlyDisplayRelationship()
  await legacyRelationshipsRequireEvidenceAndKeepUnknowns()
  await memberListRechecksOwnerAndDeletionBeforeProjection()
  await administratorNotesStaySeparateAndPrivate()
  await invalidMemberNotesCannotWrite()
  await onlyCurrentOwnerCanReadAndWriteMemberNotes()
  await memberNoteWritesRecheckOwnerAndTargetInsideTransaction()
  await maskedPhonesRequireCurrentConsentAndOwner()
  console.log('membership transaction entry tests passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
