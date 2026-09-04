'use strict'

const assert = require('assert')
const {
  CONTROL_ID, configuration, normalizeControl, reserveInvite, consumeInvite, releaseInvite,
  CONTROL_PHASE_ACTIVE, CONTROL_PHASE_BOOTSTRAP_PENDING,
  assertOperationalControl, reviseOperationalControl, capacityExceeded,
  activateOwner, transferOwner, removeMember, assertReactivationAllowed, controlFromSnapshot, publicMember, publicInvite,
} = require('./core')

const config = configuration({})
assert.deepStrictEqual(config, { inviteSlots: 3, inviteTtlHours: 168, maxMembers: 4, inviteTtlMs: 604800000 })
assert.deepStrictEqual(
  configuration({ INVITE_SLOTS: '19', INVITE_TTL_HOURS: '24' }),
  config,
  '云端遗留配置不得扩大成员容量或缩短邀请码有效期',
)
assert.strictEqual(CONTROL_ID, '__membership_control_v1__')
const pendingControl = {
  kind: 'control', status: 'control', schemaVersion: 2,
  phase: CONTROL_PHASE_BOOTSTRAP_PENDING, bootstrapRequestId: 'a'.repeat(32),
  ownerOpenid: '', activeMemberCount: 0, reservedInviteCount: 0, revision: 1,
}
assert.throws(() => assertOperationalControl(null), (error) => error.code === 'MEMBERSHIP_NOT_INITIALIZED')
assert.throws(
  () => assertOperationalControl({ phase: CONTROL_PHASE_ACTIVE, ownerOpenid: 'forged' }),
  (error) => error.code === 'MEMBERSHIP_INVARIANT_FAILED',
)
assert.throws(
  () => assertOperationalControl(pendingControl),
  (error) => error.code === 'MEMBERSHIP_BOOTSTRAP_IN_PROGRESS',
)
assert.throws(() => reserveInvite(pendingControl, config), (error) => error.code === 'MEMBERSHIP_BOOTSTRAP_IN_PROGRESS')
assert.throws(() => releaseInvite(pendingControl), (error) => error.code === 'MEMBERSHIP_BOOTSTRAP_IN_PROGRESS')
const legacyControl = {
  kind: 'control', status: 'control', schemaVersion: 1,
  ownerOpenid: 'legacy-owner', activeMemberCount: 3, reservedInviteCount: 2, revision: 7,
}
assert.strictEqual(assertOperationalControl(legacyControl, config).phase, CONTROL_PHASE_ACTIVE)
assert.strictEqual(capacityExceeded(legacyControl, config), true)
assert.deepStrictEqual(reviseOperationalControl(legacyControl, config), {
  kind: 'control', status: 'control', schemaVersion: 2,
  phase: CONTROL_PHASE_ACTIVE, bootstrapRequestId: '',
  ownerOpenid: 'legacy-owner', activeMemberCount: 3, reservedInviteCount: 2, revision: 8,
})

let control = activateOwner(normalizeControl(), 'owner-internal-id', config)
control = {
  kind: 'control', status: 'control', ...control,
  phase: CONTROL_PHASE_ACTIVE, bootstrapRequestId: '',
}
assert.strictEqual(control.activeMemberCount, 1)
for (let index = 0; index < 3; index += 1) control = reserveInvite(control, config)
assert.strictEqual(control.reservedInviteCount, 3)
assert.throws(() => reserveInvite(control, config), (error) => error.code === 'MEMBERSHIP_FULL')

control = consumeInvite(control, config)
assert.strictEqual(control.activeMemberCount, 2)
assert.strictEqual(control.reservedInviteCount, 2)
assert.strictEqual(control.activeMemberCount + control.reservedInviteCount, 4)
control = releaseInvite(control)
assert.strictEqual(control.reservedInviteCount, 1)
assert.strictEqual(capacityExceeded(control, config), false)
assert.throws(
  () => consumeInvite({ ...control, activeMemberCount: 4, reservedInviteCount: 1 }, config),
  (error) => error.code === 'MEMBERSHIP_FULL',
)

control = transferOwner(control, 'owner-internal-id', 'member-internal-id')
assert.strictEqual(control.ownerOpenid, 'member-internal-id')
assert.throws(() => assertReactivationAllowed({ status: 'deleting' }), (
  error
) => error.code === 'ACCOUNT_DELETION_IN_PROGRESS')
assert.doesNotThrow(() => assertReactivationAllowed({ status: 'disabled' }))
assert.doesNotThrow(() => assertReactivationAllowed(null))
assert.throws(() => transferOwner(control, 'owner-internal-id', 'other'), (error) => error.code === 'OWNER_REQUIRED')
control = removeMember(control, 'owner-internal-id')
assert.strictEqual(control.activeMemberCount, 1)
assert.strictEqual(control.ownerOpenid, 'member-internal-id')
assert.strictEqual(reviseOperationalControl(control).revision, control.revision + 1)

const rebuilt = controlFromSnapshot([
  { _id: 'private-owner', status: 'active', role: 'owner' },
  { _id: 'private-member', status: 'active', role: 'member' },
], [
  { active: true, maxUses: 1, usedCount: 0 },
  { active: false, maxUses: 1, usedCount: 1 },
])
assert.strictEqual(rebuilt.activeMemberCount, 2)
assert.strictEqual(rebuilt.phase, CONTROL_PHASE_ACTIVE)
assert.strictEqual(rebuilt.bootstrapRequestId, '')
assert.strictEqual(rebuilt.reservedInviteCount, 1)
assert.throws(() => controlFromSnapshot([
  { _id: 'owner-a', status: 'active', role: 'owner' },
  { _id: 'owner-b', status: 'active', role: 'owner' },
], []), (error) => error.code === 'MEMBERSHIP_INVARIANT_FAILED')

const visible = publicMember({
  _id: 'must-not-leak', memberRef: 'a'.repeat(32), role: 'member', displayLabel: '家人', joinedAt: 123,
})
assert.deepStrictEqual(visible, { memberRef: 'a'.repeat(32), role: 'member', label: '家人', joinedAt: 123 })
assert.strictEqual(JSON.stringify(visible).includes('must-not-leak'), false)
assert.strictEqual(Object.prototype.hasOwnProperty.call(visible, '_id'), false)

const visibleInvite = publicInvite({
  _id: 'b'.repeat(32), label: ' 家人 ', expiresAt: 123,
  codeHash: 'must-not-leak', createdBy: 'private-owner', usedBy: 'private-member',
})
assert.deepStrictEqual(visibleInvite, { inviteRef: 'b'.repeat(32), label: '家人', expiresAt: 123 })
assert.strictEqual(JSON.stringify(visibleInvite).includes('must-not-leak'), false)
assert.strictEqual(Object.prototype.hasOwnProperty.call(visibleInvite, 'codeHash'), false)
assert.throws(() => publicInvite({ _id: 'invalid' }), (error) => error.code === 'INVITE_REFERENCE_INVALID')

console.log('membership control tests passed')
