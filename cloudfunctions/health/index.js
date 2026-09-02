const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const { validateImageFile } = require('./image-file')
const { downloadImageSource, validMetadata } = require('./image-source')
const { hasDailyContent, planDailyUpdate, photoTicketCleanupFiles } = require('./daily-core')
const {
  orphanPermanentPath, ticketCleanupClaimable, ticketConsumable, validOwnedPermanentPath,
} = require('./upload-ticket')
const { notFound } = require('./not-found')
const { storageDeleteSucceeded, storageFileMissing } = require('./storage-delete')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const command = db.command
const members = db.collection('meal_members')
const daily = db.collection('health_daily')
const uploads = db.collection('health_photo_uploads')
const MAX_HEALTH_PHOTO_BYTES = 2 * 1024 * 1024
const UPLOAD_TICKET_TTL_MS = 15 * 60 * 1000
const UPLOAD_LEASE_MS = 120 * 1000
const CLEANUP_CLAIM_TTL_MS = 60 * 1000
const CACHE_NAMESPACE_PATTERN = /^[a-f0-9]{32}$/
const UPLOAD_TOKEN_PATTERN = /^[a-f0-9]{48}$/
const LEGACY_TICKET_STATES = new Set([
  'prepared', 'uploading', 'staged', 'consumed', 'cleanup', 'cleaning',
])
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
  STALE_DATA_GENERATION: '账号数据版本已变化，请刷新后重试',
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
  let result
  try { result = await cloud.deleteFile({ fileList }) }
  catch (error) { if (fileList.length === 1 && storageFileMissing(error)) return; throw error }
  if (!storageDeleteSucceeded(result, fileList)) throw new Error('健康照片清理失败，请稍后重试')
}

function legacyTicketWithoutNamespace(ticket) {
  return Boolean(ticket) && !Object.prototype.hasOwnProperty.call(ticket, 'cacheNamespace')
}

function cloudFilePath(fileID) {
  if (typeof fileID !== 'string' || !fileID.startsWith('cloud://')) return ''
  const pathOffset = fileID.indexOf('/', 'cloud://'.length)
  return pathOffset >= 0 ? fileID.slice(pathOffset + 1) : ''
}

function cloudFileReferencesPath(fileID, path) {
  return typeof path === 'string' && path && cloudFilePath(fileID) === path
}

function ownedHealthPhotoFileId(fileID, openid, targetDate) {
  const path = cloudFilePath(fileID)
  return path.startsWith(`health-photos/${ownerHash(openid)}/${targetDate}-`)
    && !path.includes('..') && /\.(?:jpe?g|png|webp)$/.test(path)
}

function assertLegacyPhotoTicketCleanup(ticket, openid, token) {
  if (!ticket || ticket.owner !== openid || !UPLOAD_TOKEN_PATTERN.test(token || '')
    || !validDate(ticket.targetDate) || !LEGACY_TICKET_STATES.has(ticket.state)) {
    throw new Error('照片上传凭证已失效，请重新选择')
  }
  const permanentPath = typeof ticket.permanentPath === 'string' ? ticket.permanentPath : ''
  if (permanentPath && !validOwnedPermanentPath(permanentPath, ticket, {
    kind: 'health', owner: openid, token, targetDate: ticket.targetDate,
  })) {
    throw new Error('照片上传凭证已失效，请重新选择')
  }
  if (['prepared', 'uploading', 'staged'].includes(ticket.state) && !permanentPath) {
    throw new Error('照片上传凭证已失效，请重新选择')
  }
  if (ticket.state === 'uploading'
    && (!Number.isSafeInteger(ticket.uploadStartedAtMs) || ticket.uploadStartedAtMs < 0
      || !Number.isSafeInteger(ticket.uploadLeaseExpiresAtMs)
      || ticket.uploadLeaseExpiresAtMs - ticket.uploadStartedAtMs !== UPLOAD_LEASE_MS)) {
    throw new Error('照片上传凭证已失效，请重新选择')
  }
  if (ticket.permanentFileId
    && !cloudFileReferencesPath(ticket.permanentFileId, permanentPath)) {
    throw new Error('照片上传凭证已失效，请重新选择')
  }
  if (ticket.cleanupFileId
    && !ownedHealthPhotoFileId(ticket.cleanupFileId, openid, ticket.targetDate)) {
    throw new Error('照片上传凭证已失效，请重新选择')
  }
  for (const field of ['inboxFileId', 'fileID', 'fileId']) {
    if (ticket[field]) throw new Error('照片上传凭证已失效，请重新选择')
  }
  return ticket
}

