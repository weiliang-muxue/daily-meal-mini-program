const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const { validateImageFile } = require('./image-file')
const { downloadImageSource, validMetadata } = require('./image-source')
const {
  PROFILE_SCHEMA_VERSION, phoneBindingFromResponse, profileMigration,
  planProfileUpdate, avatarTicketCleanupFiles,
} = require('./profile-core')
const { orphanPermanentPath, ticketCleanupClaimable, ticketConsumable } = require('./upload-ticket')
const { notFound } = require('./not-found')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const command = db.command
const users = db.collection('meal_users')
const avatarUploads = db.collection('meal_avatar_uploads')
const members = db.collection('meal_members')
const MAX_AVATAR_BYTES = 1024 * 1024
const UPLOAD_TICKET_TTL_MS = 15 * 60 * 1000
const UPLOAD_LEASE_MS = 120 * 1000
const CLEANUP_CLAIM_TTL_MS = 60 * 1000
const CACHE_NAMESPACE_PATTERN = /^[a-f0-9]{32}$/
const AUTH_ERROR_MESSAGES = Object.freeze({
  ACCOUNT_DELETION_IN_PROGRESS: '账号数据正在删除，请稍后再试',
  MEMBERSHIP_REQUIRED: '需要有效邀请才能使用',
  IMAGE_METADATA_INVALID: '头像文件信息无效，请重新选择',
  IMAGE_SOURCE_INVALID: '头像临时地址无效，请重新选择',
  IMAGE_SOURCE_UNAVAILABLE: '头像读取失败，请重新选择',
  IMAGE_CONTENT_MISMATCH: '头像内容发生变化，请重新选择',
  IMAGE_TOO_LARGE: '头像不能超过 1 MB',
  PHONE_CODE_REQUIRED: '请重新点击绑定手机号',
  PHONE_CODE_INVALID: '手机号授权已失效，请重新点击绑定',
  PHONE_BIND_UNAVAILABLE: '暂时无法绑定手机号，可稍后重试，不影响其他功能',
  STALE_DATA_GENERATION: '账号数据版本已变化，请刷新后重试',
})
const AUTH_REQUEST_MESSAGES = new Set([
  '头像上传凭证已失效，请重新选择',
  '头像文件清理失败，请稍后重试',
  '用户档案不存在，请重新登录',
  '头像为空，请重新选择',
  '头像不能超过 1 MB',
  '头像必须是 JPG、PNG 或 WebP 图片',
])

function publicAuthFailure(error) {
  const code = typeof (error && error.code) === 'string' ? error.code : ''
  if (Object.prototype.hasOwnProperty.call(AUTH_ERROR_MESSAGES, code)) {
    return { code, message: AUTH_ERROR_MESSAGES[code] }
  }
  const message = typeof (error && error.message) === 'string' ? error.message : ''
  if (AUTH_REQUEST_MESSAGES.has(message)) return { code: 'AUTH_REQUEST_INVALID', message }
  return { code: 'AUTH_FAILED', message: '账号服务暂时不可用' }
}

async function requireMember(openid, expectedCacheNamespace) {
  try {
    const member = (await members.doc(openid).get()).data
    if (member && member.status === 'active') {
      assertExpectedCacheNamespace(member, expectedCacheNamespace)
      return member
    }
    throw membershipError(member)
  } catch (error) {
    if (error && [
      'ACCOUNT_DELETION_IN_PROGRESS', 'MEMBERSHIP_REQUIRED', 'STALE_DATA_GENERATION',
    ].includes(error.code)) throw error
    throw membershipError(null)
  }
}

function membershipError(member) {
  const deleting = member && member.status === 'deleting'
  const error = new Error(deleting ? '账号数据正在删除，请稍后再试' : '需要有效邀请才能使用')
  error.code = deleting ? 'ACCOUNT_DELETION_IN_PROGRESS' : 'MEMBERSHIP_REQUIRED'
  return error
}

function staleDataGenerationError() {
  const error = new Error('账号数据版本已变化，请刷新后重试')
  error.code = 'STALE_DATA_GENERATION'
  return error
}

function assertExpectedCacheNamespace(member, expectedCacheNamespace) {
  if (!CACHE_NAMESPACE_PATTERN.test(expectedCacheNamespace || '')
    || !CACHE_NAMESPACE_PATTERN.test(member && member.cacheNamespace || '')
    || member.cacheNamespace !== expectedCacheNamespace) {
    throw staleDataGenerationError()
  }
  return expectedCacheNamespace
}

