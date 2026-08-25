const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const command = db.command
const users = db.collection('meal_users')
const avatarUploads = db.collection('meal_avatar_uploads')
const members = db.collection('meal_members')

async function requireMember(openid) {
  try {
    const member = (await members.doc(openid).get()).data
    if (member && member.status === 'active') return member
  } catch (_) {}
  throw new Error('需要有效邀请才能使用')
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
    if (/not exist|does not exist|DATABASE_DOCUMENT_NOT_FOUND/i.test(error.message || error.errMsg || '')) return null
    throw error
  }
}

async function login(openid, unionid) {
  const current = await readUser(openid)
  if (!current) {
    const data = {
      schemaVersion: 1, nickname: '', avatarFileId: '',
      unionid: unionid || '', loginCount: 1,
      createdAt: db.serverDate(), updatedAt: db.serverDate(), lastLoginAt: db.serverDate(),
    }
    await users.doc(openid).set({ data })
    return await publicProfile(data)
  }
  const data = { loginCount: command.inc(1), lastLoginAt: db.serverDate(), updatedAt: db.serverDate() }
  if (unionid && !current.unionid) data.unionid = unionid
  await users.doc(openid).update({ data })
  return await publicProfile(current)
}

function safeExtension(value) {
  const extension = safeText(value, 8).toLowerCase()
  return ['jpg', 'jpeg', 'png', 'webp'].includes(extension) ? extension : 'png'
}

async function prepareAvatar(openid, extension) {
  const token = crypto.randomBytes(24).toString('hex')
  const ext = safeExtension(extension)
  await avatarUploads.doc(token).set({ data: { owner: openid, extension: ext, expiresAt: Date.now() + 10 * 60 * 1000, createdAt: db.serverDate() } })
  return { token, cloudPath: `avatar-inbox/${token}.${ext}` }
}

async function finalizeAvatar(openid, token, fileID) {
  const cleanToken = safeText(token, 80)
  const cleanFileID = safeText(fileID, 900)
  if (!cleanToken || !cleanFileID || !cleanFileID.includes(`/avatar-inbox/${cleanToken}.`)) throw new Error('头像上传凭证无效')
  let ticket
  try { ticket = (await avatarUploads.doc(cleanToken).get()).data }
  catch (_) { throw new Error('头像上传凭证已失效，请重新选择') }
  if (!ticket || ticket.owner !== openid || Number(ticket.expiresAt) < Date.now()) throw new Error('头像上传凭证已过期，请重新选择')

  const download = await cloud.downloadFile({ fileID: cleanFileID })
  const ownerHash = crypto.createHash('sha256').update(openid).digest('hex').slice(0, 24)
  const cloudPath = `avatars/${ownerHash}/${Date.now()}.${safeExtension(ticket.extension)}`
  const uploaded = await cloud.uploadFile({ cloudPath, fileContent: download.fileContent })
  await Promise.allSettled([
    cloud.deleteFile({ fileList: [cleanFileID] }),
    avatarUploads.doc(cleanToken).remove(),
  ])
  return uploaded.fileID
}

async function updateProfile(openid, input = {}) {
  const nickname = safeText(input.nickname, 20)
  const current = await readUser(openid)
  let avatarFileId = current && current.avatarFileId || ''
  if (!nickname) throw new Error('请填写昵称')
  if (input.avatarUploadToken || input.avatarUploadFileId) {
    avatarFileId = await finalizeAvatar(openid, input.avatarUploadToken, input.avatarUploadFileId)
  }
  await users.doc(openid).update({ data: { nickname, avatarFileId, updatedAt: db.serverDate() } })
  return await publicProfile(await readUser(openid))
}

exports.main = async (event = {}) => {
  const context = cloud.getWXContext()
  const openid = context.OPENID
  if (!openid) return { success: false, message: '无法识别当前微信用户' }
  try {
    await requireMember(openid)
    if (event.action === 'login') return { success: true, data: await login(openid, context.UNIONID) }
    if (event.action === 'prepareAvatar') return { success: true, data: await prepareAvatar(openid, event.extension) }
    if (event.action === 'updateProfile') return { success: true, data: await updateProfile(openid, event.profile) }
    return { success: false, message: '不支持的账号操作' }
  } catch (error) {
    console.error('auth failed', error)
    return { success: false, message: error.message || '账号服务暂时不可用' }
  }
}
