'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const {
  captureScreenshotWithRetry,
  createRun,
  finalizeRunReport,
  LOCAL_AUTOMATOR_DIR,
  navigateAndAcquire,
  safeDisconnect,
  withAutomatorResponseTimeout,
} = require('./automation-runtime')
const {
  classifyPreviewDataSummary,
  classifyRenderedSummary,
  safeEvidenceReport,
} = require('./plan-preview-evidence')
const {
  claimRecoveryJournal,
  clearRecoveryJournal,
  buildReleaseStartRequest,
  parseProbeArguments,
  PUBLIC_TASK_ERROR_CATEGORIES,
  RELEASE_COMPATIBILITY,
  releaseServiceCompatible,
  selectRecoveryAction,
} = require('./ai-safe-release-core')

const ENDPOINT = require('./automator-client').getEndpoint()
const ARGUMENTS = parseProbeArguments(process.argv.slice(2))
const DURATION = ARGUMENTS.duration
const PROCESS_INSTANCE_ID = ARGUMENTS.ok ? crypto.randomBytes(16).toString('hex') : ''
const JOURNAL_PATH = path.join(LOCAL_AUTOMATOR_DIR, 'ai-safe-release-recovery.json')
const EVIDENCE_BASE = path.join(LOCAL_AUTOMATOR_DIR, 'artifacts', 'ai-release-preview')
const PREVIEW_ROUTE = 'pages/plan-preview/plan-preview'
const PREVIEW_URL = `/${PREVIEW_ROUTE}`
const TOTAL_TIMEOUT_MS = (16 + DURATION) * 60 * 1000
const WORKER_SETTLE_TIMEOUT_MS = 90 * 1000
const POLL_MS = 750
const PREVIEW_TIMEOUT_MS = 30000
const SCREENSHOT_TIMEOUT_MS = 20000
const ALLOWED_CODES = new Set([
  'OK', 'INVALID_ARGUMENTS', 'AI_NOT_READY', 'EXISTING_DRAFT', 'EXISTING_TASK',
  'NAMESPACE_MISSING', 'PROBE_ALREADY_INSTALLED', 'PROBE_NOT_INSTALLED', 'PREFLIGHT_FAILED',
  'INVALID_OWNER_TOKEN', 'PROBE_OWNERSHIP_MISMATCH', 'CLEANUP_ALREADY_RUNNING',
  'JOURNAL_INVALID', 'JOURNAL_WRITE_FAILED', 'JOURNAL_LOCKED', 'JOURNAL_LOCK_RELEASE_FAILED',
  'JOURNAL_DURATION_MISMATCH',
  'JOURNAL_OWNERSHIP_MISMATCH', 'PROBE_PROCESS_ACTIVE', 'RECOVERY_STATE_LOST',
  'START_FAILED', 'START_AMBIGUOUS', 'TASK_CAPTURE_MISSING', 'TASK_CAPTURE_CONFLICT',
  'TASK_OWNERSHIP_MISMATCH', 'TASK_CHANGED', 'TASK_INVALID', 'DRAFT_CAPTURE_MISSING',
  'DRAFT_CAPTURE_CONFLICT', 'DRAFT_OWNERSHIP_MISMATCH', 'PREFERENCE_CHANGED',
  'REVISION_CHANGED', 'LOCAL_CONCURRENT_MUTATION', 'WORKER_SETTLE_TIMEOUT',
  'RESTORE_CONFLICT', 'RESTORE_VERIFY_FAILED', 'CLEANUP_INCOMPLETE',
  'AI_KEY_MISSING', 'AI_STORAGE_NOT_READY', 'AI_VERSION_MISMATCH',
  'AI_AUTH_REJECTED', 'AI_FORBIDDEN', 'AI_MODEL_UNAVAILABLE', 'AI_RESPONSES_ENDPOINT_NOT_FOUND',
  'AI_RESPONSES_PARAMETER_REJECTED', 'AI_RESPONSES_PROTOCOL_REJECTED',
  'AI_POLICY_REJECTED', 'AI_NETWORK_FAILED', 'AI_RATE_LIMITED', 'AI_TIMEOUT',
  'AI_UPSTREAM_UNAVAILABLE', 'AI_RESPONSE_CONTRACT_REJECTED', 'AI_STATE_CONFLICT',
  'GENERATION_FAILED', 'GENERATION_TIMEOUT', 'CLOUD_FAILED', 'UNKNOWN',
  'PLAN_PREVIEW_OWNERSHIP_MISMATCH', 'PLAN_PREVIEW_STATE_INVALID',
  'PLAN_PREVIEW_DRAFT_MISMATCH', 'PLAN_PREVIEW_DATA_INVALID',
  'PLAN_PREVIEW_RENDER_INVALID', 'PLAN_PREVIEW_SCREENSHOT_FAILED',
])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function pad(value) { return String(value).padStart(2, '0') }

