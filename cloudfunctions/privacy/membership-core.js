'use strict'

const CONTROL_ID = '__membership_control_v1__'
const CONTROL_SCHEMA = 2
const CONTROL_PHASE_ACTIVE = 'active'
const CONTROL_PHASE_BOOTSTRAP_PENDING = 'bootstrap_pending'
const CONTROL_PHASE_BOOTSTRAP_APPROVED = 'bootstrap_approved'
const INVITE_SLOTS = 3
const INVITE_TTL_HOURS = 168

function fail(message, code = 'MEMBERSHIP_INVALID') {
  const error = new Error(message)
  error.code = code
  throw error
}

function configuration() {
  const inviteSlots = INVITE_SLOTS
  const inviteTtlHours = INVITE_TTL_HOURS
  return {
    inviteSlots,
    inviteTtlHours,
    maxMembers: inviteSlots + 1,
    inviteTtlMs: inviteTtlHours * 60 * 60 * 1000,
  }
}

function nonNegativeInteger(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function controlPhase(raw) {
  if (!raw || typeof raw !== 'object') return ''
  if ([
    CONTROL_PHASE_ACTIVE,
    CONTROL_PHASE_BOOTSTRAP_PENDING,
    CONTROL_PHASE_BOOTSTRAP_APPROVED,
  ].includes(raw.phase)) return raw.phase
  // Controls written before schema v2 were operational and did not carry a phase.
  if (raw.kind === 'control' && raw.status === 'control') return CONTROL_PHASE_ACTIVE
  return ''
}

function normalizeControl(raw = {}) {
  return {
    kind: 'control',
    status: 'control',
    schemaVersion: CONTROL_SCHEMA,
    phase: controlPhase(raw),
    bootstrapRequestId: typeof raw.bootstrapRequestId === 'string' ? raw.bootstrapRequestId : '',
    ownerOpenid: typeof raw.ownerOpenid === 'string' ? raw.ownerOpenid : '',
    activeMemberCount: nonNegativeInteger(raw.activeMemberCount),
    reservedInviteCount: nonNegativeInteger(raw.reservedInviteCount),
    revision: nonNegativeInteger(raw.revision),
  }
}

function assertOperationalControl(raw) {
  if (!raw || typeof raw !== 'object') {
    fail('成员服务尚未初始化，请联系管理员', 'MEMBERSHIP_NOT_INITIALIZED')
  }
  if (
    raw.kind !== 'control'
    || raw.status !== 'control'
    || ![1, CONTROL_SCHEMA].includes(Number(raw.schemaVersion))
  ) fail('成员控制状态异常，请联系管理员', 'MEMBERSHIP_INVARIANT_FAILED')
  const state = normalizeControl(raw)
  if ([CONTROL_PHASE_BOOTSTRAP_PENDING, CONTROL_PHASE_BOOTSTRAP_APPROVED].includes(state.phase)) {
    fail('管理员初始化正在进行，请稍后重试', 'MEMBERSHIP_BOOTSTRAP_IN_PROGRESS')
  }
  if (state.phase !== CONTROL_PHASE_ACTIVE || state.bootstrapRequestId) {
    fail('成员控制状态异常，请联系管理员', 'MEMBERSHIP_INVARIANT_FAILED')
  }
  return state
}

function reviseOperationalControl(control) {
  const state = assertOperationalControl(control)
  return { ...state, revision: state.revision + 1 }
}

function assertWithinCapacity(control, config) {
  const state = normalizeControl(control)
  if (state.activeMemberCount + state.reservedInviteCount > config.maxMembers) {
    fail('成员容量状态异常，请联系管理员', 'MEMBERSHIP_INVARIANT_FAILED')
  }
  return state
}

function capacityExceeded(control, config) {
  const state = normalizeControl(control)
  return state.activeMemberCount + state.reservedInviteCount > config.maxMembers
}

function reserveInvite(control, config) {
  const state = assertOperationalControl(control)
  if (state.activeMemberCount + state.reservedInviteCount >= config.maxMembers) {
    fail('成员名额已满或已有待使用邀请码', 'MEMBERSHIP_FULL')
  }
  return { ...state, reservedInviteCount: state.reservedInviteCount + 1, revision: state.revision + 1 }
}

function consumeInvite(control, config) {
  const state = assertOperationalControl(control)
  if (state.reservedInviteCount < 1) fail('邀请码容量状态异常，请重试', 'MEMBERSHIP_INVARIANT_FAILED')
  if (capacityExceeded(state, config) || state.activeMemberCount >= config.maxMembers) {
    fail('成员名额已满或已有待使用邀请码', 'MEMBERSHIP_FULL')
  }
  return {
    ...state,
    activeMemberCount: state.activeMemberCount + 1,
    reservedInviteCount: state.reservedInviteCount - 1,
    revision: state.revision + 1,
  }
}

function releaseInvite(control) {
  const state = assertOperationalControl(control)
  if (state.reservedInviteCount < 1) fail('邀请码容量状态异常，请重试', 'MEMBERSHIP_INVARIANT_FAILED')
  return { ...state, reservedInviteCount: state.reservedInviteCount - 1, revision: state.revision + 1 }
}

function activateOwner(control, openid, config) {
  const state = assertWithinCapacity({ ...normalizeControl(control), phase: CONTROL_PHASE_ACTIVE }, config)
  if (state.ownerOpenid || state.activeMemberCount) fail('管理员已激活，请使用成员邀请码', 'OWNER_ALREADY_ACTIVE')
  return { ...state, ownerOpenid: openid, activeMemberCount: 1, revision: state.revision + 1 }
}

function transferOwner(control, currentOwner, nextOwner) {
  const state = assertOperationalControl(control)
  if (!currentOwner || state.ownerOpenid !== currentOwner) fail('只有当前管理员可以转移管理员身份', 'OWNER_REQUIRED')
  if (!nextOwner || nextOwner === currentOwner) fail('请选择另一名普通成员', 'TRANSFER_TARGET_INVALID')
  return { ...state, ownerOpenid: nextOwner, revision: state.revision + 1 }
}

function removeMember(control, openid) {
  const state = assertOperationalControl(control)
  if (state.activeMemberCount < 1) fail('成员容量状态异常，请重试', 'MEMBERSHIP_INVARIANT_FAILED')
  return {
    ...state,
    ownerOpenid: state.ownerOpenid === openid ? '' : state.ownerOpenid,
    activeMemberCount: state.activeMemberCount - 1,
    revision: state.revision + 1,
  }
}

function assertReactivationAllowed(record) {
  if (record && record.status === 'deleting') {
    fail('账号数据正在删除，请等待完成后再重新加入', 'ACCOUNT_DELETION_IN_PROGRESS')
  }
}

function controlFromSnapshot(memberRecords, inviteRecords) {
  const active = (Array.isArray(memberRecords) ? memberRecords : []).filter((item) => item && item.status === 'active')
  const owners = active.filter((item) => item.role === 'owner')
  if (owners.length > 1 || (active.length && owners.length !== 1)) {
    fail('成员管理员状态异常，请联系管理员', 'MEMBERSHIP_INVARIANT_FAILED')
  }
  const reservedInviteCount = (Array.isArray(inviteRecords) ? inviteRecords : []).filter((item) => (
    item && item.active === true && Number(item.usedCount || 0) < Number(item.maxUses || 1)
  )).length
  return {
    schemaVersion: CONTROL_SCHEMA,
    phase: CONTROL_PHASE_ACTIVE,
    bootstrapRequestId: '',
    ownerOpenid: owners.length ? String(owners[0]._id || '') : '',
    activeMemberCount: active.length,
    reservedInviteCount,
    revision: 0,
  }
}

function isMemberRef(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
}

function isInviteRef(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
}

function publicInvite(record) {
  if (!record || !isInviteRef(record._id)) fail('邀请引用无效', 'INVITE_REFERENCE_INVALID')
  return {
    inviteRef: record._id,
    label: typeof record.label === 'string' ? record.label.trim().slice(0, 20) : '',
    expiresAt: record.expiresAt || null,
  }
}

function publicMember(record, index = 0) {
  if (!record || !isMemberRef(record.memberRef)) fail('成员引用尚未初始化，请重试', 'MEMBER_REFERENCE_MISSING')
  const role = record.role === 'owner' ? 'owner' : 'member'
  const storedLabel = typeof record.displayLabel === 'string' ? record.displayLabel.trim().slice(0, 20) : ''
  return {
    memberRef: record.memberRef,
    role,
    label: role === 'owner' ? '管理员' : (storedLabel || `受邀成员 ${index + 1}`),
    joinedAt: record.joinedAt || null,
  }
}

module.exports = {
  CONTROL_ID,
  CONTROL_SCHEMA,
  CONTROL_PHASE_ACTIVE,
  CONTROL_PHASE_BOOTSTRAP_PENDING,
  CONTROL_PHASE_BOOTSTRAP_APPROVED,
  INVITE_SLOTS,
  INVITE_TTL_HOURS,
  configuration,
  normalizeControl,
  assertOperationalControl,
  reviseOperationalControl,
  capacityExceeded,
  reserveInvite,
  consumeInvite,
  releaseInvite,
  activateOwner,
  transferOwner,
  removeMember,
  assertReactivationAllowed,
  controlFromSnapshot,
  isMemberRef,
  isInviteRef,
  publicMember,
  publicInvite,
}
