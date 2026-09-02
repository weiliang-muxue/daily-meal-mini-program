'use strict'

const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const {
  CONTROL_ID, configuration, normalizeControl, reserveInvite, consumeInvite, releaseInvite,
  transferOwner: transferOwnerControl,
  assertOperationalControl, reviseOperationalControl,
  capacityExceeded, assertReactivationAllowed, controlFromSnapshot,
  isMemberRef, isInviteRef, publicMember, publicInvite,
} = require('./core')
const { notFound } = require('./not-found')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const members = db.collection('meal_members')
const invites = db.collection('meal_invites')
const config = configuration()

function clean(value, maxLength = 40) { return typeof value === 'string' ? value.trim().slice(0, maxLength) : '' }
function codeHash(value) { return crypto.createHash('sha256').update(clean(value).toUpperCase()).digest('hex') }
function randomHex(bytes) { return crypto.randomBytes(bytes).toString('hex') }
function isCacheNamespace(value) { return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) }
function inviteExpired(expiresAt, now = Date.now()) {
  const timestamp = Number(expiresAt || 0)
  return !Number.isFinite(timestamp) || timestamp <= now
}

async function readDocument(reference) {
  try { return (await reference.get()).data || null }
  catch (error) { if (notFound(error)) return null; throw error }
}

async function queryAll(collection, criteria) {
  const records = []
  while (true) {
    const result = await db.collection(collection).where(criteria).skip(records.length).limit(100).get()
    records.push(...result.data)
    if (result.data.length < 100) return records
  }
}

function safeMember(member, control) {
  if (member && member.status === 'deleting') {
    if (!isCacheNamespace(member.cacheNamespace)) {
      const error = new Error('成员清理状态异常，请联系管理员')
      error.code = 'MEMBERSHIP_INVARIANT_FAILED'
      throw error
    }
    return { status: 'deleting', cacheNamespace: member.cacheNamespace }
  }
  const active = Boolean(member && member.status === 'active')
  return {
    status: active ? 'active' : 'invite_required',
    role: active && member.role === 'owner' ? 'owner' : active ? 'member' : '',
    joinedAt: active ? member.joinedAt || null : null,
    memberRef: active && isMemberRef(member.memberRef) ? member.memberRef : '',
    maxMembers: config.maxMembers,
    inviteSlots: config.inviteSlots,
    inviteTtlHours: config.inviteTtlHours,
    capacityExceeded: capacityExceeded(control, config),
    cacheNamespace: active && isCacheNamespace(member.cacheNamespace) ? member.cacheNamespace : '',
  }
}

async function readMember(openid) { return readDocument(members.doc(openid)) }

async function ensureControl() {
  const existing = await readDocument(members.doc(CONTROL_ID))
  if (existing) return existing
  const [activeMembers, activeInvites] = await Promise.all([
    queryAll('meal_members', { status: 'active' }),
    queryAll('meal_invites', { active: true }),
  ])
  // A fresh empty deployment is owned exclusively by ownerBootstrapOnce. The
  // membership service only rebuilds controls for pre-control legacy data.
  if (!activeMembers.length && !activeInvites.length) return null
  const rebuilt = controlFromSnapshot(activeMembers, activeInvites)
  if (!rebuilt.ownerOpenid || rebuilt.activeMemberCount < 1) {
    const error = new Error('成员控制状态异常，请联系管理员')
    error.code = 'MEMBERSHIP_INVARIANT_FAILED'
    throw error
  }
  await db.runTransaction(async (transaction) => {
    const reference = transaction.collection('meal_members').doc(CONTROL_ID)
    if (await readDocument(reference)) return
    await reference.set({ data: {
      kind: 'control', status: 'control', ...rebuilt,
      inviteSlots: config.inviteSlots, inviteTtlHours: config.inviteTtlHours,
      createdAt: db.serverDate(), updatedAt: db.serverDate(),
    } })
  })
  return readDocument(members.doc(CONTROL_ID))
}

