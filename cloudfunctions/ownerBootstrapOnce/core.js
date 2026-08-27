'use strict'

const crypto = require('crypto')

const CONTROL_ID = '__membership_control_v1__'
const REQUEST_DOCUMENT_ID = '__owner_bootstrap_request_v1__'
const REQUEST_SCHEMA = 1
const CONTROL_SCHEMA = 2
const CONTROL_PHASE_PENDING = 'bootstrap_pending'
const CONTROL_PHASE_APPROVED = 'bootstrap_approved'
const CONTROL_PHASE_ACTIVE = 'active'
const REQUEST_TTL_MS = 30 * 60 * 1000
const REQUEST_ID_PATTERN = /^[a-f0-9]{32}$/
const IDENTITY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

function fail(message, code) {
  const error = new Error(message)
  error.code = code
  throw error
}

function normalizedControl(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    schemaVersion: Number(source.schemaVersion),
    phase: typeof source.phase === 'string' ? source.phase : '',
    bootstrapRequestId: typeof source.bootstrapRequestId === 'string' ? source.bootstrapRequestId : '',
    ownerOpenid: typeof source.ownerOpenid === 'string' ? source.ownerOpenid : '',
    activeMemberCount: Number.isSafeInteger(Number(source.activeMemberCount)) ? Number(source.activeMemberCount) : 0,
    reservedInviteCount: Number.isSafeInteger(Number(source.reservedInviteCount)) ? Number(source.reservedInviteCount) : 0,
    revision: Number.isSafeInteger(Number(source.revision)) ? Number(source.revision) : 0,
  }
}

function validIdentity(value) {
  return typeof value === 'string'
    && IDENTITY_PATTERN.test(value)
    && value !== CONTROL_ID
    && value !== REQUEST_DOCUMENT_ID
}

function validRequestId(value) {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value)
}

function assertOperationalActivationContext(context = {}) {
  if (context && (
    context.OPENID
    || context.UNIONID
    || context.FROM_OPENID
    || context.FROM_UNIONID
  )) {
    fail('小程序终端不能执行管理员激活', 'BOOTSTRAP_CLIENT_DENIED')
  }
}

function approvalDigest(targetOpenid, requestId) {
  if (!validIdentity(targetOpenid) || !validRequestId(requestId)) {
    fail('初始化请求无效', 'BOOTSTRAP_REQUEST_INVALID')
  }
  return crypto.createHash('sha256')
    .update('owner-bootstrap-approval-v1\0')
    .update(requestId)
    .update('\0')
    .update(targetOpenid)
    .digest('hex')
}

function validatedRequest(raw) {
  if (!raw || typeof raw !== 'object') fail('初始化请求不存在', 'BOOTSTRAP_REQUEST_NOT_FOUND')
  const request = {
    kind: raw.kind,
    schemaVersion: Number(raw.schemaVersion),
    status: raw.status,
    requestId: raw.requestId,
    targetOpenid: raw.targetOpenid,
    approvalDigest: raw.approvalDigest,
    approvedRequestId: raw.approvedRequestId,
    approvedTargetDigest: raw.approvedTargetDigest,
    expiresAtMs: Number(raw.expiresAtMs),
  }
  if (
    request.kind !== 'owner_bootstrap_request'
    || request.schemaVersion !== REQUEST_SCHEMA
    || !['pending', 'approved'].includes(request.status)
    || !validRequestId(request.requestId)
    || !validIdentity(request.targetOpenid)
    || !Number.isSafeInteger(request.expiresAtMs)
    || request.expiresAtMs <= 0
    || request.approvalDigest !== approvalDigest(request.targetOpenid, request.requestId)
  ) fail('初始化请求记录无效', 'BOOTSTRAP_REQUEST_INVALID')
  return request
}

function assertControlEmpty(rawControl) {
  const control = normalizedControl(rawControl)
  if (control.phase === CONTROL_PHASE_ACTIVE || control.ownerOpenid || control.activeMemberCount) {
    fail('管理员已初始化', 'OWNER_ALREADY_INITIALIZED')
  }
  if (control.reservedInviteCount) fail('成员数据状态异常', 'MEMBERSHIP_INVARIANT_FAILED')
  return control
}

function bootstrapControl(request, phase = CONTROL_PHASE_PENDING, revision = 1) {
  const validated = validatedRequest(request)
  if (![CONTROL_PHASE_PENDING, CONTROL_PHASE_APPROVED].includes(phase)) {
    fail('初始化控制状态无效', 'BOOTSTRAP_REQUEST_INVALID')
  }
  return {
    kind: 'control', status: 'control', schemaVersion: CONTROL_SCHEMA,
    phase, bootstrapRequestId: validated.requestId,
    ownerOpenid: '', activeMemberCount: 0, reservedInviteCount: 0,
    revision, inviteSlots: 6, inviteTtlHours: 24,
  }
}

