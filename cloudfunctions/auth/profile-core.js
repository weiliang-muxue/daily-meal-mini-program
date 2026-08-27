'use strict'

function fileId(value) {
  return typeof value === 'string' ? value : ''
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

module.exports = { planProfileUpdate, avatarTicketCleanupFiles }