async function uniqueMemberRef() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const memberRef = randomHex(16)
    const result = await members.where({ memberRef }).limit(1).get()
    if (!result.data.length) return memberRef
  }
  const error = new Error('无法创建成员引用，请重试')
  error.code = 'MEMBER_REFERENCE_FAILED'
  throw error
}

async function ensureMemberIdentity(openid, member) {
  if (!member || member.status !== 'active') return member
  const rawControl = await ensureControl()
  const control = assertOperationalControl(rawControl, config)
  const needsControlUpgrade = Number(rawControl.schemaVersion) !== control.schemaVersion
    || rawControl.phase !== control.phase
    || typeof rawControl.bootstrapRequestId !== 'string'
  if (isCacheNamespace(member.cacheNamespace) && isMemberRef(member.memberRef) && !needsControlUpgrade) return member
  const candidateNamespace = isCacheNamespace(member.cacheNamespace) ? member.cacheNamespace : randomHex(16)
  const candidateRef = isMemberRef(member.memberRef) ? member.memberRef : await uniqueMemberRef()
  await db.runTransaction(async (transaction) => {
    const controlReference = transaction.collection('meal_members').doc(CONTROL_ID)
    const reference = transaction.collection('meal_members').doc(openid)
    const rawControl = await readDocument(controlReference)
    const fresh = await readDocument(reference)
    if (!fresh || fresh.status !== 'active') return
    const data = {}
    if (!isCacheNamespace(fresh.cacheNamespace)) data.cacheNamespace = candidateNamespace
    if (!isMemberRef(fresh.memberRef)) data.memberRef = candidateRef
    if (Object.keys(data).length || needsControlUpgrade) {
      const nextControl = reviseOperationalControl(rawControl, config)
      await reference.update({ data: { ...data, updatedAt: db.serverDate() } })
      await controlReference.update({ data: {
        ...nextControl, inviteSlots: config.inviteSlots, inviteTtlHours: config.inviteTtlHours,
        updatedAt: db.serverDate(),
      } })
    }
  })
  return readMember(openid)
}

async function requireOwner(openid) {
  const control = assertOperationalControl(await ensureControl(), config)
  const member = await ensureMemberIdentity(openid, await readMember(openid))
  if (!member || member.status !== 'active' || member.role !== 'owner' || control.ownerOpenid !== openid) {
    const error = new Error('只有管理员可以管理成员')
    error.code = 'OWNER_REQUIRED'
    throw error
  }
  return member
}

async function expireInvite(inviteId, now = Date.now()) {
  await ensureControl()
  return db.runTransaction(async (transaction) => {
    const inviteReference = transaction.collection('meal_invites').doc(inviteId)
    const controlReference = transaction.collection('meal_members').doc(CONTROL_ID)
    const rawControl = await readDocument(controlReference)
    assertOperationalControl(rawControl, config)
    const invite = await readDocument(inviteReference)
    if (!invite || invite.active !== true || !inviteExpired(invite.expiresAt, now)) return false
    const next = releaseInvite(rawControl)
    await inviteReference.update({ data: { active: false, expiredAt: db.serverDate(), updatedAt: db.serverDate() } })
    await controlReference.update({ data: {
      ...next, inviteSlots: config.inviteSlots, inviteTtlHours: config.inviteTtlHours, updatedAt: db.serverDate(),
    } })
    return true
  })
}

async function cleanupExpiredInvites() {
  assertOperationalControl(await ensureControl())
  const now = Date.now()
  const active = await queryAll('meal_invites', { active: true })
  for (const invite of active) {
    if (inviteExpired(invite.expiresAt, now)) await expireInvite(invite._id, now)
  }
}

function inviteOrderValue(value) {
  const timestamp = Number(value || 0)
  return Number.isFinite(timestamp) ? timestamp : 0
}