function testStartDate() {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`
}

function fictionalPreferences(durationDays) {
  return {
    contractVersion: RELEASE_COMPATIBILITY.contractVersion,
    durationDays,
    startDate: testStartDate(),
    mealTypes: ['breakfast'],
    doubleDinner: false,
    goals: ['均衡饮食'],
    styles: ['简单快手'],
    customGoal: '',
    restrictions: '',
    healthNotes: '',
    exerciseIntent: 'none',
    exerciseNotes: '',
    exerciseByDay: Array.from({ length: durationDays }, (_, dayIndex) => ({
      dayIndex, planned: false, type: '', durationMinutes: 0, intensity: 'medium',
    })),
  }
}

function safeCode(value) {
  const code = typeof value === 'string'
    ? value
    : value && typeof value === 'object'
      ? (typeof value.code === 'string' ? value.code : (typeof value.message === 'string' ? value.message : ''))
      : ''
  return ALLOWED_CODES.has(code) ? code : 'UNKNOWN'
}

async function installProbe(miniProgram, preferences, ownerToken, processInstanceId, compatibility) {
  return miniProgram.evaluate(function (testPreferences, requestedOwnerToken, requestedInstanceId, releaseCompatibility) {
    try {
      const app = getApp()
      const key = '__mealAiReleaseProbeV4'
      if (!app || !app.globalData || !wx.cloud || typeof wx.cloud.callFunction !== 'function') {
        return { ok: false, code: 'PROBE_NOT_INSTALLED' }
      }
      if (typeof requestedOwnerToken !== 'string' || !/^[a-f0-9]{48}$/.test(requestedOwnerToken)) {
        return { ok: false, code: 'INVALID_OWNER_TOKEN' }
      }
      if (typeof requestedInstanceId !== 'string' || !/^[a-f0-9]{32}$/.test(requestedInstanceId)) {
        return { ok: false, code: 'INVALID_OWNER_TOKEN' }
      }
      if (app.globalData[key]) {
        return { ok: false, code: 'PROBE_ALREADY_INSTALLED' }
      }
      if (app.globalData.__mealAiReleaseProbeV3 && app.globalData.__mealAiReleaseProbeV3.installed) {
        return { ok: false, code: 'PROBE_ALREADY_INSTALLED' }
      }
      const originalCallFunction = wx.cloud.callFunction
      const canonical = (value) => {
        if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
        if (value && typeof value === 'object') {
          return `{${Object.keys(value).sort().map((name) => `${JSON.stringify(name)}:${canonical(value[name])}`).join(',')}}`
        }
        return JSON.stringify(value)
      }
      const same = (left, right) => canonical(left) === canonical(right)
      const mutating = (options) => {
        const name = options && options.name
        const data = options && options.data
        const action = data && data.action
        return (name === 'aiPlanner' && (['start', 'advance', 'cancel', 'current'].includes(action)
          || (action === 'status' && Boolean(data.taskId))))
          || (name === 'userData' && ['bootstrap', 'saveState', 'confirmDraft', 'restoreHistory', 'discardDraft'].includes(action))
      }
      const state = {
        installed: true,
        ownerToken: requestedOwnerToken,
        ownerInstanceId: requestedInstanceId,
        cleanupLocked: false,
        cleanupLockOwnerToken: '',
        cleanupLockOwnerInstanceId: '',
        previewEvidenceActive: false,
        originalCallFunction,
        internalOptions: new Set(),
        localConcurrentMutation: false,
        stopRequested: false,
        running: false,
        stopped: false,
        workerSettled: false,
        worker: null,
        namespace: '',
        providerRevision: 0,
        originalPreferences: null,
        testPreferences: JSON.parse(JSON.stringify(testPreferences)),
        releaseCompatibility: JSON.parse(JSON.stringify(releaseCompatibility)),
        expectedTestPreferences: null,
        baselineInvariant: null,
        baseRevision: null,
        expectedRevision: null,
        startRequest: null,
        startAttempted: false,
        startAmbiguous: false,
        startCommitted: false,
        startRejected: false,
        testSave: { attempted: false, ambiguous: false, committed: false, beforeRevision: null },
        advance: { attempted: false, ambiguous: false, committed: false },
        cancel: { attempted: false, ambiguous: false, committed: false, request: null },
        discard: { attempted: false, ambiguous: false, committed: false, request: null },
        restore: { attempted: false, ambiguous: false, committed: false, request: null },
        taskId: '',
        taskRevision: null,
        taskStatus: '',
        taskFailureCode: '',
        draftPlanId: '',
        finalStateRevision: null,
        taskCaptureConflict: false,
        draftCaptureConflict: false,
        progressPercent: 0,
        generated: false,
        clientReadable: false,
        terminalCode: '',
        cleanupStarted: false,
        cleanupComplete: false,
      }
      const wrappedCallFunction = function (options) {
        const internal = state.internalOptions.has(options)
        if (internal) state.internalOptions.delete(options)
        const data = options && options.data
        const previewBootstrap = state.previewEvidenceActive && options && options.name === 'userData'
          && data && data.action === 'bootstrap' && data.expectedCacheNamespace === state.namespace
        if (!internal && !previewBootstrap && mutating(options)) state.localConcurrentMutation = true

        if (internal && options.name === 'aiPlanner' && data) {
          if (data.action === 'start' && state.startRequest && !same(data, state.startRequest)) {
            state.taskCaptureConflict = true
          } else if (['advance', 'status', 'cancel'].includes(data.action)
            && state.taskId && data.taskId !== state.taskId) {
            state.taskCaptureConflict = true
          }
        }
        return originalCallFunction.call(this, options)
      }
      state.wrappedCallFunction = wrappedCallFunction
      wx.cloud.callFunction = wrappedCallFunction
      app.globalData[key] = state
      return { ok: true, code: 'OK' }
    } catch (_) {
      return { ok: false, code: 'UNKNOWN' }
    }
  }, preferences, ownerToken, processInstanceId, compatibility)
}

async function inspectProbe(miniProgram, ownerToken) {
  return miniProgram.evaluate(function (requestedOwnerToken) {
    try {
      const app = getApp()
      const state = app && app.globalData && app.globalData.__mealAiReleaseProbeV4
      if (!state) return { ok: true, code: 'OK', probeState: 'absent' }
      return {
        ok: true,
        code: 'OK',
        probeState: state.ownerToken === requestedOwnerToken ? 'owned' : 'foreign',
      }
    } catch (_) {
      return { ok: false, code: 'UNKNOWN', probeState: 'foreign' }
    }
  }, ownerToken)
}

async function adoptProbe(miniProgram, ownerToken, processInstanceId) {
  return miniProgram.evaluate(function (requestedOwnerToken, requestedInstanceId) {
    try {
      const app = getApp()
      const state = app && app.globalData && app.globalData.__mealAiReleaseProbeV4
      if (!state || !state.installed) return { ok: false, code: 'PROBE_NOT_INSTALLED' }
      if (state.ownerToken !== requestedOwnerToken) {
        return { ok: false, code: 'PROBE_OWNERSHIP_MISMATCH' }
      }
      if (typeof requestedInstanceId !== 'string' || !/^[a-f0-9]{32}$/.test(requestedInstanceId)) {
        return { ok: false, code: 'PROBE_OWNERSHIP_MISMATCH' }
      }
      state.ownerInstanceId = requestedInstanceId
      if (state.cleanupLocked && state.cleanupLockOwnerInstanceId !== requestedInstanceId) {
        state.cleanupLocked = false
        state.cleanupLockOwnerToken = ''
        state.cleanupLockOwnerInstanceId = ''
      }
      return { ok: true, code: 'OK' }
    } catch (_) {
      return { ok: false, code: 'UNKNOWN' }
    }
  }, ownerToken, processInstanceId)
}

async function startProbe(miniProgram, ownerToken, processInstanceId) {
  return miniProgram.evaluate(function (requestedOwnerToken, requestedInstanceId, publicTaskErrorCategories) {
    const app = getApp()
    const key = '__mealAiReleaseProbeV4'
    const state = app && app.globalData && app.globalData[key]
    const activeStatuses = new Set(['queued', 'running', 'finalizing'])
    const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'conflict'])
    const allStatuses = new Set([...activeStatuses, ...terminalStatuses])
    const validNamespace = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
    const validTaskId = (value) => typeof value === 'string' && /^task_[A-Za-z0-9_-]{43}$/.test(value)
    const validPlanId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 120
    const validRevision = (value) => Number.isSafeInteger(value) && value >= 0
    const allowedTaskFailureCategories = new Set([
      'AI_KEY_MISSING', 'AI_STORAGE_NOT_READY', 'AI_VERSION_MISMATCH',
      'AI_AUTH_REJECTED', 'AI_FORBIDDEN', 'AI_MODEL_UNAVAILABLE', 'AI_RESPONSES_ENDPOINT_NOT_FOUND',
      'AI_RESPONSES_PARAMETER_REJECTED', 'AI_RESPONSES_PROTOCOL_REJECTED',
      'AI_POLICY_REJECTED', 'AI_NETWORK_FAILED', 'AI_RATE_LIMITED', 'AI_TIMEOUT',
      'AI_UPSTREAM_UNAVAILABLE', 'AI_RESPONSE_CONTRACT_REJECTED', 'AI_STATE_CONFLICT',
      'GENERATION_FAILED',
    ])
    const classifiedTaskFailure = (value) => {
      if (typeof value !== 'string' || !publicTaskErrorCategories
        || typeof publicTaskErrorCategories !== 'object' || Array.isArray(publicTaskErrorCategories)
        || !Object.prototype.hasOwnProperty.call(publicTaskErrorCategories, value)) return 'GENERATION_FAILED'
      const category = publicTaskErrorCategories[value]
      return allowedTaskFailureCategories.has(category) ? category : 'GENERATION_FAILED'
    }
    const clone = (value) => JSON.parse(JSON.stringify(value))
    const canonical = (value) => {
      if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
      if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((name) => `${JSON.stringify(name)}:${canonical(value[name])}`).join(',')}}`
      }
      return JSON.stringify(value)
    }
    const same = (left, right) => canonical(left) === canonical(right)
    const blockedKeys = new Set(['__proto__', 'prototype', 'constructor'])
    const trustedArrayKey = (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
      if (typeof value.id === 'string' && value.id) return `id:${value.id}`
      if (Number.isSafeInteger(value.dayIndex)) return `day:${value.dayIndex}`
      return ''
    }
    const mergeTrustedUnknown = (sanitized, trusted, depth = 0) => {
      if (depth > 40) throw new Error('depth')
      if (Array.isArray(sanitized)) {
        if (!Array.isArray(trusted)) return clone(sanitized)
        const byKey = new Map()
        trusted.forEach((item) => {
          const itemKey = trustedArrayKey(item)
          if (itemKey && !byKey.has(itemKey)) byKey.set(itemKey, item)
        })
        return sanitized.map((item, index) => {
          const itemKey = trustedArrayKey(item)
          return mergeTrustedUnknown(item, itemKey ? byKey.get(itemKey) : trusted[index], depth + 1)
        })
      }
      if (!sanitized || typeof sanitized !== 'object' || !trusted || typeof trusted !== 'object'
        || Array.isArray(trusted)) return clone(sanitized)
      if (typeof sanitized.id === 'string' && sanitized.id
        && typeof trusted.id === 'string' && trusted.id && sanitized.id !== trusted.id) return clone(sanitized)
      if (Number.isSafeInteger(sanitized.dayIndex) && Number.isSafeInteger(trusted.dayIndex)
        && sanitized.dayIndex !== trusted.dayIndex) return clone(sanitized)
      const result = {}
      Object.keys(sanitized).forEach((name) => {
        if (!blockedKeys.has(name)) result[name] = mergeTrustedUnknown(sanitized[name], trusted[name], depth + 1)
      })
      Object.keys(trusted).forEach((name) => {
        if (!blockedKeys.has(name) && !Object.prototype.hasOwnProperty.call(result, name)) {
          result[name] = clone(trusted[name])
        }
      })
      return result
    }
    const invariant = (value) => {
      const result = {}
      const allowed = new Set(['stateRevision', 'generationPreferences', 'draftPlan', 'updatedAt'])
      Object.keys(value || {}).sort().forEach((name) => {
        if (!allowed.has(name) && !blockedKeys.has(name)) result[name] = clone(value[name])
      })
      return result
    }
    const invariantMatches = (value) => same(invariant(value), state.baselineInvariant)
    const testPreferences = () => state.expectedTestPreferences
    const clientReadablePlan = (value) => {
      const plan = value && value.draftPlan
      const preferences = testPreferences()
      if (!plan || typeof plan !== 'object' || !preferences || plan.id !== state.draftPlanId
        || plan.source !== 'ai' || plan.contractVersion !== preferences.contractVersion
        || plan.durationDays !== preferences.durationDays || plan.startDate !== preferences.startDate
        || typeof plan.title !== 'string' || !plan.title.trim()
        || typeof plan.generatedAt !== 'string' || Number.isNaN(Date.parse(plan.generatedAt))
        || !Array.isArray(plan.rationale) || !plan.rationale.length
        || !Array.isArray(plan.days) || plan.days.length !== preferences.durationDays
        || !Array.isArray(plan.shoppingGroups) || !plan.shoppingGroups.length
        || !plan.generationBasis || !same(plan.generationBasis.mealTypes, preferences.mealTypes)
        || plan.generationBasis.doubleDinner !== preferences.doubleDinner) return false
      const expectedMealKeys = preferences.mealTypes.flatMap((type) => (
        type === 'dinner' && preferences.doubleDinner
          ? ['dinner:rest', 'dinner:workout'] : [`${type}:default`]
      ))
      if (!plan.days.every((day, dayIndex) => {
        if (!day || typeof day !== 'object' || !day.exercise || day.exercise.dayIndex !== dayIndex
          || !Array.isArray(day.meals) || day.meals.length !== expectedMealKeys.length) return false
        const keys = day.meals.map((meal) => `${meal.type}:${meal.scenario}`)
        if (!same(keys, expectedMealKeys)) return false
        return day.meals.every((meal) => typeof meal.id === 'string' && meal.id
          && typeof meal.title === 'string' && meal.title.trim()
          && typeof meal.method === 'string' && meal.method.trim()
          && Array.isArray(meal.ingredients) && meal.ingredients.length
          && meal.ingredients.every((ingredient) => ingredient && typeof ingredient === 'object'
            && typeof ingredient.name === 'string' && ingredient.name.trim()
            && Number.isFinite(ingredient.quantity) && ingredient.quantity > 0
            && typeof ingredient.unit === 'string' && ingredient.unit.trim()
            && typeof ingredient.category === 'string' && ingredient.category.trim()))
      })) return false
      return plan.shoppingGroups.every((group) => group && typeof group === 'object'
        && typeof group.id === 'string' && group.id
        && typeof group.name === 'string' && group.name.trim()
        && Array.isArray(group.items) && group.items.length
        && group.items.every((item) => item && typeof item.id === 'string' && item.id
          && typeof item.name === 'string' && item.name.trim()
          && typeof item.amount === 'string' && item.amount.trim()))
    }
    const testSaveSnapshot = (value, beforeRevision) => {
      if (!value || !validRevision(beforeRevision) || !validRevision(value.stateRevision)
        || value.draftPlan || !invariantMatches(value)) return 'conflict'
      if (value.stateRevision === beforeRevision + 1
        && same(value.generationPreferences, testPreferences())) return 'committed'
      if (value.stateRevision === beforeRevision
        && same(value.generationPreferences, state.originalPreferences)) return 'baseline'
      return 'conflict'
    }
    const acceptTestSave = (value, beforeRevision) => {
      if (testSaveSnapshot(value, beforeRevision) !== 'committed') return false
      state.testSave.committed = true
      state.testSave.ambiguous = false
      state.expectedRevision = value.stateRevision
      return true
    }
    const envelopeCode = (envelope) => {
      const code = envelope && envelope.code
      if (code === 'STATE_REVISION_CONFLICT') return 'REVISION_CHANGED'
      if (code === 'TASK_REVISION_CONFLICT') return 'TASK_CHANGED'
      if (code === 'ACTIVE_TASK_EXISTS') return 'EXISTING_TASK'
      if (code === 'AI_CONFIGURATION_INVALID') return 'AI_KEY_MISSING'
      if (code === 'AI_STORAGE_NOT_READY') return 'AI_STORAGE_NOT_READY'
      return 'UNKNOWN'
    }
    const call = async (name, data) => {
      const options = { name, data }
      state.internalOptions.add(options)
      try {
        const response = await wx.cloud.callFunction(options)
        const envelope = response && response.result
        if (!envelope || envelope.success !== true) {
          return { ok: false, ambiguous: false, code: envelopeCode(envelope), data: null }
        }
        return { ok: true, ambiguous: false, code: 'OK', data: envelope.data }
      } catch (_) {
        state.internalOptions.delete(options)
        return { ok: false, ambiguous: true, code: 'CLOUD_FAILED', data: null }
      }
    }
    const fail = (code) => {
      state.terminalCode = code
      state.running = false
      state.stopped = true
      return { ok: false, code }
    }
    const captureTask = (payload, requireStart) => {
      const task = payload && payload.task
      if (!task || !validTaskId(task.taskId)) return requireStart ? 'TASK_CAPTURE_MISSING' : 'TASK_INVALID'
      if (!allStatuses.has(task.status) || !validRevision(task.taskRevision)
        || !Number.isInteger(task.progressPercent) || task.progressPercent < 0 || task.progressPercent > 100) {
        return 'TASK_INVALID'
      }
      if (state.taskId && state.taskId !== task.taskId) {
        state.taskCaptureConflict = true
        return 'TASK_CAPTURE_CONFLICT'
      }
      if (validRevision(state.taskRevision) && task.taskRevision < state.taskRevision) return 'TASK_CHANGED'
      state.taskId = task.taskId
      state.taskRevision = task.taskRevision
      state.taskStatus = task.status
      state.taskFailureCode = terminalStatuses.has(task.status) && task.status !== 'succeeded'
        ? classifiedTaskFailure(task.errorCode) : ''
      state.progressPercent = task.progressPercent
      if (validRevision(task.resultStateRevision)) state.finalStateRevision = task.resultStateRevision
      const result = payload && payload.result && typeof payload.result === 'object' ? payload.result : null
      const draft = result && result.draftPlan
      if (draft && validPlanId(draft.id)) {
        if (state.draftPlanId && state.draftPlanId !== draft.id) {
          state.draftCaptureConflict = true
          return 'DRAFT_CAPTURE_CONFLICT'
        }
        state.draftPlanId = draft.id
        if (validRevision(result.stateRevision)) state.finalStateRevision = result.stateRevision
      }
      return 'OK'
    }
    const bootstrap = () => call('userData', {
      action: 'bootstrap', expectedCacheNamespace: state.namespace,
    })
    const reconcileTestSave = async (beforeRevision, retryWhenBaseline) => {
      const observed = await bootstrap()
      if (!observed.ok || !observed.data) return observed.ok ? 'REVISION_CHANGED' : observed.code
      const classification = testSaveSnapshot(observed.data, beforeRevision)
      if (classification === 'committed') {
        acceptTestSave(observed.data, beforeRevision)
        return 'OK'
      }
      if (classification !== 'baseline' || !retryWhenBaseline) return 'REVISION_CHANGED'
      const retried = await call('userData', {
        action: 'saveState', state: { generationPreferences: clone(testPreferences()) },
        expectedStateRevision: beforeRevision, expectedCacheNamespace: state.namespace,
      })
      if (retried.ok && acceptTestSave(retried.data, beforeRevision)) return 'OK'
      if (!retried.ok && !retried.ambiguous) return retried.code
      state.testSave.ambiguous = state.testSave.ambiguous || retried.ambiguous
      return reconcileTestSave(beforeRevision, false)
    }
    const verifySuccessfulTestSave = async (response, beforeRevision) => {
      if (acceptTestSave(response, beforeRevision)) return 'OK'
      const observed = await bootstrap()
      if (!observed.ok || !observed.data) return observed.ok ? 'REVISION_CHANGED' : observed.code
      return acceptTestSave(observed.data, beforeRevision) ? 'OK' : 'REVISION_CHANGED'
    }
    const recoverStart = async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const replay = await call('aiPlanner', clone(state.startRequest))
        if (replay.ok && replay.data) {
          const captured = captureTask(replay.data, true)
          if (captured !== 'OK') return captured
          state.startAmbiguous = false
          state.startCommitted = true
          return 'OK'
        }
        if (!replay.ambiguous) return replay.code
        state.startAmbiguous = true
      }
      return 'START_AMBIGUOUS'
    }
    const worker = async () => {
      try {
        const member = await call('membership', { action: 'status' })
        const namespace = member.ok && member.data && member.data.cacheNamespace
        if (!member.ok) return fail(member.code)
        if (!validNamespace(namespace)) return fail('NAMESPACE_MISSING')
        state.namespace = namespace

        const baseline = await bootstrap()
        if (!baseline.ok || !baseline.data) return fail(baseline.ok ? 'PREFLIGHT_FAILED' : baseline.code)
        if (baseline.data.draftPlan) return fail('EXISTING_DRAFT')
        if (!validRevision(baseline.data.stateRevision)) return fail('PREFLIGHT_FAILED')
        state.originalPreferences = clone(baseline.data.generationPreferences)
        state.expectedTestPreferences = mergeTrustedUnknown(state.testPreferences, state.originalPreferences)
        state.baselineInvariant = invariant(baseline.data)
        state.baseRevision = baseline.data.stateRevision

        const current = await call('aiPlanner', {
          action: 'current', expectedCacheNamespace: state.namespace,
        })
        if (!current.ok) return fail(current.code)
        if (current.data) return fail('EXISTING_TASK')

        const service = await call('aiPlanner', {
          action: 'status', expectedCacheNamespace: state.namespace,
        })
        const compatibility = state.releaseCompatibility || {}
        if (!service.ok || !service.data) return fail(service.ok ? 'AI_NOT_READY' : service.code)
        if (service.data.configured !== true) return fail('AI_KEY_MISSING')
        if (service.data.storageReady !== true) return fail('AI_STORAGE_NOT_READY')
        if (service.data.contractVersion !== compatibility.contractVersion
          || String(service.data.plannerVersion) !== compatibility.plannerVersion
          || service.data.aiDataConsentVersion !== compatibility.aiDataConsentVersion
          || service.data.providerContractRevision !== compatibility.providerContractRevision
          || !Number.isSafeInteger(service.data.providerRevision)
          || service.data.providerRevision < 1) return fail('AI_VERSION_MISMATCH')
        state.providerRevision = service.data.providerRevision
        if (typeof service.data.providerConfigVersion !== 'string'
          || !/^[a-f0-9]{64}$/.test(service.data.providerConfigVersion)) return fail('AI_VERSION_MISMATCH')
        if (state.stopRequested || state.localConcurrentMutation) {
          return fail(state.localConcurrentMutation ? 'LOCAL_CONCURRENT_MUTATION' : 'GENERATION_FAILED')
        }

        state.testSave.attempted = true
        state.testSave.beforeRevision = state.baseRevision
        const saveTest = await call('userData', {
          action: 'saveState', state: { generationPreferences: clone(testPreferences()) },
          expectedStateRevision: state.baseRevision, expectedCacheNamespace: state.namespace,
        })
        if (saveTest.ok) {
          const verifiedSave = await verifySuccessfulTestSave(saveTest.data, state.baseRevision)
          if (verifiedSave !== 'OK') return fail(verifiedSave)
        } else if (saveTest.ambiguous) {
          state.testSave.ambiguous = true
          const reconciled = await reconcileTestSave(state.baseRevision, true)
          if (reconciled !== 'OK') return fail(reconciled)
        } else return fail(saveTest.code)

        const verified = await bootstrap()
        if (!verified.ok || !verified.data) return fail(verified.ok ? 'PREFLIGHT_FAILED' : verified.code)
        if (verified.data.stateRevision !== state.expectedRevision
          || !same(verified.data.generationPreferences, state.expectedTestPreferences)
          || verified.data.draftPlan || !invariantMatches(verified.data)) return fail('REVISION_CHANGED')
        if (state.stopRequested || state.localConcurrentMutation) {
          return fail(state.localConcurrentMutation ? 'LOCAL_CONCURRENT_MUTATION' : 'GENERATION_FAILED')
        }

        const currentAgain = await call('aiPlanner', {
          action: 'current', expectedCacheNamespace: state.namespace,
        })
        if (!currentAgain.ok) return fail(currentAgain.code)
        if (currentAgain.data) return fail('EXISTING_TASK')

        const randomResult = await new Promise((resolve) => {
          wx.getRandomValues({ length: 24, success: resolve, fail: () => resolve(null) })
        })
        if (!randomResult || !randomResult.randomValues) return fail('START_FAILED')
        const bytes = new Uint8Array(randomResult.randomValues)
        const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
        state.startRequest = {
          action: 'start', preferences: clone(state.expectedTestPreferences),
          expectedStateRevision: state.expectedRevision, clientRequestId: suffix,
          aiDataConsent: {
            accepted: true,
            version: compatibility.aiDataConsentVersion,
            providerRevision: state.providerRevision,
          },
          expectedCacheNamespace: state.namespace,
        }
        state.startAttempted = true
        let started = await call('aiPlanner', clone(state.startRequest))
        if (!started.ok && started.ambiguous) {
          state.startAmbiguous = true
          const recovered = await recoverStart()
          if (recovered !== 'OK') return fail(recovered)
          started = null
        } else if (!started.ok) {
          state.startRejected = true
          return fail(started.code)
        }
        if (started) {
          if (!started.data) {
            state.startAmbiguous = true
            return fail('START_AMBIGUOUS')
          }
          const captured = captureTask(started.data, true)
          if (captured !== 'OK') {
            state.startAmbiguous = true
            return fail(captured)
          }
          state.startCommitted = true
        }
        if (state.stopRequested || state.localConcurrentMutation) {
          return fail(state.localConcurrentMutation ? 'LOCAL_CONCURRENT_MUTATION' : 'GENERATION_FAILED')
        }

        state.running = true
        while (!state.stopRequested) {
          if (state.localConcurrentMutation) return fail('LOCAL_CONCURRENT_MUTATION')
          if (state.taskCaptureConflict) return fail('TASK_CAPTURE_CONFLICT')
          if (state.draftCaptureConflict) return fail('DRAFT_CAPTURE_CONFLICT')
          const beforeRevision = state.taskRevision
          state.advance.attempted = true
          const advanced = await call('aiPlanner', {
            action: 'advance', taskId: state.taskId, expectedCacheNamespace: state.namespace,
          })
          if (!advanced.ok || !advanced.data) {
            if (!advanced.ambiguous) return fail(advanced.code)
            state.advance.ambiguous = true
            const observed = await call('aiPlanner', {
              action: 'status', taskId: state.taskId, expectedCacheNamespace: state.namespace,
            })
            if (!observed.ok || !observed.data) return fail(observed.ok ? 'TASK_INVALID' : observed.code)
            const observedCapture = captureTask(observed.data, false)
            if (observedCapture !== 'OK') return fail(observedCapture)
            state.advance.committed = state.taskRevision > beforeRevision
              || terminalStatuses.has(state.taskStatus)
            return fail('CLOUD_FAILED')
          }
          const captured = captureTask(advanced.data, false)
          if (captured !== 'OK') return fail(captured)
          state.advance.committed = state.taskRevision > beforeRevision
            || terminalStatuses.has(state.taskStatus)
          if (state.taskStatus === 'succeeded') {
            if (!state.draftPlanId) {
              const status = await call('aiPlanner', {
                action: 'status', taskId: state.taskId, expectedCacheNamespace: state.namespace,
              })
              if (!status.ok || !status.data) return fail(status.ok ? 'TASK_INVALID' : status.code)
              const statusCapture = captureTask(status.data, false)
              if (statusCapture !== 'OK') return fail(statusCapture)
            }
            if (!state.draftPlanId) return fail('DRAFT_CAPTURE_MISSING')
            const clientRead = await bootstrap()
            if (!clientRead.ok || !clientRead.data) {
              return fail(clientRead.ok ? 'DRAFT_CAPTURE_MISSING' : clientRead.code)
            }
            if (!clientReadablePlan(clientRead.data)
              || !validRevision(state.finalStateRevision)
              || clientRead.data.stateRevision !== state.finalStateRevision
              || !same(clientRead.data.generationPreferences, testPreferences())
              || !invariantMatches(clientRead.data)) {
              return fail('DRAFT_CAPTURE_CONFLICT')
            }
            state.clientReadable = true
            state.generated = true
            state.running = false
            state.terminalCode = 'OK'
            return { ok: true, code: 'OK' }
          }
          if (!activeStatuses.has(state.taskStatus)) return fail(state.taskFailureCode || 'GENERATION_FAILED')
        }
        state.running = false
        state.stopped = true
        return { ok: false, code: 'GENERATION_FAILED' }
      } catch (_) {
        return fail('UNKNOWN')
      } finally {
        state.running = false
        state.workerSettled = true
      }
    }
    try {
      if (!state || !state.installed) return { ok: false, code: 'PROBE_NOT_INSTALLED' }
      if (state.ownerToken !== requestedOwnerToken) return { ok: false, code: 'PROBE_OWNERSHIP_MISMATCH' }
      if (state.ownerInstanceId !== requestedInstanceId) return { ok: false, code: 'PROBE_OWNERSHIP_MISMATCH' }
      if (state.worker || state.running) return { ok: false, code: 'PROBE_ALREADY_INSTALLED' }
      state.worker = worker()
      state.worker.catch(() => { fail('UNKNOWN') })
      return { ok: true, code: 'OK' }
    } catch (_) {
      return { ok: false, code: 'UNKNOWN' }
    }
  }, ownerToken, processInstanceId, PUBLIC_TASK_ERROR_CATEGORIES)
}

