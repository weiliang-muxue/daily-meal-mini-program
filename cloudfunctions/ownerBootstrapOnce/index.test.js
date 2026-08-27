'use strict'

const assert = require('assert')
const Module = require('module')
const path = require('path')
const { CONTROL_ID, REQUEST_DOCUMENT_ID } = require('./core')

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) }

class MemoryDatabase {
  constructor() { this.reset() }
  reset() {
    this.docs = new Map()
    this.tail = Promise.resolve()
    this.clock = 1000
    this.transactionReadInFlight = false
    this.afterLegacyPreflight = null
    this.afterSnapshotAudit = null
    this.nextTransactionError = null
    this.optimisticTransactions = false
    this.versions = new Map()
    this.commitTail = Promise.resolve()
    this.controlReadBarrier = null
    this.beforeOptimisticCommit = null
    this.transactionConflicts = 0
  }
  bucket(name, source = this.docs) {
    if (!source.has(name)) source.set(name, new Map())
    return source.get(name)
  }
  collection(name, source = null, metadata = null) {
    const database = this
    const resolve = () => source || database.docs
    return {
      doc(id) { return database.document(name, id, resolve, source !== null, metadata) },
      limit(maximum) { return database.query(name, resolve, maximum) },
    }
  }
  document(name, id, resolve, transactional, metadata) {
    const database = this
    const key = `${name}\0${id}`
    const markWrite = () => { if (metadata) metadata.writes.add(key) }
    return {
      async get() {
        if (metadata) metadata.reads.add(key)
        if (metadata && name === 'meal_members' && id === CONTROL_ID && database.controlReadBarrier) {
          await database.controlReadBarrier(metadata.attempt)
        }
        if (transactional && !metadata && database.transactionReadInFlight) {
          throw new Error('Concurrent transaction reads are not supported')
        }
        if (transactional && !metadata) database.transactionReadInFlight = true
        await Promise.resolve()
        try {
          const value = database.bucket(name, resolve()).get(id)
          if (value === undefined) {
            const error = new Error(`document.get:fail document with _id ${id} does not exist`)
            error.errCode = -1
            error.errMsg = error.message
            throw error
          }
          return { data: clone(value) }
        } finally {
          if (transactional && !metadata) database.transactionReadInFlight = false
        }
      },
      async set({ data }) { markWrite(); database.bucket(name, resolve()).set(id, clone(data)) },
      async update({ data }) {
        markWrite()
        const bucket = database.bucket(name, resolve())
        if (!bucket.has(id)) throw new Error('DATABASE_DOCUMENT_NOT_FOUND')
        bucket.set(id, { ...clone(bucket.get(id)), ...clone(data) })
      },
      async remove() { markWrite(); database.bucket(name, resolve()).delete(id) },
    }
  }
  query(name, resolve, maximum) {
    const database = this
    return { async get() {
      return { data: [...database.bucket(name, resolve()).entries()].slice(0, maximum).map(([id, value]) => ({ _id: id, ...clone(value) })) }
    } }
  }
  async runTransaction(callback) {
    if (this.afterSnapshotAudit || this.afterLegacyPreflight) {
      const mutation = this.afterSnapshotAudit || this.afterLegacyPreflight
      this.afterSnapshotAudit = null
      this.afterLegacyPreflight = null
      await mutation(this)
    }
    if (this.optimisticTransactions) return this.runOptimisticTransaction(callback)
    const run = this.tail.then(async () => {
      if (this.nextTransactionError) {
        const error = this.nextTransactionError
        this.nextTransactionError = null
        throw error
      }
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
  async runOptimisticTransaction(callback, attempt = 0) {
    const draft = new Map([...this.docs.entries()].map(([name, records]) => [
      name, new Map([...records.entries()].map(([id, value]) => [id, clone(value)])),
    ]))
    const metadata = { attempt, reads: new Set(), writes: new Set(), baseVersions: new Map(this.versions) }
    const result = await callback({ collection: (name) => this.collection(name, draft, metadata) })
    if (this.beforeOptimisticCommit) await this.beforeOptimisticCommit(metadata)
    const commit = this.commitTail.then(() => {
      const checked = new Set([...metadata.reads, ...metadata.writes])
      for (const key of checked) {
        if ((this.versions.get(key) || 0) !== (metadata.baseVersions.get(key) || 0)) {
          const error = new Error('transaction document version conflict')
          error.code = 'TRANSACTION_CONFLICT'
          throw error
        }
      }
      for (const key of metadata.writes) {
        const separator = key.indexOf('\0')
        const name = key.slice(0, separator)
        const id = key.slice(separator + 1)
        const draftBucket = this.bucket(name, draft)
        if (draftBucket.has(id)) this.bucket(name).set(id, clone(draftBucket.get(id)))
        else this.bucket(name).delete(id)
        this.versions.set(key, (this.versions.get(key) || 0) + 1)
      }
      return result
    })
    this.commitTail = commit.catch(() => {})
    try { return await commit }
    catch (error) {
      if (error && error.code === 'TRANSACTION_CONFLICT' && attempt < 3) {
        this.transactionConflicts += 1
        return this.runOptimisticTransaction(callback, attempt + 1)
      }
      throw error
    }
  }
  serverDate() { this.clock += 1; return this.clock }
  record(name, id) { return clone(this.bucket(name).get(id)) }
}

const database = new MemoryDatabase()
let context = { OPENID: 'target-owner', SOURCE: 'wx_client' }
let currentNow = null
const originalDateNow = Date.now
Date.now = () => currentNow === null ? originalDateNow() : currentNow
const fakeCloud = {
  DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => database,
  getWXContext: () => context,
}
const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'wx-server-sdk') return fakeCloud
  return originalLoad.call(this, request, parent, isMain)
}
const modulePath = path.resolve(__dirname, 'index.js')
delete require.cache[modulePath]
const bootstrap = require(modulePath)
Module._load = originalLoad

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function optionalDocument(reference) {
  try { return (await reference.get()).data || null }
  catch (error) {
    if (error && error.errCode === -1 && /document with _id .+ does not exist/.test(error.message)) return null
    throw error
  }
}

function legalMembershipWrite(memberId) {
  return database.runTransaction(async (transaction) => {
    const controlReference = transaction.collection('meal_members').doc(CONTROL_ID)
    const memberReference = transaction.collection('meal_members').doc(memberId)
    const control = await optionalDocument(controlReference)
    if (control && ['bootstrap_pending', 'bootstrap_approved'].includes(control.phase)) {
      const error = new Error('bootstrap phase blocks business writes')
      error.code = 'MEMBERSHIP_BOOTSTRAP_IN_PROGRESS'
      throw error
    }
    if (control) {
      const error = new Error('membership control is already occupied')
      error.code = 'MEMBERSHIP_INVARIANT_FAILED'
      throw error
    }
    if (await optionalDocument(memberReference)) {
      const error = new Error('member already exists')
      error.code = 'MEMBERSHIP_INVARIANT_FAILED'
      throw error
    }
    await memberReference.set({ data: { status: 'active', role: 'owner' } })
    await controlReference.set({ data: {
      kind: 'control', status: 'control', schemaVersion: 2,
      phase: 'active', bootstrapRequestId: '', ownerOpenid: memberId,
      activeMemberCount: 1, reservedInviteCount: 0, revision: 1,
    } })
    return { state: 'business-written' }
  })
}

async function assertAuditRace(winner) {
  database.reset()
  database.optimisticTransactions = true
  const auditComplete = deferred()
  const startSentinelTransaction = deferred()
  database.afterSnapshotAudit = async () => {
    auditComplete.resolve()
    await startSentinelTransaction.promise
  }

  const gates = { sentinel: deferred(), business: deferred() }
  const bothReady = deferred()
  const ready = new Set()
  const controlKey = `meal_members\0${CONTROL_ID}`
  const controlVersions = []
  database.beforeOptimisticCommit = async (metadata) => {
    if (metadata.attempt > 0) return
    assert(metadata.reads.has(controlKey), 'each contender must read the fixed control document')
    assert(metadata.writes.has(controlKey), 'each contender must write the fixed control document')
    const kind = metadata.writes.has(`meal_members\0${REQUEST_DOCUMENT_ID}`) ? 'sentinel' : 'business'
    controlVersions.push(metadata.baseVersions.get(controlKey) || 0)
    ready.add(kind)
    if (ready.size === 2) bothReady.resolve()
    await gates[kind].promise
  }

  const sentinel = bootstrap._test.createRequest('bootstrap-owner')
  await auditComplete.promise
  const business = legalMembershipWrite('business-owner')
  startSentinelTransaction.resolve()
  await bothReady.promise
  assert.deepStrictEqual(controlVersions, [0, 0], 'both transactions must start from the same control version')

  if (winner === 'business') {
    gates.business.resolve()
    assert.deepStrictEqual(await business, { state: 'business-written' })
    gates.sentinel.resolve()
    await assert.rejects(sentinel, (error) => error.code === 'OWNER_ALREADY_INITIALIZED')
    assert.strictEqual(database.record('meal_members', CONTROL_ID).phase, 'active')
    assert.strictEqual(database.record('meal_members', 'business-owner').role, 'owner')
    assert.strictEqual(database.record('meal_members', REQUEST_DOCUMENT_ID), undefined)
  } else {
    gates.sentinel.resolve()
    assert.strictEqual((await sentinel).state, 'pending')
    gates.business.resolve()
    await assert.rejects(business, (error) => error.code === 'MEMBERSHIP_BOOTSTRAP_IN_PROGRESS')
    assert.strictEqual(database.record('meal_members', CONTROL_ID).phase, 'bootstrap_pending')
    assert(database.record('meal_members', REQUEST_DOCUMENT_ID))
    assert.strictEqual(database.record('meal_members', 'business-owner'), undefined)
  }
  assert.strictEqual(database.transactionConflicts, 1, 'loser must retry after a document snapshot conflict')
  database.beforeOptimisticCommit = null
  database.optimisticTransactions = false
}

assert.strictEqual(bootstrap._test.notFound({
  errCode: -1,
  message: 'document.get:fail document with _id missing-record does not exist',
  errMsg: 'document.get:fail document with _id missing-record does not exist',
}), true)
assert.strictEqual(bootstrap._test.notFound({
  errCode: -502005,
  message: 'document.get:fail document with _id misleading-record does not exist',
  errMsg: 'database collection not exists',
}), false)
assert.strictEqual(bootstrap._test.notFound({
  code: -502005,
  message: 'document.get:fail document with _id misleading-record does not exist',
}), false)
assert.strictEqual(bootstrap._test.notFound({
  code: 'PERMISSION_DENIED',
  errMsg: 'document.get:fail document with _id misleading-record does not exist',
}), false)
assert.strictEqual(bootstrap._test.notFound({
  errCode: -1,
  message: 'document.get:fail document with _id hidden-record does not exist',
  errMsg: 'network timeout',
}), false)
assert.strictEqual(bootstrap._test.notFound({
  errCode: -1,
  message: 'document.get:fail document with _id sdk-record does not exist',
  errMsg: 'document.get:fail document with _id sdk-record does not exist',
}), true)
assert.strictEqual(bootstrap._test.notFound({
  code: 'DATABASE_DOCUMENT_NOT_FOUND',
  message: 'permission denied',
}), false)
assert.strictEqual(bootstrap._test.notFound({
  code: 'DATABASE_DOCUMENT_NOT_FOUND',
}), true)

assert.strictEqual(
  bootstrap._test.stageError,
  undefined,
  'Operational stage wrapping must remain internal to the cloud entry.',
)

async function run() {
  await assertAuditRace('business')
  await assertAuditRace('sentinel')

  database.reset()
  database.optimisticTransactions = true
  let firstReads = 0
  let releaseControlReads
  const bothReadControl = new Promise((resolve) => { releaseControlReads = resolve })
  database.controlReadBarrier = async (attempt) => {
    if (attempt > 0) return
    firstReads += 1
    if (firstReads === 2) releaseControlReads()
    await bothReadControl
  }
  const contenders = await Promise.all([
    bootstrap._test.createRequest('owner-a'),
    bootstrap._test.createRequest('owner-b').then(
      (value) => value,
      (error) => ({ error }),
    ),
  ])
  database.controlReadBarrier = null
  database.optimisticTransactions = false
  assert.strictEqual(contenders.filter((item) => item && !item.error).length, 1)
  assert.strictEqual(contenders.filter((item) => item && item.error).length, 1)
  assert.strictEqual(contenders.find((item) => item && item.error).error.code, 'BOOTSTRAP_REQUEST_PENDING')
  const winningRequest = database.record('meal_members', REQUEST_DOCUMENT_ID)
  const winningControl = database.record('meal_members', CONTROL_ID)
  assert.strictEqual(winningControl.phase, 'bootstrap_pending')
  assert.strictEqual(winningControl.bootstrapRequestId, winningRequest.requestId)
  assert.strictEqual(database.record('meal_members', 'owner-a'), undefined)
  assert.strictEqual(database.record('meal_members', 'owner-b'), undefined)

  database.reset()
  const requestStart = originalDateNow() + 60 * 1000
  currentNow = requestStart
  database.afterSnapshotAudit = async () => { currentNow = requestStart + 5000 }
  const requested = await bootstrap.main({ action: 'request' })
  currentNow = null
  assert.strictEqual(database.afterSnapshotAudit, null, 'request time must be read inside the transaction')
  assert.deepStrictEqual(Object.keys(requested).sort(), ['data', 'success'])
  assert.deepStrictEqual(Object.keys(requested.data).sort(), ['expiresAtMs', 'state'])
  assert.strictEqual(requested.success, true)
  assert.strictEqual(requested.data.state, 'pending')
  const stored = database.record('meal_members', REQUEST_DOCUMENT_ID)
  const pendingControl = database.record('meal_members', CONTROL_ID)
  assert.strictEqual(pendingControl.phase, 'bootstrap_pending')
  assert.strictEqual(pendingControl.bootstrapRequestId, stored.requestId)
  assert.strictEqual(pendingControl.revision, 1)
  assert.strictEqual(stored.expiresAtMs, requestStart + 5000 + 30 * 60 * 1000)
  assert.strictEqual(stored.targetOpenid, 'target-owner')
  assert.strictEqual(JSON.stringify(requested).includes('target-owner'), false)
  assert.strictEqual(JSON.stringify(requested).includes(stored.requestId), false)
  assert.strictEqual(JSON.stringify(requested).includes(stored.approvalDigest), false)

  const clientApproval = await bootstrap.main({ action: 'approve' })
  assert.strictEqual(clientApproval.success, false)
  assert.strictEqual(clientApproval.code, 'BOOTSTRAP_CLIENT_DENIED')

  const clientActivation = await bootstrap.main({ action: 'activate' })
  assert.deepStrictEqual(clientActivation.success, false)
  assert.strictEqual(clientActivation.code, 'BOOTSTRAP_CLIENT_DENIED')
  assert.strictEqual(database.record('meal_members', CONTROL_ID).phase, 'bootstrap_pending')

  context = {}
  const unapproved = await bootstrap.main({ action: 'activate' })
  assert.strictEqual(unapproved.code, 'BOOTSTRAP_REQUEST_NOT_APPROVED')

  database.bucket('meal_members').set(REQUEST_DOCUMENT_ID, {
    ...stored, expiresAtMs: Date.now() - 1,
  })
  const expiredApproval = await bootstrap.main({ action: 'approve' })
  assert.strictEqual(expiredApproval.success, false)
  assert.strictEqual(expiredApproval.code, 'BOOTSTRAP_REQUEST_EXPIRED')
  const expiredActivation = await bootstrap.main({ action: 'activate' })
  assert.strictEqual(expiredActivation.success, false)
  assert.strictEqual(expiredActivation.code, 'BOOTSTRAP_REQUEST_EXPIRED')

  database.bucket('meal_members').set(REQUEST_DOCUMENT_ID, {
    ...stored, expiresAtMs: Date.now() + 60 * 1000,
  })
  const approved = await bootstrap.main({ action: 'approve', requestId: 'f'.repeat(32) })
  assert.deepStrictEqual(approved, { success: true, data: { state: 'approved' } })
  const approvedRecord = database.record('meal_members', REQUEST_DOCUMENT_ID)
  const approvedControl = database.record('meal_members', CONTROL_ID)
  assert.strictEqual(approvedControl.phase, 'bootstrap_approved')
  assert.strictEqual(approvedControl.bootstrapRequestId, stored.requestId)
  assert.strictEqual(approvedControl.revision, 2)
  assert.strictEqual(approvedRecord.status, 'approved')
  assert.strictEqual(approvedRecord.approvedRequestId, stored.requestId)
  assert.strictEqual(approvedRecord.approvedTargetDigest, stored.approvalDigest)
  assert.strictEqual(JSON.stringify(approved).includes('target-owner'), false)
  assert.strictEqual(JSON.stringify(approved).includes(stored.requestId), false)
  assert.strictEqual(JSON.stringify(approved).includes(stored.approvalDigest), false)

  const duplicateApproval = await bootstrap.main({ action: 'approve' })
  assert.strictEqual(duplicateApproval.success, false)
  assert.strictEqual(duplicateApproval.code, 'BOOTSTRAP_REQUEST_ALREADY_APPROVED')

  const approvalBoundary = originalDateNow() + 60 * 1000
  database.bucket('meal_members').set(REQUEST_DOCUMENT_ID, {
    ...stored, expiresAtMs: approvalBoundary,
  })
  currentNow = approvalBoundary - 1
  database.afterSnapshotAudit = async () => { currentNow = approvalBoundary }
  const boundaryApproval = await bootstrap.main({ action: 'approve' })
  currentNow = null
  assert.strictEqual(database.afterSnapshotAudit, null, 'approval time must be read inside the transaction')
  assert.strictEqual(boundaryApproval.success, false)
  assert.strictEqual(boundaryApproval.code, 'BOOTSTRAP_REQUEST_EXPIRED')
  database.bucket('meal_members').set(REQUEST_DOCUMENT_ID, approvedRecord)

  const activationBoundary = originalDateNow() + 60 * 1000
  database.bucket('meal_members').set(REQUEST_DOCUMENT_ID, {
    ...approvedRecord, expiresAtMs: activationBoundary,
  })
  currentNow = activationBoundary - 1
  database.afterSnapshotAudit = async () => { currentNow = activationBoundary }
  const boundaryActivation = await bootstrap.main({ action: 'activate' })
  currentNow = null
  assert.strictEqual(database.afterSnapshotAudit, null, 'activation time must be read inside the transaction')
  assert.strictEqual(boundaryActivation.success, false)
  assert.strictEqual(boundaryActivation.code, 'BOOTSTRAP_REQUEST_EXPIRED')
  database.bucket('meal_members').set(REQUEST_DOCUMENT_ID, approvedRecord)

  const privateDetail = 'private operational detail must not escape'
  database.nextTransactionError = Object.assign(new Error(privateDetail), {
    code: 'BOOTSTRAP_REQUEST_EXPIRED',
  })
  const forgedKnown = await bootstrap.main({ action: 'activate' })
  assert.deepStrictEqual(forgedKnown, {
    success: false,
    code: 'BOOTSTRAP_REQUEST_EXPIRED',
    message: '初始化请求已过期',
  })
  assert.strictEqual(JSON.stringify(forgedKnown).includes(privateDetail), false)

  const results = await Promise.all([
    bootstrap.main({ action: 'activate', requestId: '0'.repeat(32) }),
    bootstrap.main({ action: 'activate', targetOpenid: 'attacker-account' }),
  ])
  assert.strictEqual(results.filter((item) => item.success).length, 1)
  assert.strictEqual(results.filter((item) => !item.success).length, 1)
  assert.deepStrictEqual(results.find((item) => item.success), {
    success: true, data: { state: 'initialized' },
  })
  assert.strictEqual(JSON.stringify(results).includes('target-owner'), false)
  assert.strictEqual(JSON.stringify(results).includes(stored.requestId), false)
  assert.strictEqual(JSON.stringify(results).includes(stored.approvalDigest), false)
  assert.strictEqual(database.record('meal_members', 'target-owner').role, 'owner')
  assert.strictEqual(database.record('meal_members', CONTROL_ID).ownerOpenid, 'target-owner')
  assert.strictEqual(database.record('meal_members', CONTROL_ID).phase, 'active')
  assert.strictEqual(database.record('meal_members', CONTROL_ID).bootstrapRequestId, '')
  assert.strictEqual(database.record('meal_members', REQUEST_DOCUMENT_ID), undefined)

  const repeatedActivation = await bootstrap.main({ action: 'activate' })
  assert.strictEqual(repeatedActivation.success, false)
  assert.strictEqual(database.record('meal_members', CONTROL_ID).activeMemberCount, 1)
}

run().then(() => console.log('ownerBootstrapOnce transaction approval tests passed')).catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => { Date.now = originalDateNow })
