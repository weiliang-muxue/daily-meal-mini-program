'use strict'

const crypto = require('crypto')

const TOKEN_PATTERN = /^[a-f0-9]{48}$/
const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const IMAGE_EXTENSION_PATTERN = /^(?:jpg|png|webp)$/

function safeNow(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : Date.now()
}

function cloudFileId(value) {
  return typeof value === 'string' && value.startsWith('cloud://') ? value : ''
}

function ticketConsumable(ticket, expectations = {}, currentTime = Date.now()) {
  const now = safeNow(currentTime)
  if (!ticket || typeof ticket !== 'object' || ticket.state !== 'staged' || ticket.cleanupReady === true) return false
  if (!Number.isSafeInteger(ticket.expiresAt) || ticket.expiresAt <= now) return false
  if (typeof expectations.owner === 'string' && ticket.owner !== expectations.owner) return false
  if (typeof expectations.fileId === 'string'
    && (ticket.permanentFileId !== expectations.fileId || !cloudFileId(expectations.fileId))) return false
  if (typeof expectations.targetDate === 'string' && ticket.targetDate !== expectations.targetDate) return false
  return true
}

function ticketCleanupClaimable(ticket, owner, currentTime = Date.now(), claimTtlMs = 60 * 1000) {
  const now = safeNow(currentTime)
  if (!ticket || typeof ticket !== 'object' || ticket.owner !== owner) return false
  const expired = !Number.isSafeInteger(ticket.expiresAt) || ticket.expiresAt <= now
  if (ticket.cleanupReady !== true && !expired) return false
  const ttl = Number.isSafeInteger(claimTtlMs) && claimTtlMs > 0 ? claimTtlMs : 60 * 1000
  if (ticket.state === 'cleaning' && Number.isSafeInteger(ticket.cleanupClaimedAtMs)
    && ticket.cleanupClaimedAtMs > now - ttl) return false
  return true
}

function ownerHash(owner) {
  if (typeof owner !== 'string' || !owner) return ''
  return crypto.createHash('sha256').update(owner).digest('hex').slice(0, 24)
}

function expectedPermanentBase(ticket, options = {}) {
  if (!ticket || typeof ticket !== 'object' || ticket.owner !== options.owner) return ''
  const token = typeof options.token === 'string' ? options.token : ticket._id
  const hash = ownerHash(options.owner)
  if (!hash || !TOKEN_PATTERN.test(token || '')) return ''
  if (options.kind === 'avatar') return `avatars/${hash}/${token}`
  if (options.kind !== 'health') return ''
  const targetDate = typeof options.targetDate === 'string' ? options.targetDate : ticket.targetDate
  if (!DATE_PATTERN.test(targetDate || '') || ticket.targetDate !== targetDate) return ''
  return `health-photos/${hash}/${targetDate}-${token}`
}

function validOwnedPermanentPath(value, ticket, options = {}) {
  if (typeof value !== 'string' || value.length > 220 || value.includes('..')) return false
  const base = expectedPermanentBase(ticket, options)
  if (!base) return false
  if (value === base) return true
  if (!value.startsWith(`${base}.`)) return false
  return IMAGE_EXTENSION_PATTERN.test(value.slice(base.length + 1))
}

function orphanPermanentPath(ticket, options = {}) {
  if (!ticket || ticket.state === 'consumed' || cloudFileId(ticket.permanentFileId)) return ''
  return validOwnedPermanentPath(ticket.permanentPath, ticket, options) ? ticket.permanentPath : ''
}

module.exports = {
  cloudFileId,
  orphanPermanentPath,
  ownerHash,
  ticketCleanupClaimable,
  ticketConsumable,
  validOwnedPermanentPath,
}
