'use strict'

const cloud = require('wx-server-sdk')
const {
  RETENTION_SCHEMA_VERSION,
  QUERY_STATUSES,
  compactExpiredTask,
  controlMatchesTask,
  safeErrorCode,
} = require('./core')
const { notFound } = require('./not-found')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const TASK_COLLECTION = 'meal_ai_tasks'
const SHARD_COLLECTION = 'meal_ai_shards'
const CONTROL_COLLECTION = 'meal_ai_controls'
const TASKS_PER_STATUS = 5
const MAX_TASKS_PER_RUN = QUERY_STATUSES.length * TASKS_PER_STATUS
const MAX_PENDING_TASKS_PER_RUN = 20
const MAX_SHARDS_PER_TASK = 25
const MAX_SHARDS_PER_RUN = 200
const RETENTION_TERMINAL_STATUSES = new Set(['expired', 'conflict'])

async function readReference(reference) {
  try { return (await reference.get()).data || null }
  catch (error) { if (notFound(error)) return null; throw error }
}

function taskData(task) {
  const { _id, ...data } = task
  return data
}

function validDocumentId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('/')
}

function emptySummary() {
  return {
    success: true,
    scannedTasks: 0,
    compactedTasks: 0,
    skippedTasks: 0,
    controlsCleared: 0,
    pendingShardTasks: 0,
    shardsDeleted: 0,
    shardTasksCompleted: 0,
    errorCount: 0,
    errors: {},
  }
}

function recordError(summary, error, fallback) {
  const code = safeErrorCode(error, fallback)
  summary.success = false
  summary.errorCount += 1
  summary.errors[code] = Number(summary.errors[code] || 0) + 1
}

async function expiredCandidates(database, status, now, limit) {
  const result = await database.collection(TASK_COLLECTION)
    .where({ status, expiresAt: database.command.lte(now) })
    .orderBy('expiresAt', 'asc')
    .limit(limit)
    .get()
  return Array.isArray(result.data) ? result.data : []
}

async function compactCandidate(database, taskId, now) {
  if (!validDocumentId(taskId)) return { state: 'skipped' }
  return database.runTransaction(async (transaction) => {
    const taskReference = transaction.collection(TASK_COLLECTION).doc(taskId)
    const rawTask = await readReference(taskReference)
    if (!rawTask) return { state: 'skipped' }
    const compacted = compactExpiredTask(rawTask, taskId, now)
    if (!compacted) return { state: 'skipped' }

    let controlReference = null
    let control = null
    if (validDocumentId(compacted.owner)) {
      controlReference = transaction.collection(CONTROL_COLLECTION).doc(compacted.owner)
      control = await readReference(controlReference)
    }
    const clearControl = controlMatchesTask(control, compacted)
    await taskReference.set({ data: taskData(compacted.data) })
    if (clearControl) {
      await controlReference.set({ data: { ...control, activeTaskId: '', updatedAt: now } })
    }
    return {
      state: 'compacted',
      controlCleared: clearControl,
      taskId,
      owner: compacted.owner,
    }
  })
}

async function pendingShardTasks(database, limit) {
  const result = await database.collection(TASK_COLLECTION)
    .where({ shardCleanupPending: true })
    .orderBy('shardCleanupUpdatedAtMs', 'asc')
    .limit(limit)
    .get()
  return Array.isArray(result.data) ? result.data : []
}

async function shardBatch(database, owner, taskId, limit) {
  const result = await database.collection(SHARD_COLLECTION)
    .where({ owner, taskId })
    .limit(limit)
    .get()
  return Array.isArray(result.data) ? result.data : []
}

async function markShardCleanupProgress(database, taskId, owner, now, completed) {
  return database.runTransaction(async (transaction) => {
    const taskReference = transaction.collection(TASK_COLLECTION).doc(taskId)
    const task = await readReference(taskReference)
    if (!task || task.owner !== owner || !RETENTION_TERMINAL_STATUSES.has(task.status) ||
        task.retentionSchemaVersion !== RETENTION_SCHEMA_VERSION || task.shardCleanupPending !== true) return false
    await taskReference.update({ data: completed
      ? { shardCleanupPending: false, shardCleanupUpdatedAtMs: now, shardsCleanedAtMs: now }
      : { shardCleanupUpdatedAtMs: now } })
    return true
  })
}

