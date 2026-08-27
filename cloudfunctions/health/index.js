const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const { validateImageFile } = require('./image-file')
const { downloadImageSource, validMetadata } = require('./image-source')
const { planDailyUpdate, photoTicketCleanupFiles } = require('./daily-core')
const { orphanPermanentPath, ticketCleanupClaimable, ticketConsumable } = require('./upload-ticket')
const { notFound } = require('./not-found')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const command = db.command
const members = db.collection('meal_members')
const daily = db.collection('health_daily')
const uploads = db.collection('health_photo_uploads')
const MAX_HEALTH_PHOTO_BYTES = 2 * 1024 * 1024
const UPLOAD_TICKET_TTL_MS = 15 * 60 * 1000
const CLEANUP_CLAIM_TTL_MS = 60 * 1000
const HEALTH_ERROR_MESSAGES = Object.freeze({
  ACCOUNT_DELETION_IN_PROGRESS: '账号数据正在删除，请稍后再试',
  MEMBERSHIP_REQUIRED: '需要有效邀请才能使用',
  INVALID_HEALTH_RECORD_REVISION: '请先刷新当天记录后再保存',
  HEALTH_RECORD_INVALID: '健康记录数据无效，请联系管理员',
  HEALTH_RECORD_SCHEMA_UNSUPPORTED: '健康记录来自较新版本，请更新小程序后再保存',
  HEALTH_RECORD_REVISION_CONFLICT: '这一天已在其他设备更新，请刷新后重新确认',
  IMAGE_METADATA_INVALID: '健康照片文件信息无效，请重新选择',
  IMAGE_SOURCE_INVALID: '健康照片临时地址无效，请重新选择',
  IMAGE_SOURCE_UNAVAILABLE: '健康照片读取失败，请重新选择',
  IMAGE_CONTENT_MISMATCH: '健康照片内容发生变化，请重新选择',
  IMAGE_TOO_LARGE: '健康照片不能超过 2 MB',
})
const HEALTH_REQUEST_MESSAGES = new Set([
  '健康照片清理失败，请稍后重试',
  '照片上传凭证已失效，请重新选择',
  '记录日期无效',
  '体重需在 20–300 kg 之间',
  '月份无效',
  '日期范围无效',
  '健康照片为空，请重新选择',
  '健康照片不能超过 2 MB',
  '健康照片必须是 JPG、PNG 或 WebP 图片',
])

function publicHealthFailure(error) {
  const code = typeof (error && error.code) === 'string' ? error.code : ''
  if (Object.prototype.hasOwnProperty.call(HEALTH_ERROR_MESSAGES, code)) {
    return { code, message: HEALTH_ERROR_MESSAGES[code] }
  }
  const message = typeof (error && error.message) === 'string' ? error.message : ''
  if (HEALTH_REQUEST_MESSAGES.has(message)) return { code: 'HEALTH_REQUEST_INVALID', message }
  return { code: 'HEALTH_FAILED', message: '健康记录服务暂时不可用' }
}

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
async function deletePrivateFiles(fileIds) {
  const fileList = [...new Set(fileIds.filter((fileID) => typeof fileID === 'string' && fileID.startsWith('cloud://')))]
  if (!fileList.length) return
  const result = await cloud.deleteFile({ fileList })
  const failed = (result && Array.isArray(result.fileList) ? result.fileList : []).filter((item) => (
    Number(item.status) !== 0 && !notFound({ message: item.errMsg })
  ))
  if (failed.length) throw new Error('健康照片清理失败，请稍后重试')
}