async function revokeExcessInvite(inviteId) {
  return db.runTransaction(async (transaction) => {
    const controlReference = transaction.collection('meal_members').doc(CONTROL_ID)
    const inviteReference = transaction.collection('meal_invites').doc(inviteId)
    const rawControl = await readDocument(controlReference)
    const control = assertOperationalControl(rawControl)
    if (!capacityExceeded(control, config) || control.reservedInviteCount < 1) return false
    const invite = await readDocument(inviteReference)
    const used = Number(invite && invite.usedCount || 0) >= Number(invite && invite.maxUses || 1)
    if (!invite || invite.active !== true || used) return false
    const next = releaseInvite(control)
    await inviteReference.update({ data: {
      active: false, capacityRevokedAt: db.serverDate(), updatedAt: db.serverDate(),
    } })
    await controlReference.update({ data: {
      ...next, inviteSlots: config.inviteSlots, inviteTtlHours: config.inviteTtlHours,
      updatedAt: db.serverDate(),
    } })
    return true
  })
}

async function cleanupExcessInvites() {
  const rawControl = await ensureControl()
  const control = assertOperationalControl(rawControl)
  if (!capacityExceeded(control, config) || control.reservedInviteCount < 1) return control
  const active = await queryAll('meal_invites', { active: true })
  const candidates = active
    .filter((invite) => Number(invite.usedCount || 0) < Number(invite.maxUses || 1))
    .sort((left, right) => (
      inviteOrderValue(right.createdAt) - inviteOrderValue(left.createdAt)
      || inviteOrderValue(right.expiresAt) - inviteOrderValue(left.expiresAt)
      || String(right._id || '').localeCompare(String(left._id || ''))
    ))
  for (const invite of candidates) {
    await revokeExcessInvite(invite._id)
    const fresh = assertOperationalControl(await ensureControl())
    if (!capacityExceeded(fresh, config) || fresh.reservedInviteCount < 1) return fresh
  }
  return assertOperationalControl(await ensureControl())
}

async function upgradeControlConfiguration() {
  return db.runTransaction(async (transaction) => {
    const controlReference = transaction.collection('meal_members').doc(CONTROL_ID)
    const rawControl = await readDocument(controlReference)
    const control = assertOperationalControl(rawControl)
    if (
      Number(rawControl.inviteSlots) === config.inviteSlots
      && Number(rawControl.inviteTtlHours) === config.inviteTtlHours
    ) return control
    const next = reviseOperationalControl(control)
    await controlReference.update({ data: {
      ...next, inviteSlots: config.inviteSlots, inviteTtlHours: config.inviteTtlHours,
      updatedAt: db.serverDate(),
    } })
    return next
  })
}

async function reconcileInvites() {
  await cleanupExpiredInvites()
  await cleanupExcessInvites()
  return upgradeControlConfiguration()
}

async function status(openid) {
  assertOperationalControl(await ensureControl())
  await reconcileInvites()
  const member = await ensureMemberIdentity(openid, await readMember(openid))
  const control = assertOperationalControl(await ensureControl())
  return safeMember(member, control)
}

async function uniqueInvite() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomHex(16).toUpperCase()
    const hash = codeHash(code)
    const result = await invites.where({ codeHash: hash }).limit(1).get()
    if (!result.data.length) return { id: randomHex(16), code, hash }
  }
  const error = new Error('无法生成邀请码，请重试')
  error.code = 'INVITE_CREATE_FAILED'
  throw error
}