function assertAvatarTicketCacheNamespace(ticket, expectedCacheNamespace) {
  if (!ticket || !CACHE_NAMESPACE_PATTERN.test(ticket.cacheNamespace || '')
    || ticket.cacheNamespace !== expectedCacheNamespace) {
    throw staleDataGenerationError()
  }
  return ticket
}

function safeText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

async function publicProfile(user = {}) {
  let avatarUrl = ''
  if (user.avatarFileId) {
    const result = await cloud.getTempFileURL({ fileList: [user.avatarFileId] }).catch(() => null)
    avatarUrl = result && result.fileList && result.fileList[0] && result.fileList[0].tempFileURL || ''
  }
  return {
    nickname: safeText(user.nickname, 20),
    avatarUrl,
    profileComplete: Boolean(safeText(user.nickname, 20)),
    phoneBound: user.phoneBound === true && /^\*{4}\d{4}$/.test(user.maskedPhone || ''),
    maskedPhone: user.phoneBound === true && /^\*{4}\d{4}$/.test(user.maskedPhone || '') ? user.maskedPhone : '',
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
  }
}

async function readUser(openid) {
  try { return (await users.doc(openid).get()).data || null }
  catch (error) {
    if (notFound(error)) return null
    throw error
  }
}

async function withActiveMemberTransaction(openid, expectedCacheNamespace, operation) {
  return db.runTransaction(async (transaction) => {
    let member = null
    try {
      member = (await transaction.collection('meal_members').doc(openid).get()).data || null
    } catch (error) {
      if (!notFound(error)) throw error
    }
    if (!member || member.status !== 'active') throw membershipError(member)
    assertExpectedCacheNamespace(member, expectedCacheNamespace)
    return operation(transaction, member)
  })
}

