'use strict'

const assert = require('assert')
const {
  CONTROL_ID, REQUEST_DOCUMENT_ID, REQUEST_TTL_MS, approvalDigest,
  INVITE_SLOTS, INVITE_TTL_HOURS,
  CONTROL_PHASE_PENDING, CONTROL_PHASE_APPROVED, CONTROL_PHASE_ACTIVE,
  bootstrapControl, assertBootstrapControl,
  assertOperationalActivationContext, assertEmptyBootstrapSnapshot,
  decideRequest, decideApproval, decideBootstrap, publicRequest,
} = require('./core')

const now = 2000000000000
const owner = 'owner-account'
const requestId = 'a'.repeat(32)
const pending = {
  kind: 'owner_bootstrap_request', schemaVersion: 1, status: 'pending',
  requestId, targetOpenid: owner, approvalDigest: approvalDigest(owner, requestId),
  approvedRequestId: '', approvedTargetDigest: '', expiresAtMs: now + REQUEST_TTL_MS,
}
const pendingControl = bootstrapControl(pending, CONTROL_PHASE_PENDING, 1)
assert.strictEqual(INVITE_SLOTS, 3)
assert.strictEqual(INVITE_TTL_HOURS, 168)
assert.strictEqual(pendingControl.inviteSlots, 3)
assert.strictEqual(pendingControl.inviteTtlHours, 168)

assert.doesNotThrow(() => assertOperationalActivationContext({ SOURCE: 'unknown-operation' }))
assert.throws(
  () => assertOperationalActivationContext({ OPENID: 'end-user' }),
  (error) => error.code === 'BOOTSTRAP_CLIENT_DENIED',
)
assert.throws(
  () => assertOperationalActivationContext({ UNIONID: 'linked-end-user' }),
  (error) => error.code === 'BOOTSTRAP_CLIENT_DENIED',
)
assert.throws(
  () => assertOperationalActivationContext({ FROM_OPENID: 'cross-account-end-user' }),
  (error) => error.code === 'BOOTSTRAP_CLIENT_DENIED',
)
assert.throws(
  () => assertOperationalActivationContext({ FROM_UNIONID: 'linked-cross-account-end-user' }),
  (error) => error.code === 'BOOTSTRAP_CLIENT_DENIED',
)

assert.doesNotThrow(() => assertEmptyBootstrapSnapshot([
  { _id: CONTROL_ID }, { _id: REQUEST_DOCUMENT_ID },
], []))
assert.throws(
  () => assertEmptyBootstrapSnapshot([{ _id: 'existing-member' }], []),
  (error) => error.code === 'MEMBERSHIP_INVARIANT_FAILED',
)
assert.throws(
  () => assertEmptyBootstrapSnapshot([], [{ _id: 'old-invite' }]),
  (error) => error.code === 'MEMBERSHIP_INVARIANT_FAILED',
)

const created = decideRequest(null, null, null, owner, requestId, now)
assert.strictEqual(created.state, 'created')
assert.strictEqual(created.request.targetOpenid, owner)
assert.strictEqual(created.request.expiresAtMs, now + REQUEST_TTL_MS)
assert.deepStrictEqual(publicRequest(created.request), {
  state: 'pending', expiresAtMs: now + REQUEST_TTL_MS,
})
assert.strictEqual(Object.prototype.hasOwnProperty.call(publicRequest(created.request), 'requestId'), false)
assert.strictEqual(Object.prototype.hasOwnProperty.call(publicRequest(created.request), 'targetOpenid'), false)
assert.strictEqual(Object.prototype.hasOwnProperty.call(publicRequest(created.request), 'approvalDigest'), false)
assert.strictEqual(decideRequest(pendingControl, pending, null, owner, 'b'.repeat(32), now).state, 'existing')
assert.throws(
  () => decideRequest(pendingControl, pending, null, 'other-account', 'b'.repeat(32), now),
  (error) => error.code === 'BOOTSTRAP_REQUEST_PENDING',
)
assert.throws(
  () => decideRequest({ ownerOpenid: owner, activeMemberCount: 1 }, null, null, owner, requestId, now),
  (error) => error.code === 'OWNER_ALREADY_INITIALIZED',
)
assert.throws(
  () => decideRequest(null, null, { status: 'disabled' }, owner, requestId, now),
  (error) => error.code === 'MEMBERSHIP_INVARIANT_FAILED',
)

assert.throws(
  () => decideBootstrap(pendingControl, null, pending, now),
  (error) => error.code === 'BOOTSTRAP_REQUEST_NOT_APPROVED',
)
const approvalDecision = decideApproval(pendingControl, null, pending, now)
const approved = approvalDecision.request
const approvedControl = bootstrapControl(approved, CONTROL_PHASE_APPROVED, pendingControl.revision + 1)
assert.strictEqual(approved.status, 'approved')
assert.strictEqual(approved.approvedRequestId, requestId)
assert.strictEqual(approved.approvedTargetDigest, approvalDigest(owner, requestId))
assert.throws(
  () => decideApproval(pendingControl, null, { ...pending, expiresAtMs: now }, now),
  (error) => error.code === 'BOOTSTRAP_REQUEST_EXPIRED',
)
assert.throws(
  () => decideApproval(approvedControl, null, approved, now),
  (error) => error.code === 'BOOTSTRAP_REQUEST_ALREADY_APPROVED',
)
assert.throws(
  () => decideApproval({ ownerOpenid: owner, activeMemberCount: 1 }, null, pending, now),
  (error) => error.code === 'OWNER_ALREADY_INITIALIZED',
)
assert.throws(
  () => decideApproval(pendingControl, { status: 'active' }, pending, now),
  (error) => error.code === 'MEMBERSHIP_INVARIANT_FAILED',
)
assert.deepStrictEqual(decideBootstrap(approvedControl, null, approved, now), {
  state: 'initialize', targetOpenid: owner,
  control: {
    schemaVersion: 2, phase: CONTROL_PHASE_APPROVED, bootstrapRequestId: requestId,
    ownerOpenid: '', activeMemberCount: 0, reservedInviteCount: 0, revision: 2,
  },
})
assert.throws(
  () => decideBootstrap(approvedControl, null, { ...approved, approvedTargetDigest: '0'.repeat(64) }, now),
  (error) => error.code === 'BOOTSTRAP_APPROVAL_INVALID',
)
assert.throws(
  () => decideBootstrap(approvedControl, null, { ...approved, expiresAtMs: now }, now),
  (error) => error.code === 'BOOTSTRAP_REQUEST_EXPIRED',
)
assert.throws(
  () => decideBootstrap(approvedControl, { status: 'active' }, approved, now),
  (error) => error.code === 'MEMBERSHIP_INVARIANT_FAILED',
)
assert.strictEqual(pendingControl.phase, CONTROL_PHASE_PENDING)
assert.strictEqual(approvedControl.phase, CONTROL_PHASE_APPROVED)
assert.notStrictEqual(CONTROL_PHASE_ACTIVE, CONTROL_PHASE_APPROVED)
assert.strictEqual(assertBootstrapControl(pendingControl, pending, CONTROL_PHASE_PENDING).revision, 1)
assert.throws(
  () => assertBootstrapControl({ ...pendingControl, revision: 2 }, { ...pending, requestId: 'b'.repeat(32) }, CONTROL_PHASE_PENDING),
  (error) => error.code === 'BOOTSTRAP_REQUEST_INVALID' || error.code === 'MEMBERSHIP_INVARIANT_FAILED',
)

console.log('ownerBootstrapOnce approval core tests passed')
