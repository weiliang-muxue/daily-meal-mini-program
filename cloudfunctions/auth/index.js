const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const { validateImageFile } = require('./image-file')
const { downloadImageSource, validMetadata } = require('./image-source')
const { planProfileUpdate, avatarTicketCleanupFiles } = require('./profile-core')
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
const CLEANUP_CLAIM_TTL_MS = 60 * 1000
const AUTH_ERROR_MESSAGES = Object.freeze({
  ACCOUNT_DELETION_IN_PROGRESS: '账号数据正在删除，请稍后再试',
  MEMBERSHIP_REQUIRED: '需要有效邀请才能使用',
  IMAGE_METADATA_INVALID: '头像文件信息无效，请重新选择',
  IMAGE_SOURCE_INVALID: '头像临时地址无效，请重新选择',
  IMAGE_SOURCE_UNAVAILABLE: '头像读取失败，请重新选择',
  IMAGE_CONTENT_MISMATCH: '头像内容发生变化，请重新选择',
  IMAGE_TOO_LARGE: '头像不能超过 1 MB',
})
const AUTH_REQUEST_MESSAGES = new Set([
  '请填写昵称',
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

async function requireMember(openid) {
  try {
    const member = (await members.doc(openid).get()).data
    if (member && member.status === 'active') return member
    throw membershipError(member)
  } catch (error) {
    if (error && (error.code === 'ACCOUNT_DELETION_IN_PROGRESS' || error.code === 'MEMBERSHIP_REQUIRED')) throw error
    throw membershipError(null)
  }
}

function membershipError(member) {
  const deleting = member && member.status === 'deleting'
  const error = new Error(deleting ? '账号数据正在删除，请稍后再试' : '需要有效邀请才能使用')
  error.code = deleting ? 'ACCOUNT_DELETION_IN_PROGRESS' : 'MEMBERSHIP_REQUIRED'
  return error
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

async function withActiveMemberTransaction(openid, operation) {
  return db.runTransaction(async (transaction) => {
    let member = null
    try {
      member = (await transaction.collection('meal_members').doc(openid).get()).data || null
    } catch (error) {
      if (!notFound(error)) throw error
    }
    if (!member || member.status !== 'active') throw membershipError(member)
    return operation(transaction)
  })
}

async function updateAvatarTicket(openid, token, data, expectedStates = []) {
  return withActiveMemberTransaction(openid, async (transaction) => {
    const reference = transaction.collection('meal_avatar_uploads').doc(token)
    let ticket = null
    try { ticket = (await reference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
    if (!ticket || ticket.owner !== openid) throw new Error('头像上传凭证已失效，请重新选择')
    if (expectedStates.length && !expectedStates.includes(ticket.state)) throw new Error('头像上传凭证已失效，请重新选择')
    await reference.update({ data })
    return ticket
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
  return withActiveMemberTransaction(openid, async (transaction) => {
    const ticketReference = transaction.collection('meal_avatar_uploads').doc(token)
    let ticket = null
    try { ticket = (await ticketReference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
    if (!ticketCleanupClaimable(ticket, openid, Date.now(), CLEANUP_CLAIM_TTL_MS)) return null

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
    return { files, orphanPath }
  })
}

async function reclaimOrphanPath(path) {
  if (!path) return
  const placeholder = await cloud.uploadFile({ cloudPath: path, fileContent: Buffer.from([0]) })
  await deletePrivateFiles([placeholder.fileID])
}

async function cleanupAvatarTicket(openid, token) {
  const claim = await claimAvatarTicketCleanup(openid, token)
  if (!claim) return false
  await deletePrivateFiles(claim.files)
  await reclaimOrphanPath(claim.orphanPath)
  await avatarUploads.doc(token).remove().catch((error) => { if (!notFound(error)) throw error })
  return true
}

async function cleanupAvatarTickets(openid) {
  const result = await avatarUploads.where({ owner: openid }).limit(20).get()
  for (const ticket of result.data) await cleanupAvatarTicket(openid, ticket._id)
}

async function login(openid, unionid) {
  const result = await withActiveMemberTransaction(openid, async (transaction) => {
    const reference = transaction.collection('meal_users').doc(openid)
    let current = null
    try { current = (await reference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
    if (!current) {
      const data = {
        schemaVersion: 1, nickname: '', avatarFileId: '',
        unionid: unionid || '', loginCount: 1,
        createdAt: db.serverDate(), updatedAt: db.serverDate(), lastLoginAt: db.serverDate(),
      }
      await reference.set({ data })
      return { profile: data, activeAvatarFileId: '' }
    }
    const data = { loginCount: command.inc(1), lastLoginAt: db.serverDate(), updatedAt: db.serverDate() }
    if (unionid && !current.unionid) data.unionid = unionid
    await reference.update({ data })
    return { profile: current, activeAvatarFileId: current.avatarFileId || '' }
  })
  await cleanupAvatarTickets(openid).catch((error) => console.error('avatar cleanup failed', { name: error && error.name }))
  return publicProfile(result.profile)
}

async function prepareAvatar(openid, imageInput) {
  const metadata = validMetadata(imageInput, MAX_AVATAR_BYTES, '头像')
  const token = crypto.randomBytes(24).toString('hex')
  const ownerHash = crypto.createHash('sha256').update(openid).digest('hex').slice(0, 24)
  const permanentPath = `avatars/${ownerHash}/${token}`
  await withActiveMemberTransaction(openid, async (transaction) => {
    await transaction.collection('meal_avatar_uploads').doc(token).set({
      data: {
        owner: openid, state: 'prepared', permanentPath,
        expectedSize: metadata.size, expectedSha256: metadata.sha256,
        cleanupReady: false, expiresAt: Date.now() + UPLOAD_TICKET_TTL_MS,
        createdAt: db.serverDate(), updatedAt: db.serverDate(),
      },
    })
  })
  return { token, permanentPath }
}

async function finalizeAvatar(openid, imageInput) {
  const prepared = await prepareAvatar(openid, imageInput)
  let uploadedFileId = ''
  try {
    const source = await downloadImageSource(imageInput, { maxBytes: MAX_AVATAR_BYTES, label: '头像' })
    const image = validateImageFile(source, { maxBytes: MAX_AVATAR_BYTES, label: '头像' })
    const cloudPath = `${prepared.permanentPath}.${image.extension}`
    await updateAvatarTicket(openid, prepared.token, { permanentPath: cloudPath, updatedAt: db.serverDate() }, ['prepared'])
    const uploaded = await cloud.uploadFile({ cloudPath, fileContent: image.fileContent })
    uploadedFileId = uploaded.fileID
    await updateAvatarTicket(openid, prepared.token, {
      state: 'staged', permanentFileId: uploaded.fileID, updatedAt: db.serverDate(),
    }, ['prepared'])
    return { fileID: uploaded.fileID, token: prepared.token }
  } catch (error) {
    if (uploadedFileId) await deletePrivateFiles([uploadedFileId]).catch(() => {})
    await updateAvatarTicket(openid, prepared.token, {
      state: 'cleanup', cleanupReady: true, updatedAt: db.serverDate(),
    }).catch(() => {})
    await cleanupAvatarTicket(openid, prepared.token).catch(() => {})
    throw error
  }
}

async function commitProfileUpdate(openid, nickname, uploadedAvatarFileId, avatarTicketToken) {
  return withActiveMemberTransaction(openid, async (transaction) => {
    const reference = transaction.collection('meal_users').doc(openid)
    let current = null
    try { current = (await reference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
    if (!current) throw new Error('用户档案不存在，请重新登录')

    const planned = planProfileUpdate(current, { nickname, uploadedAvatarFileId })
    if (uploadedAvatarFileId) {
      const ticketReference = transaction.collection('meal_avatar_uploads').doc(avatarTicketToken)
      let ticket = null
      try { ticket = (await ticketReference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
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

async function compensateAvatarUpdate(openid, avatarTicketToken, uploadedAvatarFileId) {
  if (avatarTicketToken) {
    await updateAvatarTicket(openid, avatarTicketToken, {
      cleanupReady: true, updatedAt: db.serverDate(),
    }).catch(() => {})
  }
  // cleanupAvatarTicket re-reads the active profile inside its claim transaction.
  // A separate read followed by delete would leave a race with another device.
  if (avatarTicketToken) await cleanupAvatarTicket(openid, avatarTicketToken).catch(() => {})
}

async function updateProfile(openid, input = {}) {
  const nickname = safeText(input.nickname, 20)
  let uploadedAvatarFileId = ''
  let avatarTicketToken = ''
  if (!nickname) throw new Error('请填写昵称')
  try {
    if (input.avatarImage) {
      const finalized = await finalizeAvatar(openid, input.avatarImage)
      uploadedAvatarFileId = finalized.fileID
      avatarTicketToken = finalized.token
    }
  } catch (error) {
    if (uploadedAvatarFileId) await deletePrivateFiles([uploadedAvatarFileId]).catch(() => {})
    if (avatarTicketToken) {
      await updateAvatarTicket(openid, avatarTicketToken, {
        state: 'cleanup', cleanupReady: true, updatedAt: db.serverDate(),
      }).catch(() => {})
    }
    if (avatarTicketToken) await cleanupAvatarTicket(openid, avatarTicketToken).catch(() => {})
    throw error
  }
  try {
    await commitProfileUpdate(openid, nickname, uploadedAvatarFileId, avatarTicketToken)
  } catch (error) {
    await compensateAvatarUpdate(openid, avatarTicketToken, uploadedAvatarFileId)
    throw error
  }
  if (avatarTicketToken) {
    await cleanupAvatarTicket(openid, avatarTicketToken).catch((error) => {
      console.error('old avatar cleanup failed', { name: error && error.name })
    })
  }
  return await publicProfile(await readUser(openid))
}

exports.main = async (event = {}) => {
  const context = cloud.getWXContext()
  const openid = context.OPENID
  if (!openid) return { success: false, message: '无法识别当前微信用户' }
  try {
    await requireMember(openid)
    if (event.action === 'login') return { success: true, data: await login(openid, context.UNIONID) }
    if (event.action === 'updateProfile') return { success: true, data: await updateProfile(openid, event.profile) }
    return { success: false, message: '不支持的账号操作' }
  } catch (error) {
    const failure = publicAuthFailure(error)
    console.error('auth failed', { code: failure.code, name: error && error.name })
    return { success: false, ...failure }
  }
}
