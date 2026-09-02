'use strict'

const CURRENT_HEALTH_SCHEMA = 2

function fileId(value) {
  return typeof value === 'string' ? value : ''
}

function revisionError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function assertSupportedHealthSchema(current = {}) {
  if (current.schemaVersion === undefined || current.schemaVersion === null) return 0
  const schemaVersion = current.schemaVersion
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0) {
    throw revisionError('HEALTH_RECORD_INVALID', '健康记录数据无效，请联系管理员')
  }
  if (schemaVersion > CURRENT_HEALTH_SCHEMA) {
    throw revisionError('HEALTH_RECORD_SCHEMA_UNSUPPORTED', '健康记录来自较新版本，请更新小程序后再保存')
  }
  return schemaVersion
}

function currentRecordRevision(current = {}) {
  if (current.recordRevision === undefined || current.recordRevision === null) return 0
  const revision = current.recordRevision
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
    throw revisionError('HEALTH_RECORD_INVALID', '健康记录版本无效，请联系管理员')
  }
  return revision
}

function assertExpectedRecordRevision(current = {}, expectedRecordRevision) {
  if (!Number.isSafeInteger(expectedRecordRevision) || expectedRecordRevision < 0) {
    throw revisionError('INVALID_HEALTH_RECORD_REVISION', '请先刷新当天记录后再保存')
  }
  const storedRevision = currentRecordRevision(current)
  // Empty records are returned as content-free revision markers. Comparing the
  // stored revision prevents an initial rev-0 form from passing after another
  // device has created and then cleared the same date (empty -> data -> empty).
  if (storedRevision !== expectedRecordRevision) {
    throw revisionError('HEALTH_RECORD_REVISION_CONFLICT', '这一天已在其他设备更新，请刷新后重新确认')
  }
  return storedRevision
}

function mergedExercise(currentExercise, inputExercise) {
  if (!inputExercise || inputExercise.completed !== true) return null
  const trusted = currentExercise && typeof currentExercise === 'object' && !Array.isArray(currentExercise)
    ? currentExercise : {}
  return {
    ...trusted,
    completed: true,
    type: inputExercise.type,
    durationMinutes: inputExercise.durationMinutes,
    intensity: inputExercise.intensity,
  }
}

function hasDailyContent(record = {}) {
  return typeof record.weight === 'number'
    || Boolean(fileId(record.photoFileId))
    || Boolean(record.exercise && record.exercise.completed === true)
    || Boolean(typeof record.note === 'string' && record.note.trim())
}

function planDailyUpdate(current = {}, input = {}) {
  assertSupportedHealthSchema(current)
  const currentRevision = assertExpectedRecordRevision(current, input.expectedRecordRevision)
  const previousPhotoFileId = fileId(current.photoFileId)
  const uploadedPhotoFileId = fileId(input.uploadedPhotoFileId)
  const clearPhoto = input.clearPhoto === true
  const activePhotoFileId = uploadedPhotoFileId || (clearPhoto ? '' : previousPhotoFileId)
  const data = {
    owner: input.owner,
    date: input.date,
    month: input.month,
    schemaVersion: CURRENT_HEALTH_SCHEMA,
    recordRevision: currentRevision + 1,
    weight: Object.prototype.hasOwnProperty.call(input, 'weight') ? input.weight
      : (typeof current.weight === 'number' ? current.weight : null),
    photoFileId: activePhotoFileId,
    exercise: Object.prototype.hasOwnProperty.call(input, 'exercise')
      ? mergedExercise(current.exercise, input.exercise)
      : (current.exercise || null),
    note: Object.prototype.hasOwnProperty.call(input, 'note') ? input.note : (current.note || ''),
  }
  const tombstoneRecord = !hasDailyContent(data)
  data.tombstone = tombstoneRecord

  return {
    data,
    tombstoneRecord,
    activePhotoFileId,
    replacedPhotoFileId: previousPhotoFileId !== activePhotoFileId ? previousPhotoFileId : '',
  }
}

function photoTicketCleanupFiles(ticket = {}, activePhotoFileId = '') {
  const active = fileId(activePhotoFileId)
  return [...new Set([
    ticket.inboxFileId,
    ticket.permanentFileId,
    ticket.cleanupFileId,
    ticket.fileID,
    ticket.fileId,
  ].map(fileId).filter((candidate) => candidate && candidate !== active))]
}

module.exports = {
  CURRENT_HEALTH_SCHEMA,
  assertSupportedHealthSchema,
  assertExpectedRecordRevision,
  currentRecordRevision,
  hasDailyContent,
  planDailyUpdate,
  photoTicketCleanupFiles,
}