async function cleanShardTask(database, task, now, limit) {
  const taskId = task && task._id
  const owner = task && task.owner
  if (!validDocumentId(taskId) || !validDocumentId(owner) || !RETENTION_TERMINAL_STATUSES.has(task.status) ||
      task.retentionSchemaVersion !== RETENTION_SCHEMA_VERSION || task.shardCleanupPending !== true) {
    return { state: 'skipped', attempted: 0, deleted: 0 }
  }
  const shards = await shardBatch(database, owner, taskId, limit)
  let attempted = 0
  let deleted = 0
  let failure = null
  for (const shard of shards) {
    if (!validDocumentId(shard && shard._id)) continue
    attempted += 1
    try {
      const result = await database.collection(SHARD_COLLECTION).doc(shard._id).remove()
      deleted += Number(result && result.stats && result.stats.removed) > 0 ? 1 : 0
    } catch (error) {
      failure = error
      break
    }
  }
  if (failure) {
    await markShardCleanupProgress(database, taskId, owner, now, false)
    return { state: 'error', attempted, deleted, error: failure, completed: false }
  }
  const drained = shards.length < limit
  const updated = await markShardCleanupProgress(database, taskId, owner, now, drained)
  const completed = drained && updated
  return { state: 'processed', attempted, deleted, completed }
}

async function runMaintenance(database, now = Date.now()) {
  const summary = emptySummary()
  let taskBudget = MAX_TASKS_PER_RUN

  for (const status of QUERY_STATUSES) {
    if (taskBudget <= 0) break
    let candidates
    try {
      candidates = await expiredCandidates(database, status, now, Math.min(TASKS_PER_STATUS, taskBudget))
    } catch (error) {
      recordError(summary, error, 'TASK_QUERY_FAILED')
      continue
    }
    summary.scannedTasks += candidates.length
    taskBudget -= candidates.length
    for (const candidate of candidates) {
      try {
        const result = await compactCandidate(database, candidate && candidate._id, now)
        if (result.state === 'compacted') {
          summary.compactedTasks += 1
          if (result.controlCleared) summary.controlsCleared += 1
        } else summary.skippedTasks += 1
      } catch (error) {
        recordError(summary, error, 'TASK_COMPACTION_FAILED')
      }
    }
  }

  let pending
  try {
    pending = await pendingShardTasks(database, MAX_PENDING_TASKS_PER_RUN)
  } catch (error) {
    recordError(summary, error, 'SHARD_TASK_QUERY_FAILED')
    return summary
  }
  summary.pendingShardTasks = pending.length
  let shardBudget = MAX_SHARDS_PER_RUN
  for (const task of pending) {
    if (shardBudget <= 0) break
    try {
      const result = await cleanShardTask(database, task, now, Math.min(MAX_SHARDS_PER_TASK, shardBudget))
      summary.shardsDeleted += result.deleted
      shardBudget -= result.attempted
      if (result.completed) summary.shardTasksCompleted += 1
      if (result.state === 'skipped') summary.skippedTasks += 1
      if (result.error) recordError(summary, result.error, 'SHARD_DELETE_FAILED')
    } catch (error) {
      recordError(summary, error, 'SHARD_DELETE_FAILED')
    }
  }
  return summary
}

exports.main = async () => {
  const context = cloud.getWXContext() || {}
  if (context.SOURCE !== 'wx_trigger') return { success: false, errorCode: 'TRIGGER_ONLY' }
  const summary = await runMaintenance(db, Date.now())
  console.info('mealAiMaintenance', JSON.stringify(summary))
  return summary
}

exports._test = {
  TASKS_PER_STATUS,
  MAX_TASKS_PER_RUN,
  MAX_PENDING_TASKS_PER_RUN,
  MAX_SHARDS_PER_TASK,
  MAX_SHARDS_PER_RUN,
  validDocumentId,
  expiredCandidates,
  compactCandidate,
  cleanShardTask,
  runMaintenance,
}