async function createInvite(openid, label) {
  await requireOwner(openid)
  await reconcileInvites()
  const invitation = await uniqueInvite()
  const now = Date.now()
  const expiresAt = now + config.inviteTtlMs
  await db.runTransaction(async (transaction) => {
    const controlReference = transaction.collection('meal_members').doc(CONTROL_ID)
    const ownerReference = transaction.collection('meal_members').doc(openid)
    const inviteReference = transaction.collection('meal_invites').doc(invitation.id)
    const rawControl = await readDocument(controlReference)
    assertOperationalControl(rawControl, config)
    const owner = await readDocument(ownerReference)
    const existingInvite = await readDocument(inviteReference)
    if (!owner || owner.status !== 'active' || owner.role !== 'owner' || normalizeControl(rawControl).ownerOpenid !== openid) {
      const error = new Error('只有当前管理员可以创建邀请')
      error.code = 'OWNER_REQUIRED'
      throw error
    }
    if (existingInvite) throw new Error('邀请码冲突，请重试')
    const next = reserveInvite(rawControl, config)
    await inviteReference.set({ data: {
      codeHash: invitation.hash, label: clean(label, 20), active: true,
      maxUses: 1, usedCount: 0, createdBy: openid, createdAt: db.serverDate(), updatedAt: db.serverDate(), expiresAt,
    } })
    await controlReference.update({ data: {
      ...next, inviteSlots: config.inviteSlots, inviteTtlHours: config.inviteTtlHours, updatedAt: db.serverDate(),
    } })
  })
  return { inviteRef: invitation.id, code: invitation.code, expiresAt }
}

async function revokeInvite(openid, inviteRef) {
  await requireOwner(openid)
  await reconcileInvites()
  const targetRef = typeof inviteRef === 'string' ? inviteRef.trim().toLowerCase() : ''
  if (!isInviteRef(targetRef)) {
    const error = new Error('邀请引用无效')
    error.code = 'INVITE_REFERENCE_INVALID'
    throw error
  }
  await ensureControl()
  return db.runTransaction(async (transaction) => {
    const controlReference = transaction.collection('meal_members').doc(CONTROL_ID)
    const ownerReference = transaction.collection('meal_members').doc(openid)
    const inviteReference = transaction.collection('meal_invites').doc(targetRef)
    const rawControl = await readDocument(controlReference)
    assertOperationalControl(rawControl, config)
    const owner = await readDocument(ownerReference)
    const invite = await readDocument(inviteReference)
    if (!owner || owner.status !== 'active' || owner.role !== 'owner'
      || normalizeControl(rawControl).ownerOpenid !== openid) {
      const error = new Error('只有当前管理员可以撤销邀请')
      error.code = 'OWNER_REQUIRED'
      throw error
    }
    if (!invite) {
      const error = new Error('邀请引用无效')
      error.code = 'INVITE_REFERENCE_INVALID'
      throw error
    }
    const used = Number(invite.usedCount || 0) >= Number(invite.maxUses || 1)
    if (invite.active !== true || used) return { revoked: false }
    const next = releaseInvite(rawControl)
    const expired = inviteExpired(invite.expiresAt)
    await inviteReference.update({ data: {
      active: false,
      ...(expired ? { expiredAt: db.serverDate() } : { revokedAt: db.serverDate() }),
      updatedAt: db.serverDate(),
    } })
    await controlReference.update({ data: {
      ...next, inviteSlots: config.inviteSlots, inviteTtlHours: config.inviteTtlHours, updatedAt: db.serverDate(),
    } })
    return { revoked: !expired }
  })
}