async function probeStatus(miniProgram, ownerToken, processInstanceId) {
  return miniProgram.evaluate(function (requestedOwnerToken, requestedInstanceId) {
    try {
      const app = getApp()
      const state = app && app.globalData && app.globalData.__mealAiReleaseProbeV4
      if (!state || !state.installed) return { ok: false, code: 'PROBE_NOT_INSTALLED' }
      if (state.ownerToken !== requestedOwnerToken) return { ok: false, code: 'PROBE_OWNERSHIP_MISMATCH' }
      if (state.ownerInstanceId !== requestedInstanceId) return { ok: false, code: 'PROBE_OWNERSHIP_MISMATCH' }
      if (state.localConcurrentMutation) return { ok: false, code: 'LOCAL_CONCURRENT_MUTATION' }
      if (state.taskCaptureConflict) return { ok: false, code: 'TASK_CAPTURE_CONFLICT' }
      if (state.draftCaptureConflict) return { ok: false, code: 'DRAFT_CAPTURE_CONFLICT' }
      return {
        ok: true,
        code: state.terminalCode || 'OK',
        running: state.running === true,
        stopped: state.stopped === true,
        taskCaptured: Boolean(state.taskId),
        draftCaptured: Boolean(state.draftPlanId),
        clientReadable: state.clientReadable === true,
        generated: state.generated === true,
        progressPercent: Number.isInteger(state.progressPercent) && state.progressPercent >= 0
          && state.progressPercent <= 100 ? state.progressPercent : 0,
      }
    } catch (_) {
      return { ok: false, code: 'UNKNOWN' }
    }
  }, ownerToken, processInstanceId)
}

