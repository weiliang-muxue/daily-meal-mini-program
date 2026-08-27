'use strict'

const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const {
  CONTROL_ID, REQUEST_DOCUMENT_ID, CONTROL_SCHEMA,
  CONTROL_PHASE_PENDING, CONTROL_PHASE_APPROVED, CONTROL_PHASE_ACTIVE,
  validatedRequest, bootstrapControl, assertBootstrapControl, assertEmptyBootstrapSnapshot,
  assertOperationalActivationContext, decideRequest, decideApproval, decideBootstrap, publicRequest,
} = require('./core')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const PUBLIC_MESSAGES = Object.freeze({
  BOOTSTRAP_ACTION_INVALID: '初始化操作无效',
  BOOTSTRAP_CLIENT_DENIED: '小程序终端不能执行管理员激活',
  IDENTITY_REQUIRED: '无法识别微信身份',
  BOOTSTRAP_REQUEST_INVALID: '初始化请求无效',
  BOOTSTRAP_REQUEST_PENDING: '已有其他待确认的初始化请求',
  BOOTSTRAP_REQUEST_NOT_FOUND: '初始化请求不存在',
  BOOTSTRAP_REQUEST_ALREADY_APPROVED: '初始化请求已经批准',
  BOOTSTRAP_REQUEST_NOT_APPROVED: '初始化请求尚未由云端运维批准',
  BOOTSTRAP_REQUEST_EXPIRED: '初始化请求已过期',
  BOOTSTRAP_APPROVAL_INVALID: '云端批准记录与目标身份不一致',
  OWNER_ALREADY_INITIALIZED: '管理员已初始化',
  BOOTSTRAP_STATE_CHECK_FAILED: '无法校验初始成员状态',
  BOOTSTRAP_REQUEST_STORAGE_FAILED: '无法保存初始化请求',
  BOOTSTRAP_CONTROL_READ_FAILED: '无法读取管理员初始化状态',
  BOOTSTRAP_RECORD_READ_FAILED: '无法读取初始化请求状态',
  BOOTSTRAP_MEMBER_READ_FAILED: '无法读取目标成员状态',
  BOOTSTRAP_REQUEST_WRITE_FAILED: '无法写入初始化请求',
  BOOTSTRAP_APPROVAL_WRITE_FAILED: '无法写入初始化批准状态',
  BOOTSTRAP_APPROVAL_STORAGE_FAILED: '无法保存初始化批准状态',
  BOOTSTRAP_ACTIVATION_STORAGE_FAILED: '无法完成管理员初始化',
  ACCOUNT_DELETION_IN_PROGRESS: '账号数据正在删除',
  MEMBERSHIP_INVARIANT_FAILED: '成员数据状态异常',
})
const DEFAULT_PUBLIC_ERROR = Object.freeze({
  code: 'OWNER_BOOTSTRAP_FAILED', message: '管理员初始化失败，请重试',
})

function stringValue(value) {
  return value === undefined || value === null ? '' : String(value).trim()
}

function documentMissingMessage(identifier) {
  return identifier === 'DATABASE_DOCUMENT_NOT_FOUND'
    || /^(?:document\.get:fail )?document with _id .+ does not exist$/i.test(identifier)
    || /^(?:document\.get:fail )?document does not exist$/i.test(identifier)
}

function notFound(error) {
  if (typeof error === 'string') return documentMissingMessage(error.trim())
  if (!error || typeof error !== 'object') return false
  const codes = ['code', 'errCode'].map((field) => stringValue(error[field])).filter(Boolean)
  if (codes.some((code) => code !== '-1' && code !== 'DATABASE_DOCUMENT_NOT_FOUND')) return false
  const messages = ['message', 'errMsg'].map((field) => stringValue(error[field])).filter(Boolean)
  if (messages.some((message) => !documentMissingMessage(message))) return false
  return codes.includes('DATABASE_DOCUMENT_NOT_FOUND') || messages.length > 0
}

async function readDocument(reference) {
  try { return (await reference.get()).data || null }
  catch (error) { if (notFound(error)) return null; throw error }
}