async function acceptInvite(openid, code) {
  assertOperationalControl(await ensureControl())
  const current = await ensureMemberIdentity(openid, await readMember(openid))
  assertReactivationAllowed(current)
  await reconcileInvites()
  if (current && current.status === 'active') {
    return safeMember(current, assertOperationalControl(await ensureControl()))
  }
  const hash = codeHash(code)
  const result = await invites.where({ codeHash: hash, active: true }).limit(2).get()
  if (result.data.length !== 1) {
    const error = new Error('邀请码无效或已过期')
    error.code = 'INVITE_INVALID'
    throw error
  }
  const invitation = result.data[0]
  if (inviteExpired(invitation.expiresAt)) {
    await expireInvite(invitation._id)
    const error = new Error('邀请码无效或已过期')
    error.code = 'INVITE_INVALID'
    throw error
  }
  const memberRef = await uniqueMemberRef()
  const cacheNamespace = isCacheNamespace(current && current.cacheNamespace) ? current.cacheNamespace : randomHex(16)
  await db.runTransaction(async (transaction) => {
    const controlReference = transaction.collection('meal_members').doc(CONTROL_ID)
    const inviteReference = transaction.collection('meal_invites').doc(invitation._id)
    const memberReference = transaction.collection('meal_members').doc(openid)
    const rawControl = await readDocument(controlReference)
    assertOperationalControl(rawControl, config)
    const freshInvite = await readDocument(inviteReference)
    const transactionMember = await readDocument(memberReference)
    assertReactivationAllowed(transactionMember)
    if (transactionMember && transactionMember.status === 'active') return
    if (!freshInvite || freshInvite.active !== true || freshInvite.codeHash !== hash
      || inviteExpired(freshInvite.expiresAt)
      || Number(freshInvite.usedCount || 0) >= Number(freshInvite.maxUses || 1)) {
      const error = new Error('邀请码无效、已过期或已被使用')
      error.code = 'INVITE_INVALID'
      throw error
    }
    const next = consumeInvite(rawControl, config)
    await inviteReference.update({ data: {
      usedCount: 1, active: false, usedAt: db.serverDate(), usedBy: openid, updatedAt: db.serverDate(),
    } })
    await memberReference.set({ data: {
      status: 'active', role: 'member', memberRef,
      cacheNamespace, inviteId: invitation._id, displayLabel: clean(freshInvite.label, 20),
      joinedAt: db.serverDate(), updatedAt: db.serverDate(),
    } })
    await controlReference.update({ data: {
      ...next, inviteSlots: config.inviteSlots, inviteTtlHours: config.inviteTtlHours, updatedAt: db.serverDate(),
    } })
  })
  return status(openid)
}

async function listMembers(openid) {
  await requireOwner(openid)
  await reconcileInvites()
  const active = await queryAll('meal_members', { status: 'active' })
  for (const member of active) await ensureMemberIdentity(member._id, member)
  await requireOwner(openid)
  const fresh = await queryAll('meal_members', { status: 'active' })
  const activeInvites = (await queryAll('meal_invites', { active: true }))
    .filter((invite) => (
      isInviteRef(invite._id)
      && !inviteExpired(invite.expiresAt)
      && Number(invite.usedCount || 0) < Number(invite.maxUses || 1)
    ))
    .sort((left, right) => Number(left.expiresAt || 0) - Number(right.expiresAt || 0))
  await requireOwner(openid)
  const ordered = fresh.sort((left, right) => (left.role === 'owner' ? -1 : right.role === 'owner' ? 1 : 0))
  const control = assertOperationalControl(await ensureControl())
  return {
    count: ordered.length,
    maxMembers: config.maxMembers,
    inviteSlots: config.inviteSlots,
    inviteTtlHours: config.inviteTtlHours,
    capacityExceeded: capacityExceeded(control, config),
    members: ordered.map((member, index) => publicMember(member, index)),
    activeInvites: activeInvites.map(publicInvite),
  }
}

async function transferOwner(openid, memberRef, confirmed) {
  if (confirmed !== true) {
    const error = new Error('请在客户端二次确认管理员转移')
    error.code = 'TRANSFER_CONFIRMATION_REQUIRED'
    throw error
  }
  await requireOwner(openid)
  await reconcileInvites()
  const targetRef = clean(memberRef, 32).toLowerCase()
  if (!isMemberRef(targetRef)) {
    const error = new Error('接任成员引用无效')
    error.code = 'TRANSFER_TARGET_INVALID'
    throw error
  }
  const result = await members.where({ memberRef: targetRef, status: 'active' }).limit(2).get()
  if (result.data.length !== 1) {
    const error = new Error('接任成员不存在或状态已变化')
    error.code = 'TRANSFER_TARGET_INVALID'
    throw error
  }
  const targetOpenid = result.data[0]._id
  await db.runTransaction(async (transaction) => {
    const controlReference = transaction.collection('meal_members').doc(CONTROL_ID)
    const ownerReference = transaction.collection('meal_members').doc(openid)
    const targetReference = transaction.collection('meal_members').doc(targetOpenid)
    const rawControl = await readDocument(controlReference)
    assertOperationalControl(rawControl, config)
    const owner = await readDocument(ownerReference)
    const target = await readDocument(targetReference)
    if (!owner || owner.status !== 'active' || owner.role !== 'owner') {
      const error = new Error('只有当前管理员可以转移管理员身份')
      error.code = 'OWNER_REQUIRED'
      throw error
    }
    if (!target || target.status !== 'active' || target.role !== 'member' || target.memberRef !== targetRef) {
      const error = new Error('接任成员不存在或状态已变化')
      error.code = 'TRANSFER_TARGET_INVALID'
      throw error
    }
    const next = transferOwnerControl(rawControl, openid, targetOpenid)
    await ownerReference.update({ data: { role: 'member', updatedAt: db.serverDate() } })
    await targetReference.update({ data: { role: 'owner', updatedAt: db.serverDate() } })
    await controlReference.update({ data: { ...next, updatedAt: db.serverDate() } })
  })
  return status(openid)
}

