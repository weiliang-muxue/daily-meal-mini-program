'use strict'

const { orphanPermanentPath, validOwnedPermanentPath } = require('./upload-ticket')

const AI_PRIVATE_COLLECTIONS = ['meal_ai_tasks', 'meal_ai_shards', 'meal_ai_controls']
const UPLOAD_FILE_FIELDS = ['inboxFileId', 'permanentFileId', 'cleanupFileId', 'fileID', 'fileId']
const UPLOAD_LEASE_MS = 120 * 1000
const LEGACY_UPLOAD_GRACE_MS = 120 * 1000
const TOKEN_PATTERN = /^[a-f0-9]{48}$/
const LEGACY_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp'])
const PERMANENT_OBJECT_EXTENSION_PATTERN = /\.(?:jpg|png|webp)$/
const TICKET_STATES = new Set(['prepared', 'uploading', 'staged', 'consumed', 'cleanup', 'cleaning'])

function activeMembers(records, excludedId) {
  return (Array.isArray(records) ? records : [])
    .filter((item) => item && item._id !== excludedId && item.status === 'active')
}

function deletionMembershipState(records, excludedId) {
  const active = activeMembers(records, excludedId)
  const deleting = (Array.isArray(records) ? records : []).find((item) => item && item._id === excludedId)
  const owners = (Array.isArray(records) ? records : []).filter((item) => item && item.status === 'active' && item.role === 'owner')
  if (owners.length !== 1 && deleting && deleting.status === 'active') {
    const error = new Error('成员数据存在多个管理员，无法安全删除账号')
    error.code = 'MEMBERSHIP_INVARIANT_FAILED'
    throw error
  }
  return {
    active,
    deletingIsOwner: Boolean(deleting && deleting.status === 'active' && deleting.role === 'owner'),
    transferRequired: Boolean(deleting && deleting.status === 'active' && deleting.role === 'owner' && active.length),
  }
}

function membershipError(message, code) {
  const error = new Error(message)
  error.code = code
  throw error
}

function controlInteger(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : -1
}

function validateDeletionControl(records, excludedId, control) {
  const all = Array.isArray(records) ? records : []
  const active = all.filter((item) => item && item.status === 'active')
  const deleting = active.find((item) => item._id === excludedId)
  if (!deleting) return { deletingIsOwner: false, activeCount: active.length }

  const deletion = deletionMembershipState(all, excludedId)
  if (deletion.transferRequired) {
    membershipError('请先将管理员身份明确转移给另一名成员，再删除账号', 'OWNER_TRANSFER_REQUIRED')
  }

  const activeMemberCount = controlInteger(control && control.activeMemberCount)
  const reservedInviteCount = controlInteger(control && control.reservedInviteCount)
  const ownerOpenid = control && typeof control.ownerOpenid === 'string' ? control.ownerOpenid : ''
  const owner = active.find((item) => item.role === 'owner')
  if (activeMemberCount !== active.length || reservedInviteCount < 0 || !owner || ownerOpenid !== owner._id) {
    membershipError('成员状态已变化，请重试删除', 'MEMBERSHIP_INVARIANT_FAILED')
  }
  if (deletion.deletingIsOwner && (activeMemberCount !== 1 || reservedInviteCount !== 0)) {
    membershipError('仍有成员或待使用邀请码，请重试删除', 'MEMBERSHIP_INVARIANT_FAILED')
  }
  return { deletingIsOwner: deletion.deletingIsOwner, activeCount: activeMemberCount }
}

function uniqueById(records) {
  const result = []
  const ids = new Set()
  ;(Array.isArray(records) ? records : []).forEach((item) => {
    if (!item || typeof item._id !== 'string' || !item._id || ids.has(item._id)) return
    ids.add(item._id)
    result.push(item)
  })
  return result
}

function relatedInvite(invite, openid) {
  return Boolean(invite) && (invite.createdBy === openid || invite.usedBy === openid)
}

function ticketFileIds(records) {
  const ids = new Set()
  ;(Array.isArray(records) ? records : []).forEach((record) => {
    if (!record || typeof record !== 'object') return
    UPLOAD_FILE_FIELDS.forEach((field) => {
      const value = record[field]
      if (typeof value === 'string' && value.startsWith('cloud://')) ids.add(value)
    })
  })
  return [...ids]
}

function privateFileIds(data = {}) {
  const ids = new Set([
    data.user && data.user.avatarFileId,
    ...(Array.isArray(data.health) ? data.health.map((item) => item && item.photoFileId) : []),
    ...ticketFileIds(data.avatarTickets),
    ...ticketFileIds(data.photoTickets),
  ].filter((value) => typeof value === 'string' && value.startsWith('cloud://')))
  return [...ids]
}

function privateUploadError(code, message, retryable = false) {
  const error = new Error(message)
  error.code = code
  error.retryable = retryable
  return error
}

function invalidUploadTicket() {
  return privateUploadError('PRIVATE_UPLOAD_STATE_INVALID', '私人图片清理状态异常，请稍后重试')
}