async function readBootstrapDocument(reference, code) {
  try { return await readDocument(reference) }
  catch (error) { stageError(null, code, '无法读取初始化请求状态') }
}

function randomHex(bytes) { return crypto.randomBytes(bytes).toString('hex') }

function stageError(error, code, message) {
  if (error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code)) throw error
  const wrapped = new Error(message)
  wrapped.code = code
  throw wrapped
}

async function assertEmptyMembershipState() {
  let members; let invites
  try {
    members = await db.collection('meal_members').limit(3).get()
    invites = await db.collection('meal_invites').limit(1).get()
  } catch (error) { stageError(null, 'BOOTSTRAP_STATE_CHECK_FAILED', '无法校验初始成员状态') }
  if (!members || !Array.isArray(members.data) || !invites || !Array.isArray(invites.data)) {
    stageError(null, 'BOOTSTRAP_STATE_CHECK_FAILED', '无法校验初始成员状态')
  }
  assertEmptyBootstrapSnapshot(members.data, invites.data)
}

async function createRequest(targetOpenid) {
  const requestId = randomHex(16)
  await assertEmptyMembershipState()
  try { return await db.runTransaction(async (transaction) => {
    const controlReference = transaction.collection('meal_members').doc(CONTROL_ID)
    const requestReference = transaction.collection('meal_members').doc(REQUEST_DOCUMENT_ID)
    const memberReference = transaction.collection('meal_members').doc(targetOpenid)
    let rawControl = await readBootstrapDocument(controlReference, 'BOOTSTRAP_CONTROL_READ_FAILED')
    let rawRequest = await readBootstrapDocument(requestReference, 'BOOTSTRAP_RECORD_READ_FAILED')
    const current = await readBootstrapDocument(memberReference, 'BOOTSTRAP_MEMBER_READ_FAILED')
    const nowMs = Date.now()
    let nextControlRevision = 1
    if (rawRequest && Number(rawRequest.expiresAtMs) <= nowMs && rawControl) {
      const expiredRequest = validatedRequest(rawRequest)
      const expiredPhase = expiredRequest.status === 'approved' ? CONTROL_PHASE_APPROVED : CONTROL_PHASE_PENDING
      const expiredControl = assertBootstrapControl(rawControl, expiredRequest, expiredPhase)
      nextControlRevision = expiredControl.revision + 1
      rawRequest = null
      rawControl = null
    }
    const decision = decideRequest(rawControl, rawRequest, current, targetOpenid, requestId, nowMs)
    if (decision.state === 'existing') return publicRequest(decision.request)
    const nextControl = bootstrapControl(decision.request, CONTROL_PHASE_PENDING, nextControlRevision)
    try {
      await controlReference.set({ data: {
        ...nextControl, createdAt: db.serverDate(), updatedAt: db.serverDate(),
      } })
      await requestReference.set({ data: {
        ...decision.request, createdAt: db.serverDate(), updatedAt: db.serverDate(),
      } })
    } catch (error) {
      stageError(null, 'BOOTSTRAP_REQUEST_WRITE_FAILED', '无法写入初始化请求')
    }
    return publicRequest(decision.request)
  }) } catch (error) {
    stageError(error, 'BOOTSTRAP_REQUEST_STORAGE_FAILED', '无法保存初始化请求')
  }
}