function publicError(error) {
  const messages = Object.freeze({
    MEMBERSHIP_INVALID: '成员操作无效',
    MEMBERSHIP_INVARIANT_FAILED: '成员数据状态异常，请联系管理员',
    MEMBERSHIP_FULL: '成员名额已满或已有待使用邀请码',
    OWNER_REQUIRED: '只有管理员可以管理成员',
    OWNER_ALREADY_ACTIVE: '管理员已激活，请使用成员邀请码',
    INVITE_INVALID: '邀请码无效或已过期',
    INVITE_CREATE_FAILED: '无法创建邀请码，请重试',
    MEMBER_REFERENCE_FAILED: '无法创建成员引用，请重试',
    MEMBER_REFERENCE_MISSING: '成员引用尚未初始化，请重试',
    TRANSFER_CONFIRMATION_REQUIRED: '请在客户端二次确认管理员转移',
    TRANSFER_TARGET_INVALID: '接任成员不存在或状态已变化',
    INVITE_REFERENCE_INVALID: '邀请不存在或状态已变化',
    ACCOUNT_DELETION_IN_PROGRESS: '账号数据正在删除，请等待完成后再重新加入',
    MEMBERSHIP_NOT_INITIALIZED: '成员服务尚未初始化，请联系管理员',
    MEMBERSHIP_BOOTSTRAP_IN_PROGRESS: '管理员初始化正在进行，请稍后重试',
  })
  const requestedCode = error && error.code
  const known = typeof requestedCode === 'string'
    && Object.prototype.hasOwnProperty.call(messages, requestedCode)
  return known
    ? { code: requestedCode, message: messages[requestedCode] }
    : { code: 'MEMBERSHIP_FAILED', message: '成员服务暂时不可用，请重试' }
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success: false, code: 'IDENTITY_REQUIRED', message: '无法识别微信身份' }
  try {
    if (event.action === 'status') return { success: true, data: await status(OPENID) }
    if (event.action === 'acceptInvite') return { success: true, data: await acceptInvite(OPENID, event.code) }
    if (event.action === 'createInvite') return { success: true, data: await createInvite(OPENID, event.label) }
    if (event.action === 'listMembers') return { success: true, data: await listMembers(OPENID) }
    if (event.action === 'revokeInvite') return { success: true, data: await revokeInvite(OPENID, event.inviteRef) }
    if (event.action === 'transferOwner') return { success: true, data: await transferOwner(OPENID, event.memberRef, event.confirmed) }
    return { success: false, code: 'UNSUPPORTED_ACTION', message: '不支持的成员操作' }
  } catch (error) {
    console.error('membership failed', { code: error && error.code, name: error && error.name })
    return { success: false, ...publicError(error) }
  }
}

exports._test = {
  ensureControl, cleanupExpiredInvites, cleanupExcessInvites, reconcileInvites,
  revokeExcessInvite, upgradeControlConfiguration, publicError, inviteExpired,
  status, createInvite, acceptInvite, listMembers, revokeInvite, transferOwner, expireInvite,
}