function fixedPreviewError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

async function setPreviewEvidenceMode(miniProgram, ownerToken, processInstanceId, enabled) {
  return withAutomatorResponseTimeout(() => miniProgram.evaluate(function (
    requestedOwnerToken, requestedInstanceId, requestedEnabled,
  ) {
    try {
      const app = getApp()
      const state = app && app.globalData && app.globalData.__mealAiReleaseProbeV4
      if (!state || !state.installed || state.ownerToken !== requestedOwnerToken
        || state.ownerInstanceId !== requestedInstanceId || state.localConcurrentMutation) {
        return { ok: false, code: 'PLAN_PREVIEW_OWNERSHIP_MISMATCH' }
      }
      if (requestedEnabled && (!state.generated || !state.clientReadable || !state.draftPlanId)) {
        return { ok: false, code: 'PLAN_PREVIEW_DRAFT_MISMATCH' }
      }
      state.previewEvidenceActive = requestedEnabled === true
      return { ok: true, code: 'OK' }
    } catch (_) {
      return { ok: false, code: 'PLAN_PREVIEW_OWNERSHIP_MISMATCH' }
    }
  }, ownerToken, processInstanceId, enabled === true), {
    stage: enabled ? 'PLAN_PREVIEW_EVIDENCE_BEGIN' : 'PLAN_PREVIEW_EVIDENCE_END',
    timeoutMs: PREVIEW_TIMEOUT_MS,
  })
}

