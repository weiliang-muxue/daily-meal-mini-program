'use strict'

const PROFILE_SCHEMA_VERSION = 2

function fileId(value) {
  return typeof value === 'string' ? value : ''
}

const RETIRED_PHONE_FIELDS = Object.freeze([
  'phoneBound', 'maskedPhone', 'phoneBoundAt', 'phoneNumber', 'purePhoneNumber', 'countryCode',
])

function profileMigration(current = {}, removeValue) {
  const data = { schemaVersion: PROFILE_SCHEMA_VERSION }
  if (removeValue !== undefined) {
    for (const field of RETIRED_PHONE_FIELDS) data[field] = removeValue
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
  RETIRED_PHONE_FIELDS,
  profileMigration,
  planProfileUpdate,
  avatarTicketCleanupFiles,
}