async function claimPhotoTicketCleanup(openid, token, expectedCacheNamespace) {
  return withActiveMemberTransaction(openid, expectedCacheNamespace, async (transaction, member) => {
    const ticketReference = transaction.collection('health_photo_uploads').doc(token)
    let ticket = null
    try { ticket = (await ticketReference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
    if (!ticket || ticket.owner !== openid) return null
    const now = Date.now()
    if (ticket.state === 'uploading') {
      if (!Number.isSafeInteger(ticket.uploadLeaseExpiresAtMs)
        || ticket.uploadLeaseExpiresAtMs > now) return null
    } else if (!ticketCleanupClaimable(ticket, openid, now, CLEANUP_CLAIM_TTL_MS)) return null
    const legacyTicket = legacyTicketWithoutNamespace(ticket)
    if (legacyTicket) assertLegacyPhotoTicketCleanup(ticket, openid, token)
    else assertPhotoTicketCacheNamespace(ticket, member.cacheNamespace)

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
      ...(legacyTicket ? { cacheNamespace: member.cacheNamespace, legacyNamespaceBound: true } : {}),
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

async function removeCleanedPhotoTicket(openid, token, expectedCacheNamespace) {
  return withActiveMemberTransaction(openid, expectedCacheNamespace, async (transaction, member) => {
    const reference = transaction.collection('health_photo_uploads').doc(token)
    let ticket = null
    try { ticket = (await reference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
    if (!ticket) return false
    if (ticket.owner !== openid || ticket.state !== 'cleaning') {
      throw new Error('照片上传凭证已失效，请重新选择')
    }
    assertPhotoTicketCacheNamespace(ticket, member.cacheNamespace)
    await reference.remove()
    return true
  })
}

async function cleanupPhotoTicket(openid, token, expectedCacheNamespace) {
  const claim = await claimPhotoTicketCleanup(openid, token, expectedCacheNamespace)
  if (!claim) return false
  await deletePrivateFiles(claim.files)
  await reclaimOrphanPath(claim.orphanPath)
  await removeCleanedPhotoTicket(openid, token, expectedCacheNamespace)
  return true
}

async function cleanupPhotoTickets(openid, expectedCacheNamespace) {
  const result = await uploads.where({ owner: openid }).limit(20).get()
  for (const ticket of result.data) {
    if (ticket.cacheNamespace !== expectedCacheNamespace && !legacyTicketWithoutNamespace(ticket)) continue
    await cleanupPhotoTicket(openid, ticket._id, expectedCacheNamespace)
  }
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

function assertPhotoTicketCacheNamespace(ticket, expectedCacheNamespace) {
  if (!ticket || !CACHE_NAMESPACE_PATTERN.test(ticket.cacheNamespace || '')
    || ticket.cacheNamespace !== expectedCacheNamespace) {
    throw staleDataGenerationError()
  }
  return ticket
}

async function withActiveMemberTransaction(openid, expectedCacheNamespace, operation) {
  if (typeof expectedCacheNamespace === 'function') {
    operation = expectedCacheNamespace
    expectedCacheNamespace = null
  }
  return db.runTransaction(async (transaction) => {
    let member = null
    try {
      member = (await transaction.collection('meal_members').doc(openid).get()).data || null
    } catch (error) {
      if (!notFound(error)) throw error
    }
    if (!member || member.status !== 'active') throw membershipError(member)
    if (expectedCacheNamespace !== null) assertExpectedCacheNamespace(member, expectedCacheNamespace)
    return operation(transaction, member)
  })
}

async function updatePhotoTicket(openid, token, data, expectedStates = [], expectedCacheNamespace) {
  return withActiveMemberTransaction(openid, expectedCacheNamespace, async (transaction) => {
    const reference = transaction.collection('health_photo_uploads').doc(token)
    let ticket = null
    try { ticket = (await reference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
    if (!ticket || ticket.owner !== openid) throw new Error('照片上传凭证已失效，请重新选择')
    assertPhotoTicketCacheNamespace(ticket, expectedCacheNamespace)
    if (expectedStates.length && !expectedStates.includes(ticket.state)) throw new Error('照片上传凭证已失效，请重新选择')
    await reference.update({ data })
    return { ...ticket, ...data }
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

function publicEmptyRecord(record = {}) {
  return {
    date: record.date,
    recordRevision: Number.isSafeInteger(record.recordRevision) && record.recordRevision >= 0
      ? record.recordRevision : 0,
    empty: true,
  }
}

async function preparePhoto(openid, imageInput, date, expectedCacheNamespace) {
  await cleanupPhotoTickets(openid, expectedCacheNamespace)
    .catch((error) => console.error('health photo cleanup failed', { name: error && error.name }))
  const metadata = validMetadata(imageInput, MAX_HEALTH_PHOTO_BYTES, '健康照片')
  const token = crypto.randomBytes(24).toString('hex')
  const permanentPath = `health-photos/${ownerHash(openid)}/${date}-${token}`
  await withActiveMemberTransaction(openid, expectedCacheNamespace, async (transaction) => {
    await transaction.collection('health_photo_uploads').doc(token).set({
      data: {
        owner: openid, cacheNamespace: expectedCacheNamespace,
        state: 'prepared', targetDate: date, permanentPath,
        expectedSize: metadata.size, expectedSha256: metadata.sha256,
        cleanupReady: false, expiresAt: Date.now() + UPLOAD_TICKET_TTL_MS,
        createdAt: db.serverDate(), updatedAt: db.serverDate(),
      },
    })
  })
  return { token, permanentPath }
}

async function finalizePhoto(openid, imageInput, date, expectedCacheNamespace) {
  const prepared = await preparePhoto(openid, imageInput, date, expectedCacheNamespace)
  let uploadedFileId = ''
  let permanentPath = ''
  let uploadAttempted = false
  try {
    const source = await downloadImageSource(imageInput, { maxBytes: MAX_HEALTH_PHOTO_BYTES, label: '健康照片' })
    const image = validateImageFile(source, { maxBytes: MAX_HEALTH_PHOTO_BYTES, label: '健康照片' })
    permanentPath = `${prepared.permanentPath}.${image.extension}`
    const uploadStartedAtMs = Date.now()
    const uploading = await updatePhotoTicket(openid, prepared.token, {
      state: 'uploading', permanentPath,
      uploadStartedAtMs, uploadLeaseExpiresAtMs: uploadStartedAtMs + UPLOAD_LEASE_MS,
      updatedAt: db.serverDate(),
    }, ['prepared'], expectedCacheNamespace)
    uploadAttempted = true
    const uploaded = await cloud.uploadFile({
      cloudPath: uploading.permanentPath, fileContent: image.fileContent,
    })
    uploadedFileId = uploaded.fileID
    await updatePhotoTicket(openid, prepared.token, {
      state: 'staged', permanentFileId: uploaded.fileID,
      uploadStartedAtMs: command.remove(), uploadLeaseExpiresAtMs: command.remove(),
      updatedAt: db.serverDate(),
    }, ['uploading'], expectedCacheNamespace)
    return { fileID: uploaded.fileID, token: prepared.token }
  } catch (error) {
    if (uploadedFileId) await deletePrivateFiles([uploadedFileId]).catch(() => {})
    if (uploadAttempted && permanentPath) await reclaimOrphanPath(permanentPath).catch(() => {})
    if (!uploadAttempted) {
      await updatePhotoTicket(openid, prepared.token, {
        state: 'cleanup', cleanupReady: true, updatedAt: db.serverDate(),
      }, ['prepared'], expectedCacheNamespace).catch(() => {})
      await cleanupPhotoTicket(openid, prepared.token, expectedCacheNamespace).catch(() => {})
    }
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

async function commitDailyUpdate(openid, normalized, uploadedPhotoFileId, photoTicketToken, expectedCacheNamespace) {
  const id = documentId(openid, normalized.date)
  const cleanupTicketToken = uploadedPhotoFileId ? '' : crypto.randomBytes(24).toString('hex')
  return withActiveMemberTransaction(openid, expectedCacheNamespace, async (transaction) => {
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
      assertPhotoTicketCacheNamespace(ticket, expectedCacheNamespace)
      if (!ticketConsumable(ticket, {
        owner: openid, fileId: uploadedPhotoFileId, targetDate: normalized.date,
      }, Date.now())) {
        throw new Error('照片上传凭证已失效，请重新选择')
      }
      if (planned.replacedPhotoFileId) {
        await ticketReference.update({
          data: {
            state: 'consumed', permanentFileId: '', permanentPath: '',
            cleanupFileId: planned.replacedPhotoFileId,
            cleanupReady: true, consumedAt: db.serverDate(), updatedAt: db.serverDate(),
          },
        })
      } else {
        await ticketReference.remove()
      }
    } else if (planned.replacedPhotoFileId) {
      await transaction.collection('health_photo_uploads').doc(cleanupTicketToken).set({
        data: {
          owner: openid, cacheNamespace: expectedCacheNamespace,
          state: 'cleanup', targetDate: normalized.date,
          cleanupFileId: planned.replacedPhotoFileId, cleanupReady: true,
          createdAt: db.serverDate(), updatedAt: db.serverDate(),
        },
      })
    }

    const data = { ...planned.data, updatedAt: db.serverDate() }
    if (current) await reference.update({ data })
    else await reference.set({ data: { ...data, createdAt: db.serverDate() } })
    return {
      ...planned,
      cleanupTicketToken: planned.replacedPhotoFileId
        ? (photoTicketToken || cleanupTicketToken) : '',
    }
  })
}

async function compensatePhotoUpdate(openid, date, photoTicketToken, uploadedPhotoFileId, expectedCacheNamespace) {
  if (photoTicketToken) {
    await updatePhotoTicket(openid, photoTicketToken, {
      cleanupReady: true, updatedAt: db.serverDate(),
    }, [], expectedCacheNamespace).catch(() => {})
  }
  // cleanupPhotoTicket re-reads this date's active record in its claim transaction.
  // A separate read followed by delete would leave a race with another device.
  if (photoTicketToken) {
    await cleanupPhotoTicket(openid, photoTicketToken, expectedCacheNamespace).catch(() => {})
  }
}

async function saveDaily(openid, input = {}, expectedCacheNamespace) {
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
  await cleanupPhotoTickets(openid, expectedCacheNamespace)
    .catch((error) => console.error('health photo cleanup failed', { name: error && error.name }))
  let uploadedPhotoFileId = ''
  let photoTicketToken = ''
  try {
    if (input.photoImage) {
      const finalized = await finalizePhoto(openid, input.photoImage, date, expectedCacheNamespace)
      uploadedPhotoFileId = finalized.fileID
      photoTicketToken = finalized.token
    }
  } catch (error) {
    if (uploadedPhotoFileId) await deletePrivateFiles([uploadedPhotoFileId]).catch(() => {})
    if (photoTicketToken) {
      await updatePhotoTicket(openid, photoTicketToken, {
        state: 'cleanup', cleanupReady: true, updatedAt: db.serverDate(),
      }, [], expectedCacheNamespace).catch(() => {})
    }
    if (photoTicketToken) {
      await cleanupPhotoTicket(openid, photoTicketToken, expectedCacheNamespace).catch(() => {})
    }
    throw error
  }
  let committed
  try {
    committed = await commitDailyUpdate(openid, normalized, uploadedPhotoFileId,
      photoTicketToken, expectedCacheNamespace)
  } catch (error) {
    await compensatePhotoUpdate(
      openid, date, photoTicketToken, uploadedPhotoFileId, expectedCacheNamespace,
    )
    throw error
  }
  if (committed.cleanupTicketToken) {
    await cleanupPhotoTicket(openid, committed.cleanupTicketToken, expectedCacheNamespace).catch((error) => {
      console.error('old health photo cleanup failed', { name: error && error.name })
    })
  }
  if (committed.tombstoneRecord) return publicEmptyRecord(committed.data)
  return { ...publicRecord({ ...committed.data, updatedAt: new Date().toISOString() }), photoFileId: '' }
}

async function readDaily(openid, date) {
  try { return (await daily.doc(documentId(openid, date)).get()).data || null }
  catch (error) { if (notFound(error)) return null; throw error }
}

async function getMonth(openid, month, includePhotoUrls, expectedCacheNamespace) {
  if (!validMonth(month)) throw new Error('月份无效')
  const result = await daily.where({ owner: openid, month }).orderBy('date', 'asc').limit(31).get()
  const records = result.data.map((record) => (
    hasDailyContent(record) ? publicRecord(record) : publicEmptyRecord(record)
  ))
  if (includePhotoUrls) {
    const fileList = records.filter((item) => item.photoFileId).map((item) => item.photoFileId)
    if (fileList.length) {
      const urls = await cloud.getTempFileURL({ fileList })
      const map = Object.fromEntries(urls.fileList.map((item) => [item.fileID, item.tempFileURL || '']))
      records.forEach((item) => { if (item.photoFileId) item.photoUrl = map[item.photoFileId] || '' })
    }
  }
  await requireMember(openid, expectedCacheNamespace)
  return records.map((item) => (item.empty === true ? item : { ...item, photoFileId: '' }))
}

async function getRange(openid, startDate, endDate, expectedCacheNamespace) {
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) throw new Error('日期范围无效')
  const result = await daily.where({
    owner: openid, date: command.gte(startDate).and(command.lte(endDate)),
  }).orderBy('date', 'asc').limit(31).get()
  await requireMember(openid, expectedCacheNamespace)
  return result.data.filter(hasDailyContent).map(publicRecord)
    .map((item) => ({ ...item, photoFileId: '', photoUrl: '' }))
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success: false, message: '无法识别微信身份' }
  try {
    await requireMember(OPENID, event.expectedCacheNamespace)
    if (event.action === 'saveDaily') {
      return {
        success: true,
        data: await saveDaily(OPENID, event.record, event.expectedCacheNamespace),
      }
    }
    if (event.action === 'getMonth') {
      return {
        success: true,
        data: await getMonth(
          OPENID, clean(event.month, 7), event.includePhotoUrls === true, event.expectedCacheNamespace,
        ),
      }
    }
    if (event.action === 'getRange') {
      return {
        success: true,
        data: await getRange(
          OPENID, clean(event.startDate, 10), clean(event.endDate, 10), event.expectedCacheNamespace,
        ),
      }
    }
    return { success: false, message: '不支持的健康记录操作' }
  } catch (error) {
    const failure = publicHealthFailure(error)
    console.error('health failed', { code: failure.code, name: error && error.name })
    return { success: false, ...failure }
  }
}

exports._test = {
  assertExpectedCacheNamespace, assertPhotoTicketCacheNamespace, cleanupPhotoTicket,
  commitDailyUpdate, deletePrivateFiles, documentId, finalizePhoto, preparePhoto,
  publicEmptyRecord, publicRecord,
  saveDaily, updatePhotoTicket,
}