async function approve() {
  try { return await db.runTransaction(async (transaction) => {
    const controlReference = transaction.collection('meal_members').doc(CONTROL_ID)
    const requestReference = transaction.collection('meal_members').doc(REQUEST_DOCUMENT_ID)
    const rawControl = await readBootstrapDocument(controlReference, 'BOOTSTRAP_CONTROL_READ_FAILED')
    const rawRequest = await readBootstrapDocument(requestReference, 'BOOTSTRAP_RECORD_READ_FAILED')
    const request = validatedRequest(rawRequest)
    const memberReference = transaction.collection('meal_members').doc(request.targetOpenid)
    const current = await readBootstrapDocument(memberReference, 'BOOTSTRAP_MEMBER_READ_FAILED')
    const nowMs = Date.now()
    const decision = decideApproval(rawControl, current, request, nowMs)
    try {
      await requestReference.set({ data: {
        ...rawRequest, ...decision.request, updatedAt: db.serverDate(),
      } })
      await controlReference.update({ data: {
        ...bootstrapControl(decision.request, CONTROL_PHASE_APPROVED, decision.control.revision + 1),
        updatedAt: db.serverDate(),
      } })
    } catch (error) {
      stageError(null, 'BOOTSTRAP_APPROVAL_WRITE_FAILED', '无法写入初始化批准状态')
    }
    return { state: 'approved' }
  }) } catch (error) {
    stageError(error, 'BOOTSTRAP_APPROVAL_STORAGE_FAILED', '无法保存初始化批准状态')
  }
}

async function activate() {
  const memberRef = randomHex(16)
  const cacheNamespace = randomHex(16)
  try { return await db.runTransaction(async (transaction) => {
    const controlReference = transaction.collection('meal_members').doc(CONTROL_ID)
    const requestReference = transaction.collection('meal_members').doc(REQUEST_DOCUMENT_ID)
    const rawControl = await readBootstrapDocument(controlReference, 'BOOTSTRAP_CONTROL_READ_FAILED')
    const rawRequest = await readBootstrapDocument(requestReference, 'BOOTSTRAP_RECORD_READ_FAILED')
    const request = validatedRequest(rawRequest)
    const memberReference = transaction.collection('meal_members').doc(request.targetOpenid)
    const current = await readBootstrapDocument(memberReference, 'BOOTSTRAP_MEMBER_READ_FAILED')
    const nowMs = Date.now()
    const decision = decideBootstrap(rawControl, current, request, nowMs)
    const now = db.serverDate()
    await memberReference.set({ data: {
      status: 'active', role: 'owner', memberRef, cacheNamespace, joinedAt: now, updatedAt: now,
    } })
    await controlReference.set({ data: {
      kind: 'control', status: 'control', schemaVersion: CONTROL_SCHEMA,
      phase: CONTROL_PHASE_ACTIVE, bootstrapRequestId: '',
      ownerOpenid: decision.targetOpenid, activeMemberCount: 1, reservedInviteCount: 0,
      revision: decision.control.revision + 1, inviteSlots: 6, inviteTtlHours: 24,
      createdAt: now, updatedAt: now,
    } })
    await requestReference.remove()
    return { state: 'initialized' }
  }) } catch (error) {
    stageError(error, 'BOOTSTRAP_ACTIVATION_STORAGE_FAILED', '无法完成管理员初始化')
  }
}

exports.main = async (event = {}) => {
  const action = event && event.action
  try {
    if (action === 'request') {
      const { OPENID } = cloud.getWXContext()
      if (!OPENID) {
        const error = new Error('无法识别微信身份')
        error.code = 'IDENTITY_REQUIRED'
        throw error
      }
      return { success: true, data: await createRequest(OPENID) }
    }
    if (action === 'approve') {
      assertOperationalActivationContext(cloud.getWXContext())
      return { success: true, data: await approve() }
    }
    if (action === 'activate') {
      assertOperationalActivationContext(cloud.getWXContext())
      return { success: true, data: await activate() }
    }
    const error = new Error('初始化操作无效')
    error.code = 'BOOTSTRAP_ACTION_INVALID'
    throw error
  } catch (error) {
    const requestedCode = error && error.code
    const known = typeof requestedCode === 'string'
      && Object.prototype.hasOwnProperty.call(PUBLIC_MESSAGES, requestedCode)
    const code = known ? requestedCode : DEFAULT_PUBLIC_ERROR.code
    console.error('owner bootstrap failed', { code, name: error && error.name })
    return { success: false, code, message: known ? PUBLIC_MESSAGES[code] : DEFAULT_PUBLIC_ERROR.message }
  }
}

exports._test = { assertEmptyMembershipState, createRequest, approve, activate, notFound }
