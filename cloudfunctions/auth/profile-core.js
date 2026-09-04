'use strict'

const PROFILE_SCHEMA_VERSION = 2

function fileId(value) {
  return typeof value === 'string' ? value : ''
}

function maskedPhone(value) {
  const digits = typeof value === 'string' ? value.replace(/\D/g, '') : ''
  return digits.length >= 4 ? `****${digits.slice(-4)}` : ''
}

function phoneBindingFromResponse(response = {}) {
  const phoneInfo = response && response.phoneInfo
  const phone = phoneInfo && (phoneInfo.purePhoneNumber || phoneInfo.phoneNumber)
  const masked = maskedPhone(phone)
  if (!masked) {
    const error = new Error('微信未返回可用手机号')
    error.code = 'PHONE_BIND_UNAVAILABLE'
    throw error
  }
  return { phoneBound: true, maskedPhone: masked }
}

function profileMigration(current = {}, removeValue) {
  const masked = typeof current.maskedPhone === 'string' && /^\*{4}\d{4}$/.test(current.maskedPhone)
    ? current.maskedPhone : ''
  const phoneBound = current.phoneBound === true && Boolean(masked)
  const data = {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    phoneBound,
    maskedPhone: phoneBound ? masked : '',
  }
  if (!phoneBound) data.phoneBoundAt = null
  if (removeValue !== undefined) {
    // Defensive cleanup for unsupported local experiments or pre-release fields.
    data.phoneNumber = removeValue
    data.purePhoneNumber = removeValue
    data.countryCode = removeValue
  }
  return data
}

function planProfileUpdate(current = {}, input = {}) {
  const data = {}
  if (Object.prototype.hasOwnProperty.call(input, 'nickname')) data.nickname = input.nickname

  const previousAvatarFileId = fileId(current.avatarFileId)
  const uploadedAvatarFileId = fileId(input.uploadedAvatarFileId)
  const activeAvatarFileId = uploadedAvatarFileId || previousAvatarFileId
  if (uploadedAvatarFileId) data.avatarFileId = uploadedAvatarFileId

  return {
    data,
    profile: { ...current, ...data },
    activeAvatarFileId,
    replacedAvatarFileId: uploadedAvatarFileId && uploadedAvatarFileId !== previousAvatarFileId
      ? previousAvatarFileId : '',
  }
}

function avatarTicketCleanupFiles(ticket = {}, activeAvatarFileId = '') {
  const active = fileId(activeAvatarFileId)
  return [...new Set([
    ticket.inboxFileId,
    ticket.permanentFileId,
    ticket.cleanupFileId,
  ].map(fileId).filter((candidate) => candidate && candidate !== active))]
}

module.exports = {
  PROFILE_SCHEMA_VERSION,
  maskedPhone,
  phoneBindingFromResponse,
  profileMigration,
  planProfileUpdate,
  avatarTicketCleanupFiles,
}
