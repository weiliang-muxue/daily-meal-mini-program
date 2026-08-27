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
}

const database = new MemoryDatabase()
const fakeCloud = {
  DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => database,
  getWXContext: () => ({ OPENID: 'member' }),
  deleteFile: async ({ fileList }) => ({ fileList: fileList.map((fileID) => ({ fileID, status: 0 })) }),
  uploadFile: async () => ({ fileID: 'cloud://test/placeholder' }),
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
const member = (role = 'member', status = 'active') => ({ status, role, joinedAt: 1, updatedAt: 1 })

async function memberDeletionUsesControl() {
  database.reset({ meal_members: {
    [CONTROL_ID]: activeControl(), owner: member('owner'), member: member(),
  } })
  await privacy._test.prepareMembershipDeletion('member')
  assert.strictEqual(database.record('meal_members', 'member').status, 'deleting')
  assert.strictEqual(database.record('meal_members', CONTROL_ID).activeMemberCount, 1)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).revision, 11)
  await privacy._test.removeMembershipDocument('member')
  assert.strictEqual(database.record('meal_members', 'member'), undefined)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).revision, 12)
}

async function inactiveMemberMarkUsesControl() {
  database.reset({ meal_members: {
    [CONTROL_ID]: activeControl({ activeMemberCount: 1 }), owner: member('owner'), disabled: member('member', 'disabled'),
  } })
  await privacy._test.prepareMembershipDeletion('disabled')
  assert.strictEqual(database.record('meal_members', 'disabled').status, 'deleting')
  assert.strictEqual(database.record('meal_members', CONTROL_ID).activeMemberCount, 1)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).revision, 11)
}

async function inviteWritesUseControl() {
  database.reset({
    meal_members: { [CONTROL_ID]: activeControl({ activeMemberCount: 1, reservedInviteCount: 1 }), owner: member('owner') },
    meal_invites: { invite: { active: true, createdBy: 'owner', usedCount: 0, maxUses: 1 } },
  })
  assert.strictEqual(await privacy._test.deactivateOwnedInvite('invite', 'owner'), true)
  assert.strictEqual(database.record('meal_invites', 'invite').active, false)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).reservedInviteCount, 0)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).revision, 11)
  assert.strictEqual(await privacy._test.removeRelatedInvite('invite', 'owner'), true)
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
      privacy._test.prepareMembershipDeletion('owner'),
      (error) => error.code === 'MEMBERSHIP_BOOTSTRAP_IN_PROGRESS',
    )
    await assert.rejects(
      privacy._test.deactivateOwnedInvite('invite', 'owner'),
      (error) => error.code === 'MEMBERSHIP_BOOTSTRAP_IN_PROGRESS',
    )
    await assert.rejects(
      privacy._test.removeRelatedInvite('invite', 'owner'),
      (error) => error.code === 'MEMBERSHIP_BOOTSTRAP_IN_PROGRESS',
    )
    await assert.rejects(
      privacy._test.removeMembershipDocument('deleting'),
      (error) => error.code === 'MEMBERSHIP_BOOTSTRAP_IN_PROGRESS',
    )
    assert.deepStrictEqual(database.record('meal_members', CONTROL_ID), sentinel)
    assert.strictEqual(database.record('meal_invites', 'invite').active, true)
  }
}

async function run() {
  assertStrictNotFoundClassification()
  assertFixedPublicErrors()
  const source = fs.readFileSync(path.resolve(__dirname, 'index.js'), 'utf8')
  assert(!/removeDocument\(['"]meal_members['"]/.test(source), '成员物理删除不能绕过 control 事务')
  assert(!/removeDocuments\(['"]meal_invites['"]/.test(source), '邀请码物理删除不能绕过 control 事务')
  await memberDeletionUsesControl()
  await inactiveMemberMarkUsesControl()
  await inviteWritesUseControl()
  await bootstrapSentinelBlocksEveryPrivacyMembershipWrite()
  console.log('privacy membership control entry tests passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