async function updateAvatarTicket(openid, token, data, expectedStates = [], expectedCacheNamespace) {
  return withActiveMemberTransaction(openid, expectedCacheNamespace, async (transaction) => {
    const reference = transaction.collection('meal_avatar_uploads').doc(token)
    let ticket = null
    try { ticket = (await reference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
    if (!ticket || ticket.owner !== openid) throw new Error('头像上传凭证已失效，请重新选择')
    assertAvatarTicketCacheNamespace(ticket, expectedCacheNamespace)
    if (expectedStates.length && !expectedStates.includes(ticket.state)) throw new Error('头像上传凭证已失效，请重新选择')
    await reference.update({ data })
    return { ...ticket, ...data }
  })
}

async function deletePrivateFiles(fileIds) {
  const fileList = [...new Set(fileIds.filter((fileID) => typeof fileID === 'string' && fileID.startsWith('cloud://')))]
  if (!fileList.length) return
  const result = await cloud.deleteFile({ fileList })
  const failed = (result && Array.isArray(result.fileList) ? result.fileList : []).filter((item) => (
    Number(item.status) !== 0 && !notFound({ message: item.errMsg })
  ))
  if (failed.length) throw new Error('头像文件清理失败，请稍后重试')
}

async function claimAvatarTicketCleanup(openid, token) {
  return db.runTransaction(async (transaction) => {
    const ticketReference = transaction.collection('meal_avatar_uploads').doc(token)
    let ticket = null
    try { ticket = (await ticketReference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
    const now = Date.now()
    if (ticket && ticket.state === 'uploading') {
      if (!Number.isSafeInteger(ticket.uploadLeaseExpiresAtMs)
        || ticket.uploadLeaseExpiresAtMs > now) return null
    } else if (!ticketCleanupClaimable(ticket, openid, now, CLEANUP_CLAIM_TTL_MS)) return null
    const memberReference = transaction.collection('meal_members').doc(openid)
    let member = null
    try { member = (await memberReference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
    if (!member || member.status !== 'active') throw membershipError(member)
    assertExpectedCacheNamespace(member, ticket.cacheNamespace)
    assertAvatarTicketCacheNamespace(ticket, member.cacheNamespace)

    const profileReference = transaction.collection('meal_users').doc(openid)
    let profile = null
    try { profile = (await profileReference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
    const activeAvatarFileId = profile && profile.avatarFileId || ''
    const files = avatarTicketCleanupFiles(ticket, activeAvatarFileId)
    const orphanPath = orphanPermanentPath(ticket, { kind: 'avatar', owner: openid, token })
    await ticketReference.update({ data: {
      state: 'cleaning', cleanupReady: true,
      cleanupClaimedAt: db.serverDate(), cleanupClaimedAtMs: Date.now(),
    } })
    return { files, orphanPath, cacheNamespace: ticket.cacheNamespace }
  })
}

async function reclaimOrphanPath(path) {
  if (!path) return
  const placeholder = await cloud.uploadFile({ cloudPath: path, fileContent: Buffer.from([0]) })
  await deletePrivateFiles([placeholder.fileID])
}

async function removeCleanedAvatarTicket(openid, token, expectedCacheNamespace) {
  return withActiveMemberTransaction(openid, expectedCacheNamespace, async (transaction) => {
    const reference = transaction.collection('meal_avatar_uploads').doc(token)
    let ticket = null
    try { ticket = (await reference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
    if (!ticket) return false
    if (ticket.owner !== openid || ticket.state !== 'cleaning') {
      throw new Error('头像上传凭证已失效，请重新选择')
    }
    assertAvatarTicketCacheNamespace(ticket, expectedCacheNamespace)
    await reference.remove()
    return true
  })
}

async function cleanupAvatarTicket(openid, token) {
  const claim = await claimAvatarTicketCleanup(openid, token)
  if (!claim) return false
  await deletePrivateFiles(claim.files)
  await reclaimOrphanPath(claim.orphanPath)
  await removeCleanedAvatarTicket(openid, token, claim.cacheNamespace)
  return true
}

async function cleanupAvatarTickets(openid, expectedCacheNamespace) {
  const result = await avatarUploads.where({ owner: openid, cacheNamespace: expectedCacheNamespace }).limit(20).get()
  for (const ticket of result.data) await cleanupAvatarTicket(openid, ticket._id)
}

async function publicProfileForGeneration(openid, expectedCacheNamespace) {
  const user = await withActiveMemberTransaction(openid, expectedCacheNamespace, async (transaction) => {
    const reference = transaction.collection('meal_users').doc(openid)
    try { return (await reference.get()).data || null } catch (error) { if (notFound(error)) return null; throw error }
  })
  const profile = await publicProfile(user || {})
  await requireMember(openid, expectedCacheNamespace)
  return profile
}

async function login(openid, unionid, expectedCacheNamespace) {
  await withActiveMemberTransaction(openid, expectedCacheNamespace, async (transaction) => {
    const reference = transaction.collection('meal_users').doc(openid)
    let current = null
    try { current = (await reference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
    if (!current) {
      const data = {
        schemaVersion: PROFILE_SCHEMA_VERSION, nickname: '', avatarFileId: '',
        phoneBound: false, maskedPhone: '', phoneBoundAt: null,
        unionid: unionid || '', loginCount: 1,
        createdAt: db.serverDate(), updatedAt: db.serverDate(), lastLoginAt: db.serverDate(),
      }
      await reference.set({ data })
      return
    }
    const data = {
      ...profileMigration(current, command.remove()),
      loginCount: command.inc(1), lastLoginAt: db.serverDate(), updatedAt: db.serverDate(),
    }
    if (unionid && !current.unionid) data.unionid = unionid
    await reference.update({ data })
  })
  await cleanupAvatarTickets(openid, expectedCacheNamespace)
    .catch((error) => console.error('avatar cleanup failed', { name: error && error.name }))
  return publicProfileForGeneration(openid, expectedCacheNamespace)
}

function phoneApiFailure(error) {
  const rawCode = Number(error && (error.errCode !== undefined ? error.errCode : error.code))
  const failure = new Error('暂时无法绑定手机号')
  failure.code = [40029, 40163].includes(rawCode) ? 'PHONE_CODE_INVALID' : 'PHONE_BIND_UNAVAILABLE'
  return failure
}

async function bindPhoneNumber(openid, rawCode, expectedCacheNamespace) {
  const code = safeText(rawCode, 256)
  if (!code) {
    const error = new Error('请重新点击绑定手机号')
    error.code = 'PHONE_CODE_REQUIRED'
    throw error
  }

  await requireMember(openid, expectedCacheNamespace)
  let binding
  try {
    const response = await cloud.openapi.phonenumber.getPhoneNumber({ code, openid })
    const errCode = Number(response && response.errCode)
    if (Number.isFinite(errCode) && errCode !== 0) throw Object.assign(new Error('phone api failed'), { errCode })
    binding = phoneBindingFromResponse(response)
  } catch (error) {
    if (error && error.code === 'PHONE_BIND_UNAVAILABLE') throw error
    throw phoneApiFailure(error)
  }

  await withActiveMemberTransaction(openid, expectedCacheNamespace, async (transaction) => {
    const reference = transaction.collection('meal_users').doc(openid)
    let current = null
    try { current = (await reference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
    if (!current) throw new Error('用户档案不存在，请重新登录')
    await reference.update({ data: {
      ...profileMigration(current, command.remove()),
      ...binding,
      phoneBoundAt: db.serverDate(),
      updatedAt: db.serverDate(),
    } })
  })
  return publicProfileForGeneration(openid, expectedCacheNamespace)
}

async function prepareAvatar(openid, imageInput, expectedCacheNamespace) {
  await cleanupAvatarTickets(openid, expectedCacheNamespace)
    .catch((error) => console.error('avatar cleanup failed', { name: error && error.name }))
  const metadata = validMetadata(imageInput, MAX_AVATAR_BYTES, '头像')
  const token = crypto.randomBytes(24).toString('hex')
  const ownerHash = crypto.createHash('sha256').update(openid).digest('hex').slice(0, 24)
  const permanentPath = `avatars/${ownerHash}/${token}`
  await withActiveMemberTransaction(openid, expectedCacheNamespace, async (transaction) => {
    await transaction.collection('meal_avatar_uploads').doc(token).set({
      data: {
        owner: openid, cacheNamespace: expectedCacheNamespace,
        state: 'prepared', permanentPath,
        expectedSize: metadata.size, expectedSha256: metadata.sha256,
        cleanupReady: false, expiresAt: Date.now() + UPLOAD_TICKET_TTL_MS,
        createdAt: db.serverDate(), updatedAt: db.serverDate(),
      },
    })
  })
  return { token, permanentPath }
}

async function finalizeAvatar(openid, imageInput, expectedCacheNamespace) {
  const prepared = await prepareAvatar(openid, imageInput, expectedCacheNamespace)
  let uploadedFileId = ''
  let cloudPath = ''
  let uploadAttempted = false
  try {
    const source = await downloadImageSource(imageInput, { maxBytes: MAX_AVATAR_BYTES, label: '头像' })
    const image = validateImageFile(source, { maxBytes: MAX_AVATAR_BYTES, label: '头像' })
    cloudPath = `${prepared.permanentPath}.${image.extension}`
    const uploadStartedAtMs = Date.now()
    const uploading = await updateAvatarTicket(openid, prepared.token, {
      state: 'uploading', permanentPath: cloudPath,
      uploadStartedAtMs, uploadLeaseExpiresAtMs: uploadStartedAtMs + UPLOAD_LEASE_MS,
      updatedAt: db.serverDate(),
    }, ['prepared'], expectedCacheNamespace)
    uploadAttempted = true
    const uploaded = await cloud.uploadFile({
      cloudPath: uploading.permanentPath, fileContent: image.fileContent,
    })
    uploadedFileId = uploaded.fileID
    await updateAvatarTicket(openid, prepared.token, {
      state: 'staged', permanentFileId: uploaded.fileID,
      uploadStartedAtMs: command.remove(), uploadLeaseExpiresAtMs: command.remove(),
      updatedAt: db.serverDate(),
    }, ['uploading'], expectedCacheNamespace)
    return { fileID: uploaded.fileID, token: prepared.token }
  } catch (error) {
    if (uploadedFileId) await deletePrivateFiles([uploadedFileId]).catch(() => {})
    if (uploadAttempted && cloudPath) await reclaimOrphanPath(cloudPath).catch(() => {})
    if (!uploadAttempted) {
      await updateAvatarTicket(openid, prepared.token, {
        state: 'cleanup', cleanupReady: true, updatedAt: db.serverDate(),
      }, ['prepared'], expectedCacheNamespace).catch(() => {})
      await cleanupAvatarTicket(openid, prepared.token).catch(() => {})
    }
    throw error
  }
}

async function commitProfileUpdate(openid, nickname, uploadedAvatarFileId, avatarTicketToken, expectedCacheNamespace) {
  return withActiveMemberTransaction(openid, expectedCacheNamespace, async (transaction) => {
    const reference = transaction.collection('meal_users').doc(openid)
    let current = null
    try { current = (await reference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
    if (!current) throw new Error('用户档案不存在，请重新登录')

    const planned = planProfileUpdate(current, { nickname, uploadedAvatarFileId })
    if (uploadedAvatarFileId) {
      const ticketReference = transaction.collection('meal_avatar_uploads').doc(avatarTicketToken)
      let ticket = null
      try { ticket = (await ticketReference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
      assertAvatarTicketCacheNamespace(ticket, expectedCacheNamespace)
      if (!ticketConsumable(ticket, {
        owner: openid, fileId: uploadedAvatarFileId,
      }, Date.now())) {
        throw new Error('头像上传凭证已失效，请重新选择')
      }
      await ticketReference.update({
        data: {
          state: 'consumed', permanentFileId: '', permanentPath: '',
          cleanupFileId: planned.replacedAvatarFileId,
          cleanupReady: true, consumedAt: db.serverDate(), updatedAt: db.serverDate(),
        },
      })
    }

    await reference.update({ data: { ...planned.data, updatedAt: db.serverDate() } })
    return planned
  })
}

async function compensateAvatarUpdate(openid, avatarTicketToken, uploadedAvatarFileId, expectedCacheNamespace) {
  if (avatarTicketToken) {
    await updateAvatarTicket(openid, avatarTicketToken, {
      cleanupReady: true, updatedAt: db.serverDate(),
    }, [], expectedCacheNamespace).catch(() => {})
  }
  // cleanupAvatarTicket re-reads the active profile inside its claim transaction.
  // A separate read followed by delete would leave a race with another device.
  if (avatarTicketToken) await cleanupAvatarTicket(openid, avatarTicketToken).catch(() => {})
}

async function updateProfile(openid, input = {}, expectedCacheNamespace) {
  const nickname = safeText(input.nickname, 20)
  let uploadedAvatarFileId = ''
  let avatarTicketToken = ''
  try {
    if (input.avatarImage) {
      const finalized = await finalizeAvatar(openid, input.avatarImage, expectedCacheNamespace)
      uploadedAvatarFileId = finalized.fileID
      avatarTicketToken = finalized.token
    }
  } catch (error) {
    if (uploadedAvatarFileId) await deletePrivateFiles([uploadedAvatarFileId]).catch(() => {})
    if (avatarTicketToken) {
      await updateAvatarTicket(openid, avatarTicketToken, {
        state: 'cleanup', cleanupReady: true, updatedAt: db.serverDate(),
      }, [], expectedCacheNamespace).catch(() => {})
    }
    if (avatarTicketToken) await cleanupAvatarTicket(openid, avatarTicketToken).catch(() => {})
    throw error
  }
  try {
    await commitProfileUpdate(openid,
      nickname, uploadedAvatarFileId, avatarTicketToken, expectedCacheNamespace)
  } catch (error) {
    await compensateAvatarUpdate(
      openid, avatarTicketToken, uploadedAvatarFileId, expectedCacheNamespace,
    )
    throw error
  }
  if (avatarTicketToken) {
    await cleanupAvatarTicket(openid, avatarTicketToken).catch((error) => {
      console.error('old avatar cleanup failed', { name: error && error.name })
    })
  }
  return publicProfileForGeneration(openid, expectedCacheNamespace)
}

exports.main = async (event = {}) => {
  const context = cloud.getWXContext()
  const openid = context.OPENID
  if (!openid) return { success: false, message: '无法识别当前微信用户' }
  try {
    await requireMember(openid, event.expectedCacheNamespace)
    if (event.action === 'login') {
      return { success: true, data: await login(openid, context.UNIONID, event.expectedCacheNamespace) }
    }
    if (event.action === 'updateProfile') {
      return { success: true, data: await updateProfile(openid, event.profile, event.expectedCacheNamespace) }
    }
    if (event.action === 'bindPhoneNumber') {
      return { success: true, data: await bindPhoneNumber(openid, event.code, event.expectedCacheNamespace) }
    }
    return { success: false, message: '不支持的账号操作' }
  } catch (error) {
    const failure = publicAuthFailure(error)
    console.error('auth failed', { code: failure.code, name: error && error.name })
    return { success: false, ...failure }
  }
}