async function readPreviewDataSummary(miniProgram, page, ownerToken, processInstanceId) {
  if (!page || page.path !== PREVIEW_ROUTE) {
    return {
      ownerMatched: false, routeMatched: false, viewState: 'invalid', draftMatched: false, fields: {},
    }
  }
  const data = await withAutomatorResponseTimeout(() => page.data(), {
    stage: 'PLAN_PREVIEW_DATA_READ', timeoutMs: PREVIEW_TIMEOUT_MS,
  })
  const plan = data && data.plan
  const ownership = await withAutomatorResponseTimeout(() => miniProgram.evaluate(function (
    requestedOwnerToken, requestedInstanceId, observedDraftPlanId,
  ) {
    try {
      const app = getApp()
      const state = app && app.globalData && app.globalData.__mealAiReleaseProbeV4
      const ownerMatched = Boolean(state && state.installed && state.ownerToken === requestedOwnerToken
        && state.ownerInstanceId === requestedInstanceId && state.previewEvidenceActive
        && !state.localConcurrentMutation)
      return {
        ownerMatched,
        draftMatched: Boolean(ownerMatched && typeof observedDraftPlanId === 'string'
          && observedDraftPlanId && observedDraftPlanId === state.draftPlanId),
      }
    } catch (_) {
      return { ownerMatched: false, draftMatched: false }
    }
  }, ownerToken, processInstanceId, plan && plan.id), {
    stage: 'PLAN_PREVIEW_OWNERSHIP_READ', timeoutMs: PREVIEW_TIMEOUT_MS,
  })
  const firstDay = plan && Array.isArray(plan.days) ? plan.days[0] : null
  const firstMeal = firstDay && Array.isArray(firstDay.meals) ? firstDay.meals[0] : null
  return {
    ownerMatched: ownership && ownership.ownerMatched === true,
    routeMatched: page.path === PREVIEW_ROUTE,
    viewState: data && data.viewState,
    draftMatched: ownership && ownership.draftMatched === true,
    fields: {
      title: Boolean(plan && typeof plan.title === 'string' && plan.title.trim()),
      firstMeal: Boolean(firstMeal && typeof firstMeal.title === 'string' && firstMeal.title.trim()),
      ingredients: Boolean(firstMeal && Array.isArray(firstMeal.ingredientItems)
        && firstMeal.ingredientItems.length
        && firstMeal.ingredientItems.every((item) => typeof item === 'string' && item.trim())),
      method: Boolean(firstMeal && typeof firstMeal.method === 'string' && firstMeal.method.trim()),
    },
  }
}

async function waitForPreviewData(miniProgram, page, ownerToken, processInstanceId) {
  const deadline = Date.now() + PREVIEW_TIMEOUT_MS
  let summary = null
  while (Date.now() <= deadline) {
    summary = await readPreviewDataSummary(miniProgram, page, ownerToken, processInstanceId)
    const code = classifyPreviewDataSummary(summary)
    if (code === 'OK') return summary
    if (['PLAN_PREVIEW_OWNERSHIP_MISMATCH', 'PLAN_PREVIEW_DRAFT_MISMATCH', 'PLAN_PREVIEW_DATA_INVALID'].includes(code)) {
      throw fixedPreviewError(code)
    }
    await sleep(200)
  }
  throw fixedPreviewError(classifyPreviewDataSummary(summary))
}

async function renderedPreviewSummary(page) {
  const selectors = Object.freeze({
    title: '.page-title', firstMeal: '.meal-title', ingredients: '.ingredient-item', method: '.meal-method',
  })
  const result = {}
  for (const [name, selector] of Object.entries(selectors)) {
    const nodes = await withAutomatorResponseTimeout(() => page.$$(selector), {
      stage: `PLAN_PREVIEW_${name.toUpperCase()}_SELECT`, timeoutMs: PREVIEW_TIMEOUT_MS,
    })
    let visibleText = false
    for (const node of nodes) {
      const [text, size] = await Promise.all([
        withAutomatorResponseTimeout(() => node.text(), {
          stage: `PLAN_PREVIEW_${name.toUpperCase()}_TEXT`, timeoutMs: PREVIEW_TIMEOUT_MS,
        }),
        withAutomatorResponseTimeout(() => node.size(), {
          stage: `PLAN_PREVIEW_${name.toUpperCase()}_SIZE`, timeoutMs: PREVIEW_TIMEOUT_MS,
        }),
      ])
      if (typeof text === 'string' && text.trim() && size && Number(size.width) > 0 && Number(size.height) > 0) {
        visibleText = true
        break
      }
    }
    result[name] = visibleText
  }
  return result
}

async function capturePreviewEvidence(miniProgram, ownerToken, processInstanceId, durationDays) {
  const run = createRun('ai-release-preview', EVIDENCE_BASE)
  const report = {
    passed: false,
    durationDays,
    data: null,
    rendered: null,
    screenshots: { top: false, bottom: false },
    failureCode: '',
  }
  fs.mkdirSync(run.outputDir, { recursive: true })
  try {
    const enabled = await setPreviewEvidenceMode(miniProgram, ownerToken, processInstanceId, true)
    if (!enabled || !enabled.ok) throw fixedPreviewError(safeCode(enabled && enabled.code))
    let page = await navigateAndAcquire(miniProgram, PREVIEW_URL, {
      timeoutMs: PREVIEW_TIMEOUT_MS, responseTimeoutMs: PREVIEW_TIMEOUT_MS,
    })
    report.data = await waitForPreviewData(
      miniProgram, page, ownerToken, processInstanceId,
    )
    report.rendered = await renderedPreviewSummary(page)
    const renderedCode = classifyRenderedSummary(report.rendered)
    if (renderedCode !== 'OK') throw fixedPreviewError(renderedCode)

    await withAutomatorResponseTimeout(() => miniProgram.pageScrollTo(0), {
      stage: 'PLAN_PREVIEW_TOP_SCROLL', timeoutMs: PREVIEW_TIMEOUT_MS,
    })
    await sleep(250)
    await captureScreenshotWithRetry(miniProgram, path.join(run.outputDir, 'top.png'), {
      stage: 'PLAN_PREVIEW_TOP_SCREENSHOT', timeoutMs: SCREENSHOT_TIMEOUT_MS,
      expectedRoute: PREVIEW_ROUTE,
      healthPredicate: async (currentPage) => (
        classifyPreviewDataSummary(await readPreviewDataSummary(
          miniProgram, currentPage, ownerToken, processInstanceId,
        )) === 'OK'
      ),
    })
    report.screenshots.top = true

    await withAutomatorResponseTimeout(() => miniProgram.pageScrollTo(100000), {
      stage: 'PLAN_PREVIEW_BOTTOM_SCROLL', timeoutMs: PREVIEW_TIMEOUT_MS,
    })
    await sleep(250)
    page = await withAutomatorResponseTimeout(() => miniProgram.currentPage(), {
      stage: 'PLAN_PREVIEW_BOTTOM_CURRENT_PAGE', timeoutMs: PREVIEW_TIMEOUT_MS,
    })
    if (!page || page.path !== PREVIEW_ROUTE) throw fixedPreviewError('PLAN_PREVIEW_STATE_INVALID')
    const actions = await withAutomatorResponseTimeout(() => page.$$('.action-area'), {
      stage: 'PLAN_PREVIEW_ACTIONS_SELECT', timeoutMs: PREVIEW_TIMEOUT_MS,
    })
    if (!actions.length) throw fixedPreviewError('PLAN_PREVIEW_RENDER_INVALID')
    const actionSize = await withAutomatorResponseTimeout(() => actions[0].size(), {
      stage: 'PLAN_PREVIEW_ACTIONS_SIZE', timeoutMs: PREVIEW_TIMEOUT_MS,
    })
    if (!actionSize || Number(actionSize.width) <= 0 || Number(actionSize.height) <= 0) {
      throw fixedPreviewError('PLAN_PREVIEW_RENDER_INVALID')
    }
    await captureScreenshotWithRetry(miniProgram, path.join(run.outputDir, 'bottom.png'), {
      stage: 'PLAN_PREVIEW_BOTTOM_SCREENSHOT', timeoutMs: SCREENSHOT_TIMEOUT_MS,
      expectedRoute: PREVIEW_ROUTE,
      healthPredicate: async (currentPage) => (
        classifyPreviewDataSummary(await readPreviewDataSummary(
          miniProgram, currentPage, ownerToken, processInstanceId,
        )) === 'OK'
      ),
    })
    report.screenshots.bottom = true
    report.passed = true
    return safeEvidenceReport(report)
  } catch (error) {
    const code = safeCode(error)
    report.failureCode = code.startsWith('PLAN_PREVIEW_') ? code : 'PLAN_PREVIEW_SCREENSHOT_FAILED'
    throw fixedPreviewError(report.failureCode)
  } finally {
    try {
      finalizeRunReport(run, safeEvidenceReport(report))
    } finally {
      try { await setPreviewEvidenceMode(miniProgram, ownerToken, processInstanceId, false) } catch (_) {}
    }
  }
}

