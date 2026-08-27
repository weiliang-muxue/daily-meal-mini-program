'use strict'

const assert = require('assert')
const crypto = require('crypto')
const Module = require('module')
const path = require('path')
const { CONTROL_ID } = require('./core')

const OWNER = 'owner-account'
const MEMBER = 'member-account'
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

async function twoAccountsCannotConsumeOneInvite() {
  const now = Date.now()
  seed({ invitation: invite('CODE-A', now + 60000, '家人') })
  database.bucket('meal_members').set(CONTROL_ID, { ...CONTROL(), reservedInviteCount: 1 })
  const results = await Promise.allSettled([
    membership._test.acceptInvite('account-a', 'CODE-A'),
    membership._test.acceptInvite('account-b', 'CODE-A'),
  ])
  assert.strictEqual(results.filter((item) => item.status === 'fulfilled').length, 1)
  assert.strictEqual(results.filter((item) => item.status === 'rejected').length, 1)
  const joined = ['account-a', 'account-b'].map((id) => database.record('meal_members', id)).filter(Boolean)
  assert.strictEqual(joined.length, 1)
  assert.strictEqual(joined[0].role, 'member', '邀请码永远只能产生普通成员')
  assert.strictEqual(database.record('meal_members', CONTROL_ID).activeMemberCount, 2)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).reservedInviteCount, 0)
  assert.strictEqual(database.record('meal_invites', 'invitation').active, false)
}

async function oneAccountCannotConsumeTwoInvites() {
  const now = Date.now()
  seed({ first: invite('CODE-B', now + 60000), second: invite('CODE-C', now + 60000) })
  database.bucket('meal_members').set(CONTROL_ID, { ...CONTROL(), reservedInviteCount: 2 })
  const results = await Promise.allSettled([
    membership._test.acceptInvite('same-account', 'CODE-B'),
    membership._test.acceptInvite('same-account', 'CODE-C'),
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
      membership._test.acceptInvite('late-account', 'CODE-D'),
      (error) => error.code === 'INVITE_INVALID',
    )
    assert.strictEqual(database.record('meal_members', 'late-account'), undefined)
    assert.strictEqual(database.record('meal_invites', 'expired').active, false)
    assert.strictEqual(database.record('meal_members', CONTROL_ID).reservedInviteCount, 0)
  } finally { Date.now = originalNow }
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
      membership._test.acceptInvite('new-account', 'NO-CODE'),
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
}

async function run() {
  assertStrictNotFoundClassification()
  assertFixedPublicErrors()
  assert.strictEqual(membership._test.inviteExpired(100, 100), true)
  assert.strictEqual(membership._test.inviteExpired(101, 100), false)
  await twoAccountsCannotConsumeOneInvite()
  await oneAccountCannotConsumeTwoInvites()
  await exactExpiryIsRejected()
  await transferAndInviteCreationKeepOneOwner()
  await memberCannotUseManagementActions()
  await bootstrapSentinelBlocksEveryMembershipWrite()
  await legacyControlUpgradesWithoutLosingCounts()
  console.log('membership transaction entry tests passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