function legacyInboxPath(ticket, options = {}) {
  if (!ticket || ticket.owner !== options.owner || !TOKEN_PATTERN.test(options.token || '')) return ''
  const extension = typeof ticket.extension === 'string' ? ticket.extension.trim().toLowerCase() : ''
  if (!LEGACY_IMAGE_EXTENSIONS.has(extension)) return ''
  if (options.kind === 'avatar') return `avatar-inbox/${options.token}.${extension}`
  if (options.kind === 'health') return `health-inbox/${options.token}.${extension}`
  return ''
}

function privateUploadCleanupPlan(data = {}, openid = '', currentTime = Date.now()) {
  const now = Number.isSafeInteger(currentTime) && currentTime >= 0 ? currentTime : Date.now()
  const paths = new Set()
  let uploadInProgress = false

  const inspect = (ticket, options) => {
    if (!ticket || typeof ticket !== 'object' || ticket.owner !== openid
      || !TOKEN_PATTERN.test(ticket._id || '')) throw invalidUploadTicket()
    if (ticket.state !== undefined && !TICKET_STATES.has(ticket.state)) throw invalidUploadTicket()
    if (ticket.permanentPath !== undefined && ticket.permanentPath !== ''
      && !validOwnedPermanentPath(ticket.permanentPath, ticket, options)) {
      throw invalidUploadTicket()
    }

    if (ticket.state === 'uploading') {
      if (!PERMANENT_OBJECT_EXTENSION_PATTERN.test(ticket.permanentPath || '')
        || !Number.isSafeInteger(ticket.uploadStartedAtMs) || ticket.uploadStartedAtMs < 0
        || !Number.isSafeInteger(ticket.uploadLeaseExpiresAtMs)
        || ticket.uploadLeaseExpiresAtMs - ticket.uploadStartedAtMs !== UPLOAD_LEASE_MS) {
        throw invalidUploadTicket()
      }
      if (ticket.uploadLeaseExpiresAtMs > now) uploadInProgress = true
    }

    const preparedUploadMayBeInFlight = ticket.state === 'prepared'
      && PERMANENT_OBJECT_EXTENSION_PATTERN.test(ticket.permanentPath || '')
    if (preparedUploadMayBeInFlight) {
      if (!Number.isSafeInteger(ticket.expiresAt) || ticket.expiresAt < 0
        || ticket.expiresAt > Number.MAX_SAFE_INTEGER - LEGACY_UPLOAD_GRACE_MS) {
        throw invalidUploadTicket()
      }
      if (ticket.expiresAt + LEGACY_UPLOAD_GRACE_MS > now) uploadInProgress = true
    }

    if (ticket.state === undefined) {
      const inboxPath = legacyInboxPath(ticket, options)
      if (!inboxPath || !Number.isSafeInteger(ticket.expiresAt) || ticket.expiresAt < 0
        || ticket.expiresAt > Number.MAX_SAFE_INTEGER - LEGACY_UPLOAD_GRACE_MS) {
        throw invalidUploadTicket()
      }
      if (ticket.expiresAt + LEGACY_UPLOAD_GRACE_MS > now) uploadInProgress = true
      paths.add(inboxPath)
    }

    const path = orphanPermanentPath(ticket, {
      ...options, owner: openid, token: ticket._id,
    })
    if (path) paths.add(path)
  }

  ;(Array.isArray(data.avatarTickets) ? data.avatarTickets : []).forEach((ticket) => {
    inspect(ticket, { kind: 'avatar', owner: openid, token: ticket && ticket._id })
  })
  ;(Array.isArray(data.photoTickets) ? data.photoTickets : []).forEach((ticket) => {
    inspect(ticket, {
      kind: 'health', owner: openid, token: ticket && ticket._id,
      targetDate: ticket && ticket.targetDate,
    })
  })

  if (uploadInProgress) {
    throw privateUploadError(
      'PRIVATE_UPLOAD_IN_PROGRESS', '私人图片仍在处理中，请稍后重试', true,
    )
  }
  return { orphanPaths: [...paths] }
}

function privateOrphanPaths(data = {}, openid = '', currentTime = Date.now()) {
  return privateUploadCleanupPlan(data, openid, currentTime).orphanPaths
}

async function runDeletionSequence(steps) {
  await steps.preflight()
  const activeInvites = await steps.listActiveOwnedInvites()
  for (const invite of activeInvites) await steps.deactivateInvite(invite)
  await steps.markMembershipDeleting()
  const privateData = await steps.collectPrivateData()
  const result = await steps.deletePrivateData(privateData)
  await steps.verifyCleared()
  const membership = await steps.finalizeMembership()
  return { ...result, ...membership }
}

module.exports = {
  AI_PRIVATE_COLLECTIONS,
  UPLOAD_FILE_FIELDS,
  activeMembers,
  deletionMembershipState,
  validateDeletionControl,
  uniqueById,
  relatedInvite,
  ticketFileIds,
  privateFileIds,
  legacyInboxPath,
  privateUploadCleanupPlan,
  privateOrphanPaths,
  runDeletionSequence,
}