async function cleanupProbe(miniProgram, ownerToken, processInstanceId) {
  return miniProgram.evaluate(async function (workerSettleTimeoutMs, requestedOwnerToken, requestedInstanceId) {
    const app = getApp()
    const key = '__mealAiReleaseProbeV4'
    const state = app && app.globalData && app.globalData[key]
    const activeStatuses = new Set(['queued', 'running', 'finalizing'])
    const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'conflict'])
    const allStatuses = new Set([...activeStatuses, ...terminalStatuses])
    const validTaskId = (value) => typeof value === 'string' && /^task_[A-Za-z0-9_-]{43}$/.test(value)
    const validPlanId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 120
    const validRevision = (value) => Number.isSafeInteger(value) && value >= 0
    const clone = (value) => JSON.parse(JSON.stringify(value))
    const canonical = (value) => {
      if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
      if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((name) => `${JSON.stringify(name)}:${canonical(value[name])}`).join(',')}}`
      }
      return JSON.stringify(value)
    }
    const same = (left, right) => canonical(left) === canonical(right)
    const blockedKeys = new Set(['__proto__', 'prototype', 'constructor'])
    const invariant = (value) => {
      const result = {}
      const allowed = new Set(['stateRevision', 'generationPreferences', 'draftPlan', 'updatedAt'])
      Object.keys(value || {}).sort().forEach((name) => {
        if (!allowed.has(name) && !blockedKeys.has(name)) result[name] = clone(value[name])
      })
      return result
    }
    const invariantMatches = (value) => same(invariant(value), state.baselineInvariant)
    const testPreferences = () => state.expectedTestPreferences
    const envelopeCode = (envelope) => {
      const code = envelope && envelope.code
      if (code === 'STATE_REVISION_CONFLICT') return 'RESTORE_CONFLICT'
      if (code === 'TASK_REVISION_CONFLICT') return 'TASK_CHANGED'
      return 'UNKNOWN'
    }
    const call = async (name, data) => {
      const options = { name, data }
      state.internalOptions.add(options)
      try {
        const response = await wx.cloud.callFunction(options)
        const envelope = response && response.result
        if (!envelope || envelope.success !== true) {
          return { ok: false, ambiguous: false, code: envelopeCode(envelope), data: null }
        }
        return { ok: true, ambiguous: false, code: 'OK', data: envelope.data }
      } catch (_) {
        state.internalOptions.delete(options)
        return { ok: false, ambiguous: true, code: 'CLOUD_FAILED', data: null }
      }
    }
    const captureTask = (payload) => {
      const task = payload && payload.task
      if (!task || !validTaskId(task.taskId) || !allStatuses.has(task.status)
        || !validRevision(task.taskRevision) || !Number.isInteger(task.progressPercent)
        || task.progressPercent < 0 || task.progressPercent > 100) return 'TASK_INVALID'
      if (state.taskId && task.taskId !== state.taskId) return 'TASK_OWNERSHIP_MISMATCH'
      if (validRevision(state.taskRevision) && task.taskRevision < state.taskRevision) return 'TASK_CHANGED'
      state.taskId = task.taskId
      state.taskRevision = task.taskRevision
      state.taskStatus = task.status
      state.progressPercent = task.progressPercent
      if (validRevision(task.resultStateRevision)) state.finalStateRevision = task.resultStateRevision
      const result = payload && payload.result && typeof payload.result === 'object' ? payload.result : null
      const draft = result && result.draftPlan
      if (draft && validPlanId(draft.id)) {
        if (state.draftPlanId && state.draftPlanId !== draft.id) return 'DRAFT_CAPTURE_CONFLICT'
        state.draftPlanId = draft.id
        if (validRevision(result.stateRevision)) state.finalStateRevision = result.stateRevision
      }
      return 'OK'
    }
    const bootstrap = () => call('userData', {
      action: 'bootstrap', expectedCacheNamespace: state.namespace,
    })
    const fail = (code, flags = {}) => ({ ok: false, code, ...flags })
    if (!state || !state.installed) return fail('PROBE_NOT_INSTALLED')
    if (state.ownerToken !== requestedOwnerToken) return fail('PROBE_OWNERSHIP_MISMATCH')
    if (state.ownerInstanceId !== requestedInstanceId) return fail('PROBE_OWNERSHIP_MISMATCH')
    if (state.cleanupLocked) return fail('CLEANUP_ALREADY_RUNNING')
    state.cleanupLocked = true
    state.cleanupLockOwnerToken = requestedOwnerToken
    state.cleanupLockOwnerInstanceId = requestedInstanceId
    try {
      state.cleanupStarted = true
      state.stopRequested = true

      if (state.worker && !state.workerSettled) {
        const settled = await Promise.race([
          state.worker.then(() => true, () => true),
          new Promise((resolve) => setTimeout(() => resolve(false), workerSettleTimeoutMs)),
        ])
        if (!settled || !state.workerSettled) return fail('WORKER_SETTLE_TIMEOUT')
      }
      if (wx.cloud.callFunction !== state.wrappedCallFunction) return fail('LOCAL_CONCURRENT_MUTATION')
      if (state.localConcurrentMutation) return fail('LOCAL_CONCURRENT_MUTATION')
      if (state.taskCaptureConflict) return fail('TASK_CAPTURE_CONFLICT')
      if (state.draftCaptureConflict) return fail('DRAFT_CAPTURE_CONFLICT')
      if (!state.testSave.attempted && !state.startAttempted) {
        if (!state.worker) state.workerSettled = true
        state.cleanupComplete = true
        return { ok: true, code: 'OK', cancelled: false, discarded: false, restored: true }
      }
      if (!state.namespace || state.originalPreferences === null || !validRevision(state.baseRevision)) {
        return fail('PROBE_NOT_INSTALLED')
      }

      if (state.startAttempted && !state.taskId && !state.startAmbiguous && !state.startRejected) {
        return fail('TASK_CAPTURE_MISSING')
      }
      if (state.startAmbiguous && !state.taskId) {
        if (!state.startRequest) return fail('TASK_CAPTURE_MISSING')
        for (let attempt = 0; attempt < 2 && !state.taskId; attempt += 1) {
          const replay = await call('aiPlanner', clone(state.startRequest))
          if (replay.ok && replay.data) {
            const captured = captureTask(replay.data)
            if (captured !== 'OK') return fail(captured)
            state.startAmbiguous = false
            state.startCommitted = true
          } else if (!replay.ambiguous) return fail(replay.ok ? 'TASK_CAPTURE_MISSING' : replay.code)
        }
        if (!state.taskId) return fail('START_AMBIGUOUS')
      }

      let cancelled = false
      let discarded = false
      let restored = false
      if (state.taskId) {
        if (!validTaskId(state.taskId)) return fail('TASK_CAPTURE_MISSING')
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const status = await call('aiPlanner', {
            action: 'status', taskId: state.taskId, expectedCacheNamespace: state.namespace,
          })
          if (!status.ok || !status.data) return fail(status.ok ? 'TASK_INVALID' : status.code)
          const captured = captureTask(status.data)
          if (captured !== 'OK') return fail(captured)
          if (terminalStatuses.has(state.taskStatus)) {
            state.cancel.committed = state.cancel.committed || state.cancel.attempted
            cancelled = state.taskStatus === 'cancelled'
            break
          }
          if (!activeStatuses.has(state.taskStatus)) return fail('TASK_INVALID')
          state.cancel.attempted = true
          const beforeRevision = state.taskRevision
          state.cancel.request = {
            action: 'cancel', taskId: state.taskId, expectedTaskRevision: beforeRevision,
            expectedCacheNamespace: state.namespace,
          }
          const cancel = await call('aiPlanner', clone(state.cancel.request))
          if (cancel.ok && cancel.data) {
            const cancelCaptured = captureTask(cancel.data)
            if (cancelCaptured !== 'OK') return fail(cancelCaptured)
            state.cancel.committed = terminalStatuses.has(state.taskStatus)
            cancelled = state.taskStatus === 'cancelled'
            if (state.cancel.committed) break
          } else if (cancel.ambiguous || cancel.code === 'TASK_CHANGED') {
            state.cancel.ambiguous = cancel.ambiguous
          } else return fail(cancel.code)
        }
        if (activeStatuses.has(state.taskStatus)) return fail('TASK_CHANGED')
      }
      if (state.startCommitted && !state.taskId) return fail('TASK_CAPTURE_MISSING')

      let latestResponse = await bootstrap()
      if (!latestResponse.ok || !latestResponse.data) return fail(latestResponse.ok ? 'RESTORE_VERIFY_FAILED' : latestResponse.code)
      let latest = latestResponse.data
      if (!validRevision(latest.stateRevision) || !invariantMatches(latest)) return fail('REVISION_CHANGED')
      if (state.localConcurrentMutation) return fail('LOCAL_CONCURRENT_MUTATION')

      if (!state.testSave.committed) {
        if (latest.stateRevision === state.baseRevision && !latest.draftPlan
          && same(latest.generationPreferences, state.originalPreferences)) {
          state.testSave.ambiguous = false
        } else if (latest.stateRevision === state.baseRevision + 1 && !latest.draftPlan
          && same(latest.generationPreferences, testPreferences())) {
          state.testSave.committed = true
          state.testSave.ambiguous = false
          state.expectedRevision = latest.stateRevision
        } else return fail('REVISION_CHANGED')
      }
      if (state.testSave.committed && (!validRevision(state.expectedRevision)
        || state.expectedRevision !== state.baseRevision + 1)) return fail('REVISION_CHANGED')

      if (state.restore.request) {
        const request = state.restore.request
        const beforeRevision = request.expectedStateRevision
        if (!validRevision(beforeRevision) || request.expectedCacheNamespace !== state.namespace
          || !same(request.state && request.state.generationPreferences, state.originalPreferences)
          || latest.draftPlan) return fail('RESTORE_CONFLICT')
        if (latest.stateRevision === beforeRevision + 1
          && same(latest.generationPreferences, state.originalPreferences)) {
          state.restore.committed = true
          state.restore.ambiguous = false
          restored = true
        } else if (latest.stateRevision !== beforeRevision
          || !same(latest.generationPreferences, testPreferences())) return fail('RESTORE_CONFLICT')
      } else if (state.discard.request) {
        const request = state.discard.request
        const beforeRevision = request.expectedStateRevision
        if (!validRevision(beforeRevision) || request.expectedDraftPlanId !== state.draftPlanId
          || request.expectedCacheNamespace !== state.namespace) return fail('DRAFT_CAPTURE_CONFLICT')
        if (!latest.draftPlan) {
          if (latest.stateRevision !== beforeRevision + 1
            || !same(latest.generationPreferences, testPreferences())) return fail('REVISION_CHANGED')
          state.discard.committed = true
          state.discard.ambiguous = false
          discarded = true
        } else {
          if (latest.stateRevision !== beforeRevision || latest.draftPlan.id !== state.draftPlanId
            || !same(latest.generationPreferences, testPreferences())) return fail('REVISION_CHANGED')
          for (let attempt = 0; attempt < 2; attempt += 1) {
            if (state.localConcurrentMutation) return fail('LOCAL_CONCURRENT_MUTATION')
            const discard = await call('userData', clone(request))
            if (discard.ok && discard.data) {
              latest = discard.data
              if (latest.draftPlan || latest.stateRevision !== beforeRevision + 1
                || !same(latest.generationPreferences, testPreferences())
                || !invariantMatches(latest)) return fail('REVISION_CHANGED')
              state.discard.committed = true
              state.discard.ambiguous = false
              discarded = true
              break
            }
            if (!discard.ambiguous) return fail(discard.code)
            state.discard.ambiguous = true
            const observed = await bootstrap()
            if (!observed.ok || !observed.data) return fail(observed.ok ? 'RESTORE_VERIFY_FAILED' : observed.code)
            latest = observed.data
            if (latest.stateRevision === beforeRevision + 1 && !latest.draftPlan
              && same(latest.generationPreferences, testPreferences()) && invariantMatches(latest)) {
              state.discard.committed = true
              state.discard.ambiguous = false
              discarded = true
              break
            }
            if (latest.stateRevision !== beforeRevision || !latest.draftPlan
              || latest.draftPlan.id !== state.draftPlanId
              || !same(latest.generationPreferences, testPreferences())
              || !invariantMatches(latest)) return fail('REVISION_CHANGED')
          }
          if (!state.discard.committed) return fail('CLOUD_FAILED')
        }
      } else if (latest.draftPlan) {
        if (!state.draftPlanId) return fail('DRAFT_CAPTURE_MISSING')
        if (!validPlanId(latest.draftPlan.id) || latest.draftPlan.id !== state.draftPlanId) {
          return fail('DRAFT_OWNERSHIP_MISMATCH')
        }
        if (!same(latest.generationPreferences, testPreferences())
          || !invariantMatches(latest)) return fail('PREFERENCE_CHANGED')
        if (!validRevision(state.finalStateRevision) || latest.stateRevision !== state.finalStateRevision) {
          return fail('REVISION_CHANGED')
        }
        const beforeRevision = latest.stateRevision
        state.discard.request = {
          action: 'discardDraft', expectedDraftPlanId: state.draftPlanId,
          expectedStateRevision: beforeRevision, expectedCacheNamespace: state.namespace,
        }
        state.discard.attempted = true
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (state.localConcurrentMutation) return fail('LOCAL_CONCURRENT_MUTATION')
          const discard = await call('userData', clone(state.discard.request))
          if (discard.ok && discard.data) {
            latest = discard.data
            if (latest.draftPlan || latest.stateRevision !== beforeRevision + 1
              || !same(latest.generationPreferences, testPreferences())
              || !invariantMatches(latest)) return fail('REVISION_CHANGED')
            state.discard.committed = true
            discarded = true
            break
          }
          if (!discard.ambiguous) return fail(discard.code)
          state.discard.ambiguous = true
          const observed = await bootstrap()
          if (!observed.ok || !observed.data) return fail(observed.ok ? 'RESTORE_VERIFY_FAILED' : observed.code)
          latest = observed.data
          if (latest.stateRevision === beforeRevision + 1 && !latest.draftPlan
            && same(latest.generationPreferences, testPreferences()) && invariantMatches(latest)) {
            state.discard.committed = true
            discarded = true
            break
          }
          if (latest.stateRevision !== beforeRevision || !latest.draftPlan
            || latest.draftPlan.id !== state.draftPlanId
            || !same(latest.generationPreferences, testPreferences())
            || !invariantMatches(latest)) return fail('REVISION_CHANGED')
        }
        if (!state.discard.committed) return fail('CLOUD_FAILED')
      } else if (state.draftPlanId) {
        return fail('DRAFT_OWNERSHIP_MISMATCH')
      }

      if (!state.restore.request) {
        latestResponse = await bootstrap()
        if (!latestResponse.ok || !latestResponse.data) return fail(latestResponse.ok ? 'RESTORE_VERIFY_FAILED' : latestResponse.code)
        latest = latestResponse.data
        if (!validRevision(latest.stateRevision) || latest.draftPlan
          || !invariantMatches(latest)) return fail('DRAFT_OWNERSHIP_MISMATCH')
        if (state.localConcurrentMutation) return fail('LOCAL_CONCURRENT_MUTATION')
      }
      const expectedTestRevision = state.discard.request
        ? state.discard.request.expectedStateRevision + 1 : state.expectedRevision
      if (!state.restore.request && !state.testSave.committed
        && same(latest.generationPreferences, state.originalPreferences)) {
        if (latest.stateRevision !== state.baseRevision) return fail('RESTORE_CONFLICT')
        restored = true
      } else if (!restored && (!same(latest.generationPreferences, testPreferences())
        || !validRevision(expectedTestRevision) || latest.stateRevision !== expectedTestRevision)) {
        return fail('PREFERENCE_CHANGED')
      }

      if (!restored) {
        if (!state.restore.request) {
          state.restore.request = {
            action: 'saveState', state: { generationPreferences: clone(state.originalPreferences) },
            expectedStateRevision: latest.stateRevision, expectedCacheNamespace: state.namespace,
          }
          state.restore.attempted = true
        }
        const request = state.restore.request
        const beforeRevision = request.expectedStateRevision
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (state.localConcurrentMutation) return fail('LOCAL_CONCURRENT_MUTATION')
          const restore = await call('userData', clone(request))
          if (restore.ok && restore.data) {
            latest = restore.data
            if (latest.stateRevision !== beforeRevision + 1 || latest.draftPlan
              || !same(latest.generationPreferences, state.originalPreferences)
              || !invariantMatches(latest)) {
              return fail('RESTORE_VERIFY_FAILED')
            }
            state.restore.committed = true
            state.restore.ambiguous = false
            restored = true
            break
          }
          if (!restore.ambiguous) return fail(restore.code)
          state.restore.ambiguous = true
          const observed = await bootstrap()
          if (!observed.ok || !observed.data) return fail(observed.ok ? 'RESTORE_VERIFY_FAILED' : observed.code)
          latest = observed.data
          if (latest.stateRevision === beforeRevision + 1 && !latest.draftPlan
            && same(latest.generationPreferences, state.originalPreferences) && invariantMatches(latest)) {
            state.restore.committed = true
            state.restore.ambiguous = false
            restored = true
            break
          }
          if (latest.stateRevision !== beforeRevision || latest.draftPlan
            || !same(latest.generationPreferences, testPreferences())
            || !invariantMatches(latest)) return fail('RESTORE_CONFLICT')
        }
      }
      if (!restored) return fail('RESTORE_VERIFY_FAILED')

      const verify = await bootstrap()
      if (!verify.ok || !verify.data || !validRevision(verify.data.stateRevision)
        || verify.data.draftPlan || !same(verify.data.generationPreferences, state.originalPreferences)
        || verify.data.stateRevision !== latest.stateRevision
        || !invariantMatches(verify.data)) return fail('RESTORE_VERIFY_FAILED')
      if (state.localConcurrentMutation) return fail('LOCAL_CONCURRENT_MUTATION')

      let current = await call('aiPlanner', {
        action: 'current', expectedCacheNamespace: state.namespace,
      })
      if (!current.ok) return fail(current.code)
      if (current.data) {
        if (!state.taskId) return fail('TASK_CAPTURE_CONFLICT')
        const captured = captureTask(current.data)
        if (captured !== 'OK') return fail(captured)
        if (!terminalStatuses.has(state.taskStatus)) return fail('TASK_CHANGED')
        current = await call('aiPlanner', {
          action: 'current', expectedCacheNamespace: state.namespace,
        })
        if (!current.ok) return fail(current.code)
      }
      if (current.data) return fail('CLEANUP_INCOMPLETE')
      if (state.localConcurrentMutation) return fail('LOCAL_CONCURRENT_MUTATION')
      state.cleanupComplete = true
      return { ok: true, code: 'OK', cancelled, discarded, restored }
    } catch (_) {
      return fail('UNKNOWN')
    } finally {
      if (state.ownerToken === requestedOwnerToken
        && state.ownerInstanceId === requestedInstanceId
        && state.cleanupLockOwnerToken === requestedOwnerToken
        && state.cleanupLockOwnerInstanceId === requestedInstanceId) {
        state.cleanupLocked = false
        state.cleanupLockOwnerToken = ''
        state.cleanupLockOwnerInstanceId = ''
      }
    }
  }, WORKER_SETTLE_TIMEOUT_MS, ownerToken, processInstanceId)
}

async function uninstallProbe(miniProgram, ownerToken, processInstanceId) {
  return miniProgram.evaluate(function (requestedOwnerToken, requestedInstanceId) {
    try {
      const app = getApp()
      const key = '__mealAiReleaseProbeV4'
      const state = app && app.globalData && app.globalData[key]
      if (!state || !state.installed) return { ok: true, code: 'OK' }
      if (state.ownerToken !== requestedOwnerToken) return { ok: false, code: 'PROBE_OWNERSHIP_MISMATCH' }
      if (state.ownerInstanceId !== requestedInstanceId) return { ok: false, code: 'PROBE_OWNERSHIP_MISMATCH' }
      if (!state.cleanupComplete || state.running || !state.workerSettled) {
        return { ok: false, code: 'CLEANUP_INCOMPLETE' }
      }
      if (wx.cloud.callFunction !== state.wrappedCallFunction) {
        return { ok: false, code: 'LOCAL_CONCURRENT_MUTATION' }
      }
      const originalCallFunction = state.originalCallFunction
      wx.cloud.callFunction = originalCallFunction
      if (wx.cloud.callFunction !== originalCallFunction) {
        return { ok: false, code: 'LOCAL_CONCURRENT_MUTATION' }
      }
      delete app.globalData[key]
      if (app.globalData[key]) return { ok: false, code: 'CLEANUP_INCOMPLETE' }
      state.originalPreferences = null
      state.testPreferences = null
      state.releaseCompatibility = null
      state.expectedTestPreferences = null
      state.baselineInvariant = null
      state.startRequest = null
      state.providerRevision = 0
      state.taskId = ''
      state.taskFailureCode = ''
      state.draftPlanId = ''
      state.wrappedCallFunction = null
      state.originalCallFunction = null
      state.worker = null
      state.cleanupLocked = false
      state.cleanupLockOwnerToken = ''
      state.cleanupLockOwnerInstanceId = ''
      state.ownerToken = ''
      state.ownerInstanceId = ''
      return { ok: true, code: 'OK' }
    } catch (_) {
      return { ok: false, code: 'UNKNOWN' }
    }
  }, ownerToken, processInstanceId)
}

async function main() {
  const startedAt = Date.now()
  let miniProgram
  let installed = false
  let ownerToken = ''
  let journalClaimed = false
  let journalCleared = false
  let recoveryMode = false
  let failureCode = ''
  let cleanupResult = null
  let lastPercent = -1
  if (!ARGUMENTS.ok) {
    process.stderr.write('AI_RELEASE_PROBE_FAILED days=0 code=INVALID_ARGUMENTS\n')
    process.exitCode = 1
    return
  }
  try {
    const claim = claimRecoveryJournal({
      journalPath: JOURNAL_PATH,
      durationDays: DURATION,
      processInstanceId: PROCESS_INSTANCE_ID,
    })
    if (!claim || !claim.ok) throw safeCode(claim && claim.code)
    journalClaimed = true
    ownerToken = claim.ownerToken
    recoveryMode = claim.mode === 'resume'

    const automator = require('./automator-client')
    miniProgram = await automator.connect({ wsEndpoint: ENDPOINT })
    const inspected = await inspectProbe(miniProgram, ownerToken)
    if (!inspected || !inspected.ok) throw safeCode(inspected && inspected.code)
    const recoveryAction = selectRecoveryAction(claim.mode, inspected.probeState)
    if (recoveryAction === 'state-lost') throw 'RECOVERY_STATE_LOST'
    if (recoveryAction === 'reject') {
      throw inspected.probeState === 'foreign' ? 'PROBE_ALREADY_INSTALLED' : 'PROBE_NOT_INSTALLED'
    }
    if (recoveryAction === 'cleanup') {
      const adopted = await adoptProbe(miniProgram, ownerToken, PROCESS_INSTANCE_ID)
      if (!adopted || !adopted.ok) throw safeCode(adopted && adopted.code)
      installed = true
    } else {
      const preferences = fictionalPreferences(DURATION)
      buildReleaseStartRequest(preferences, 0, 'a'.repeat(48), 'b'.repeat(32), 1)
      if (!releaseServiceCompatible({
        configured: true, storageReady: true,
        contractVersion: RELEASE_COMPATIBILITY.contractVersion,
        plannerVersion: RELEASE_COMPATIBILITY.plannerVersion,
        aiDataConsentVersion: RELEASE_COMPATIBILITY.aiDataConsentVersion,
        providerContractRevision: RELEASE_COMPATIBILITY.providerContractRevision,
        providerRevision: 1,
      })) throw 'AI_NOT_READY'
      const install = await installProbe(
        miniProgram, preferences, ownerToken, PROCESS_INSTANCE_ID, RELEASE_COMPATIBILITY,
      )
      if (!install || !install.ok) {
        const afterInstall = await inspectProbe(miniProgram, ownerToken)
        if (!afterInstall || !afterInstall.ok || afterInstall.probeState !== 'owned') {
          throw safeCode(install && install.code)
        }
      }
      installed = true
    }
    if (!recoveryMode) {
      const start = await startProbe(miniProgram, ownerToken, PROCESS_INSTANCE_ID)
      if (!start || !start.ok) throw safeCode(start && start.code)
      process.stdout.write(`AI_RELEASE_PROBE_STARTED days=${DURATION}\n`)

      while (Date.now() - startedAt < TOTAL_TIMEOUT_MS) {
        const status = await probeStatus(miniProgram, ownerToken, PROCESS_INSTANCE_ID)
        if (!status || !status.ok) throw safeCode(status && status.code)
        if (status.progressPercent !== lastPercent) {
          lastPercent = status.progressPercent
          process.stdout.write(`AI_RELEASE_PROBE_PROGRESS days=${DURATION} percent=${lastPercent}\n`)
        }
        if (status.generated && status.clientReadable) {
          process.stdout.write(`AI_RELEASE_PROBE_GENERATED days=${DURATION} elapsedMs=${Date.now() - startedAt}\n`)
          break
        }
        if (status.stopped && status.code !== 'OK') throw safeCode(status.code)
        await sleep(POLL_MS)
      }
      const finalStatus = await probeStatus(miniProgram, ownerToken, PROCESS_INSTANCE_ID)
      if (!finalStatus || !finalStatus.generated || !finalStatus.clientReadable) throw 'GENERATION_TIMEOUT'
      await capturePreviewEvidence(miniProgram, ownerToken, PROCESS_INSTANCE_ID, DURATION)
      process.stdout.write(`AI_RELEASE_PROBE_PREVIEW days=${DURATION} verified=true\n`)
    }
  } catch (error) {
    failureCode = safeCode(error)
    process.exitCode = 1
  } finally {
    if (miniProgram && installed) {
      try { cleanupResult = await cleanupProbe(miniProgram, ownerToken, PROCESS_INSTANCE_ID) } catch (_) {
        cleanupResult = { ok: false, code: 'UNKNOWN' }
      }
      if (cleanupResult && cleanupResult.ok) {
        try {
          const uninstall = await uninstallProbe(miniProgram, ownerToken, PROCESS_INSTANCE_ID)
          if (!uninstall || !uninstall.ok) cleanupResult = { ok: false, code: safeCode(uninstall && uninstall.code) }
        } catch (_) {
          cleanupResult = { ok: false, code: 'UNKNOWN' }
        }
      }
    }
    if (miniProgram) {
      await safeDisconnect(miniProgram)
    }
    if (journalClaimed && cleanupResult && cleanupResult.ok) {
      const cleared = clearRecoveryJournal({
        journalPath: JOURNAL_PATH,
        ownerToken,
        processInstanceId: PROCESS_INSTANCE_ID,
      })
      journalCleared = Boolean(cleared && cleared.ok)
      if (!journalCleared) cleanupResult = { ok: false, code: safeCode(cleared && cleared.code) }
    }
    const cleanupCode = safeCode(cleanupResult && cleanupResult.code)
    const restored = Boolean(cleanupResult && cleanupResult.ok && cleanupResult.restored)
    const discarded = Boolean(cleanupResult && cleanupResult.ok && cleanupResult.discarded)
    const cancelled = Boolean(cleanupResult && cleanupResult.ok && cleanupResult.cancelled)
    process.stdout.write(`AI_RELEASE_PROBE_CLEANUP days=${DURATION} restored=${restored} discarded=${discarded} cancelled=${cancelled} code=${cleanupCode}\n`)
    if (failureCode) process.stderr.write(`AI_RELEASE_PROBE_FAILED days=${DURATION} code=${failureCode}\n`)
    if (!cleanupResult || !cleanupResult.ok || !restored || !journalCleared) process.exitCode = 1
  }
}

main().catch(() => {
  process.stderr.write(`AI_RELEASE_PROBE_MAIN_FAILED days=${DURATION} code=UNKNOWN\n`)
  process.exitCode = 1
})