async function claimPhotoTicketCleanup(openid, token) {
  return withActiveMemberTransaction(openid, async (transaction) => {
    const ticketReference = transaction.collection('health_photo_uploads').doc(token)
    let ticket = null
    try { ticket = (await ticketReference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
    if (!ticketCleanupClaimable(ticket, openid, Date.now(), CLEANUP_CLAIM_TTL_MS)) return null

    let activePhotoFileId = ''
    if (validDate(ticket.targetDate)) {
      const recordReference = transaction.collection('health_daily').doc(documentId(openid, ticket.targetDate))
      let record = null
      try { record = (await recordReference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
      activePhotoFileId = record && record.photoFileId || ''
    }
    const files = photoTicketCleanupFiles(ticket, activePhotoFileId)
    const orphanPath = orphanPermanentPath(ticket, {
      kind: 'health', owner: openid, token, targetDate: ticket.targetDate,
    })
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

async function cleanupPhotoTicket(openid, token) {
  const claim = await claimPhotoTicketCleanup(openid, token)
  if (!claim) return false
  await deletePrivateFiles(claim.files)
  await reclaimOrphanPath(claim.orphanPath)
  await uploads.doc(token).remove().catch((error) => { if (!notFound(error)) throw error })
  return true
}

async function cleanupPhotoTickets(openid) {
  const result = await uploads.where({ owner: openid }).limit(20).get()
  for (const ticket of result.data) await cleanupPhotoTicket(openid, ticket._id)
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

async function updatePhotoTicket(openid, token, data, expectedStates = []) {
  return withActiveMemberTransaction(openid, async (transaction) => {
    const reference = transaction.collection('health_photo_uploads').doc(token)
    let ticket = null
    try { ticket = (await reference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
    if (!ticket || ticket.owner !== openid) throw new Error('照片上传凭证已失效，请重新选择')
    if (expectedStates.length && !expectedStates.includes(ticket.state)) throw new Error('照片上传凭证已失效，请重新选择')
    await reference.update({ data })
    return ticket
  })
}

function publicRecord(record = {}) {
  return {
    date: record.date,
    recordRevision: Number.isSafeInteger(record.recordRevision) && record.recordRevision >= 0 ? record.recordRevision : 0,
    weight: typeof record.weight === 'number' ? record.weight : null,
    hasPhoto: Boolean(record.photoFileId), photoFileId: record.photoFileId || '', photoUrl: record.photoUrl || '',
    exercise: record.exercise || null, note: record.note || '', updatedAt: record.updatedAt || null,
  }
}

async function preparePhoto(openid, imageInput, date) {
  await cleanupPhotoTickets(openid).catch((error) => console.error('health photo cleanup failed', { name: error && error.name }))
  const metadata = validMetadata(imageInput, MAX_HEALTH_PHOTO_BYTES, '健康照片')
  const token = crypto.randomBytes(24).toString('hex')
  const permanentPath = `health-photos/${ownerHash(openid)}/${date}-${token}`
  await withActiveMemberTransaction(openid, async (transaction) => {
    await transaction.collection('health_photo_uploads').doc(token).set({
      data: {
        owner: openid, state: 'prepared', targetDate: date, permanentPath,
        expectedSize: metadata.size, expectedSha256: metadata.sha256,
        cleanupReady: false, expiresAt: Date.now() + UPLOAD_TICKET_TTL_MS,
        createdAt: db.serverDate(), updatedAt: db.serverDate(),
      },
    })
  })
  return { token, permanentPath }
}

async function finalizePhoto(openid, imageInput, date) {
  const prepared = await preparePhoto(openid, imageInput, date)
  let uploadedFileId = ''
  try {
    const source = await downloadImageSource(imageInput, { maxBytes: MAX_HEALTH_PHOTO_BYTES, label: '健康照片' })
    const image = validateImageFile(source, { maxBytes: MAX_HEALTH_PHOTO_BYTES, label: '健康照片' })
    const path = `${prepared.permanentPath}.${image.extension}`
    await updatePhotoTicket(openid, prepared.token, { permanentPath: path, updatedAt: db.serverDate() }, ['prepared'])
    const uploaded = await cloud.uploadFile({ cloudPath: path, fileContent: image.fileContent })
    uploadedFileId = uploaded.fileID
    await updatePhotoTicket(openid, prepared.token, {
      state: 'staged', permanentFileId: uploaded.fileID, updatedAt: db.serverDate(),
    }, ['prepared'])
    return { fileID: uploaded.fileID, token: prepared.token }
  } catch (error) {
    if (uploadedFileId) await deletePrivateFiles([uploadedFileId]).catch(() => {})
    await updatePhotoTicket(openid, prepared.token, {
      state: 'cleanup', cleanupReady: true, updatedAt: db.serverDate(),
    }).catch(() => {})
    await cleanupPhotoTicket(openid, prepared.token).catch(() => {})
    throw error
  }
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

async function commitDailyUpdate(openid, normalized, uploadedPhotoFileId, photoTicketToken) {
  const id = documentId(openid, normalized.date)
  return withActiveMemberTransaction(openid, async (transaction) => {
    const reference = transaction.collection('health_daily').doc(id)
    let current = null
    try { current = (await reference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
    const planned = planDailyUpdate(current || {}, {
      ...normalized, owner: openid, month: normalized.date.slice(0, 7), uploadedPhotoFileId,
    })

    if (uploadedPhotoFileId) {
      const ticketReference = transaction.collection('health_photo_uploads').doc(photoTicketToken)
      let ticket = null
      try { ticket = (await ticketReference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
      if (!ticketConsumable(ticket, {
        owner: openid, fileId: uploadedPhotoFileId, targetDate: normalized.date,
      }, Date.now())) {
        throw new Error('照片上传凭证已失效，请重新选择')
      }
      await ticketReference.update({
        data: {
          state: 'consumed', permanentFileId: '', permanentPath: '',
          cleanupFileId: planned.replacedPhotoFileId,
          cleanupReady: true, consumedAt: db.serverDate(), updatedAt: db.serverDate(),
        },
      })
    }

    const data = { ...planned.data, updatedAt: db.serverDate() }
    if (current) await reference.update({ data })
    else await reference.set({ data: { ...data, createdAt: db.serverDate() } })
    return planned
  })
}

async function compensatePhotoUpdate(openid, date, photoTicketToken, uploadedPhotoFileId) {
  if (photoTicketToken) {
    await updatePhotoTicket(openid, photoTicketToken, {
      cleanupReady: true, updatedAt: db.serverDate(),
    }).catch(() => {})
  }
  // cleanupPhotoTicket re-reads this date's active record in its claim transaction.
  // A separate read followed by delete would leave a race with another device.
  if (photoTicketToken) await cleanupPhotoTicket(openid, photoTicketToken).catch(() => {})
}

async function saveDaily(openid, input = {}) {
  const date = clean(input.date, 10)
  if (!validDate(date)) throw new Error('记录日期无效')
  const expectedRecordRevision = input.expectedRecordRevision
  if (!Number.isSafeInteger(expectedRecordRevision) || expectedRecordRevision < 0) {
    const error = new Error('请先刷新当天记录后再保存')
    error.code = 'INVALID_HEALTH_RECORD_REVISION'
    throw error
  }
  const rawWeight = input.weight
  const weight = rawWeight === '' || rawWeight === null || rawWeight === undefined ? null : Number(rawWeight)
  if (weight !== null && (!Number.isFinite(weight) || weight < 20 || weight > 300)) throw new Error('体重需在 20–300 kg 之间')
  const normalized = { date, expectedRecordRevision }
  if (Object.prototype.hasOwnProperty.call(input, 'weight')) normalized.weight = weight === null ? null : Math.round(weight * 10) / 10
  if (Object.prototype.hasOwnProperty.call(input, 'exercise')) normalized.exercise = sanitizeExercise(input.exercise)
  if (Object.prototype.hasOwnProperty.call(input, 'note')) normalized.note = clean(input.note, 200)
  if (input.clearPhoto === true) normalized.clearPhoto = true
  let uploadedPhotoFileId = ''
  let photoTicketToken = ''
  try {
    if (input.photoImage) {
      const finalized = await finalizePhoto(openid, input.photoImage, date)
      uploadedPhotoFileId = finalized.fileID
      photoTicketToken = finalized.token
    }
  } catch (error) {
    if (uploadedPhotoFileId) await deletePrivateFiles([uploadedPhotoFileId]).catch(() => {})
    if (photoTicketToken) {
      await updatePhotoTicket(openid, photoTicketToken, {
        state: 'cleanup', cleanupReady: true, updatedAt: db.serverDate(),
      }).catch(() => {})
    }
    if (photoTicketToken) await cleanupPhotoTicket(openid, photoTicketToken).catch(() => {})
    throw error
  }
  let committed
  try {
    committed = await commitDailyUpdate(openid, normalized, uploadedPhotoFileId, photoTicketToken)
  } catch (error) {
    await compensatePhotoUpdate(openid, date, photoTicketToken, uploadedPhotoFileId)
    throw error
  }
  if (photoTicketToken) {
    await cleanupPhotoTicket(openid, photoTicketToken).catch((error) => {
      console.error('old health photo cleanup failed', { name: error && error.name })
    })
  } else if (committed.replacedPhotoFileId) {
    await deletePrivateFiles([committed.replacedPhotoFileId]).catch((error) => {
      console.error('old health photo cleanup failed', { name: error && error.name })
    })
  }
  return { ...publicRecord({ ...committed.data, updatedAt: new Date().toISOString() }), photoFileId: '' }
}

async function readDaily(openid, date) {
  try { return (await daily.doc(documentId(openid, date)).get()).data || null }
  catch (error) { if (notFound(error)) return null; throw error }
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
    if (event.action === 'saveDaily') return { success: true, data: await saveDaily(OPENID, event.record) }
    if (event.action === 'getMonth') return { success: true, data: await getMonth(OPENID, clean(event.month, 7), event.includePhotoUrls === true) }
    if (event.action === 'getRange') return { success: true, data: await getRange(OPENID, clean(event.startDate, 10), clean(event.endDate, 10)) }
    return { success: false, message: '不支持的健康记录操作' }
  } catch (error) {
    const failure = publicHealthFailure(error)
    console.error('health failed', { code: failure.code, name: error && error.name })
    return { success: false, ...failure }
  }
}

exports._test = { commitDailyUpdate, documentId, publicRecord, saveDaily }