function assertBootstrapControl(rawControl, request, phase) {
  const control = assertControlEmpty(rawControl)
  if (
    control.schemaVersion !== CONTROL_SCHEMA
    || control.phase !== phase
    || control.bootstrapRequestId !== request.requestId
    || !Number.isSafeInteger(control.revision)
    || control.revision < 1
  ) fail('初始化控制状态无效', 'MEMBERSHIP_INVARIANT_FAILED')
  return control
}

function assertNoCurrentMember(current) {
  if (!current) return
  if (current.status === 'deleting') fail('账号数据正在删除', 'ACCOUNT_DELETION_IN_PROGRESS')
  fail('成员数据状态异常', 'MEMBERSHIP_INVARIANT_FAILED')
}

function assertEmptyBootstrapSnapshot(memberRecords, inviteRecords) {
  const members = Array.isArray(memberRecords) ? memberRecords : []
  const businessMembers = members.filter((record) => (
    record && record._id !== CONTROL_ID && record._id !== REQUEST_DOCUMENT_ID
  ))
  if (businessMembers.length || (Array.isArray(inviteRecords) && inviteRecords.length)) {
    fail('成员数据状态异常', 'MEMBERSHIP_INVARIANT_FAILED')
  }
}

function buildRequest(targetOpenid, requestId, now) {
  if (!Number.isSafeInteger(now) || now <= 0) fail('初始化请求时间无效', 'BOOTSTRAP_REQUEST_INVALID')
  return {
    kind: 'owner_bootstrap_request', schemaVersion: REQUEST_SCHEMA, status: 'pending',
    requestId, targetOpenid, approvalDigest: approvalDigest(targetOpenid, requestId),
    approvedRequestId: '', approvedTargetDigest: '', expiresAtMs: now + REQUEST_TTL_MS,
  }
}

function decideRequest(rawControl, rawRequest, current, targetOpenid, requestId, now) {
  if (!validIdentity(targetOpenid)) fail('无法识别微信身份', 'IDENTITY_REQUIRED')
  assertNoCurrentMember(current)
  if (rawRequest) {
    const existing = validatedRequest(rawRequest)
    assertBootstrapControl(rawControl, existing, existing.status === 'approved'
      ? CONTROL_PHASE_APPROVED : CONTROL_PHASE_PENDING)
    if (existing.expiresAtMs > now) {
      if (existing.targetOpenid !== targetOpenid) {
        fail('已有其他待确认的初始化请求', 'BOOTSTRAP_REQUEST_PENDING')
      }
      return { state: 'existing', request: existing }
    }
  }
  if (rawControl) {
    assertControlEmpty(rawControl)
    fail('成员数据状态异常', 'MEMBERSHIP_INVARIANT_FAILED')
  }
  return { state: 'created', request: buildRequest(targetOpenid, requestId, now) }
}

function decideApproval(rawControl, current, rawRequest, now) {
  const request = validatedRequest(rawRequest)
  if (request.expiresAtMs <= now) fail('初始化请求已过期', 'BOOTSTRAP_REQUEST_EXPIRED')
  if (request.status !== 'pending') fail('初始化请求已经批准', 'BOOTSTRAP_REQUEST_ALREADY_APPROVED')
  const control = assertBootstrapControl(rawControl, request, CONTROL_PHASE_PENDING)
  assertNoCurrentMember(current)
  return {
    state: 'approve',
    control,
    request: {
      ...request,
      status: 'approved',
      approvedRequestId: request.requestId,
      approvedTargetDigest: approvalDigest(request.targetOpenid, request.requestId),
    },
  }
}

function decideBootstrap(rawControl, current, rawRequest, now) {
  const request = validatedRequest(rawRequest)
  if (request.expiresAtMs <= now) fail('初始化请求已过期', 'BOOTSTRAP_REQUEST_EXPIRED')
  if (request.status !== 'approved') fail('初始化请求尚未由云端运维批准', 'BOOTSTRAP_REQUEST_NOT_APPROVED')
  const storedRequestId = request.requestId
  const expectedDigest = approvalDigest(request.targetOpenid, storedRequestId)
  if (request.approvedRequestId !== storedRequestId || request.approvedTargetDigest !== expectedDigest) {
    fail('云端批准记录与目标身份不一致', 'BOOTSTRAP_APPROVAL_INVALID')
  }
  const control = assertBootstrapControl(rawControl, request, CONTROL_PHASE_APPROVED)
  assertNoCurrentMember(current)
  return { state: 'initialize', targetOpenid: request.targetOpenid, control }
}

function publicRequest(rawRequest) {
  const request = validatedRequest(rawRequest)
  return {
    state: request.status,
    expiresAtMs: request.expiresAtMs,
  }
}

module.exports = {
  CONTROL_ID, REQUEST_DOCUMENT_ID, REQUEST_SCHEMA, REQUEST_TTL_MS,
  CONTROL_SCHEMA, CONTROL_PHASE_PENDING, CONTROL_PHASE_APPROVED, CONTROL_PHASE_ACTIVE,
  normalizedControl, assertOperationalActivationContext, approvalDigest, validatedRequest,
  bootstrapControl, assertBootstrapControl, assertEmptyBootstrapSnapshot,
  decideRequest, decideApproval, decideBootstrap, publicRequest,
}
