const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const command = db.command
const members = db.collection('meal_members')
const daily = db.collection('health_daily')
const uploads = db.collection('health_photo_uploads')

function clean(value, maxLength = 100) { return typeof value === 'string' ? value.trim().slice(0, maxLength) : '' }
function validDate(value) {
  if (!/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}
function validMonth(value) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) }
function safeExtension(value) { const ext = clean(value, 8).toLowerCase(); return ['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? ext : 'jpg' }
function ownerHash(openid) { return crypto.createHash('sha256').update(openid).digest('hex').slice(0, 24) }
function documentId(openid, date) { return crypto.createHash('sha256').update(`${openid}:${date}`).digest('hex') }

async function requireMember(openid) {
  try { const member = (await members.doc(openid).get()).data; if (member && member.status === 'active') return member } catch (_) {}
  throw new Error('需要有效邀请才能使用')
}

function publicRecord(record = {}) {
  return {
    date: record.date,
    weight: typeof record.weight === 'number' ? record.weight : null,
    hasPhoto: Boolean(record.photoFileId), photoFileId: record.photoFileId || '', photoUrl: record.photoUrl || '',
    exercise: record.exercise || null, note: record.note || '', updatedAt: record.updatedAt || null,
  }
}

async function preparePhoto(openid, extension) {
  const token = crypto.randomBytes(24).toString('hex')
  const ext = safeExtension(extension)
  await uploads.doc(token).set({ data: { owner: openid, extension: ext, expiresAt: Date.now() + 10 * 60 * 1000, createdAt: db.serverDate() } })
  return { token, cloudPath: `health-inbox/${token}.${ext}` }
}

async function finalizePhoto(openid, token, fileID, date) {
  const safeToken = clean(token, 80)
  const safeFileID = clean(fileID, 900)
  if (!safeToken || !safeFileID || !safeFileID.includes(`/health-inbox/${safeToken}.`)) throw new Error('照片上传凭证无效')
  let ticket
  try { ticket = (await uploads.doc(safeToken).get()).data } catch (_) { throw new Error('照片上传凭证已失效') }
  if (!ticket || ticket.owner !== openid || Number(ticket.expiresAt) < Date.now()) throw new Error('照片上传凭证已过期')
  const download = await cloud.downloadFile({ fileID: safeFileID })
  const path = `health-photos/${ownerHash(openid)}/${date}-${Date.now()}.${safeExtension(ticket.extension)}`
  const uploaded = await cloud.uploadFile({ cloudPath: path, fileContent: download.fileContent })
  await Promise.allSettled([cloud.deleteFile({ fileList: [safeFileID] }), uploads.doc(safeToken).remove()])
  return uploaded.fileID
}

function sanitizeExercise(input) {
  if (!input || input.completed !== true) return null
  return {
    completed: true,
    type: clean(input.type, 20) || '其他运动',
    durationMinutes: Math.max(1, Math.min(600, Number(input.durationMinutes) || 1)),
    intensity: ['low', 'medium', 'high'].includes(input.intensity) ? input.intensity : 'medium',
  }
}

async function saveDaily(openid, input = {}) {
  const date = clean(input.date, 10)
  if (!validDate(date)) throw new Error('记录日期无效')
  const current = await readDaily(openid, date)
  const previousPhotoFileId = current && current.photoFileId || ''
  let photoFileId = input.clearPhoto === true ? '' : previousPhotoFileId
  if (input.photoUploadToken || input.photoUploadFileId) photoFileId = await finalizePhoto(openid, input.photoUploadToken, input.photoUploadFileId, date)
  const rawWeight = input.weight
  const weight = rawWeight === '' || rawWeight === null || rawWeight === undefined ? null : Number(rawWeight)
  if (weight !== null && (!Number.isFinite(weight) || weight < 20 || weight > 300)) throw new Error('体重需在 20–300 kg 之间')
  const data = {
    owner: openid, date, month: date.slice(0, 7), weight: weight === null ? null : Math.round(weight * 10) / 10,
    photoFileId, exercise: sanitizeExercise(input.exercise), note: clean(input.note, 200),
    updatedAt: db.serverDate(), schemaVersion: 1,
  }
  const id = documentId(openid, date)
  if (current) await daily.doc(id).update({ data })
  else await daily.doc(id).set({ data: { ...data, createdAt: db.serverDate() } })
  if (previousPhotoFileId && previousPhotoFileId !== photoFileId) await cloud.deleteFile({ fileList: [previousPhotoFileId] }).catch(() => {})
  return { ...publicRecord({ ...data, updatedAt: new Date().toISOString() }), photoFileId: '' }
}

async function readDaily(openid, date) {
  try { return (await daily.doc(documentId(openid, date)).get()).data || null }
  catch (error) { if (/not exist|does not exist|DATABASE_DOCUMENT_NOT_FOUND/i.test(error.message || error.errMsg || '')) return null; throw error }
}

async function getMonth(openid, month, includePhotoUrls) {
  if (!validMonth(month)) throw new Error('月份无效')
  const result = await daily.where({ owner: openid, month }).orderBy('date', 'asc').limit(31).get()
  const records = result.data.map(publicRecord)
  if (includePhotoUrls) {
    const fileList = records.filter((item) => item.photoFileId).map((item) => item.photoFileId)
    if (fileList.length) {
      const urls = await cloud.getTempFileURL({ fileList })
      const map = Object.fromEntries(urls.fileList.map((item) => [item.fileID, item.tempFileURL || '']))
      records.forEach((item) => { if (item.photoFileId) item.photoUrl = map[item.photoFileId] || '' })
    }
  }
  return records.map((item) => ({ ...item, photoFileId: '' }))
}

async function getRange(openid, startDate, endDate) {
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) throw new Error('日期范围无效')
  const result = await daily.where({ owner: openid, date: command.gte(startDate).and(command.lte(endDate)) }).orderBy('date', 'asc').limit(31).get()
  return result.data.map(publicRecord).map((item) => ({ ...item, photoFileId: '', photoUrl: '' }))
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success: false, message: '无法识别微信身份' }
  try {
    await requireMember(OPENID)
    if (event.action === 'preparePhoto') return { success: true, data: await preparePhoto(OPENID, event.extension) }
    if (event.action === 'saveDaily') return { success: true, data: await saveDaily(OPENID, event.record) }
    if (event.action === 'getMonth') return { success: true, data: await getMonth(OPENID, clean(event.month, 7), event.includePhotoUrls === true) }
    if (event.action === 'getRange') return { success: true, data: await getRange(OPENID, clean(event.startDate, 10), clean(event.endDate, 10)) }
    return { success: false, message: '不支持的健康记录操作' }
  } catch (error) {
    console.error('health failed', error)
    return { success: false, message: error.message || '健康记录服务暂时不可用' }
  }
}
