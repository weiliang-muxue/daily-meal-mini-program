'use strict'

const cloud = require('wx-server-sdk')
const legacyUserData = require('./legacy-v8')
const { CURRENT_SCHEMA, MAX_HISTORY, defaults, migrate, sanitizeState, confirmDraft, confirmMealReplacement, restoreHistory } = require('./user-state')
const { catalog, plans, shoppingGroups } = require('./legacy-plan')
const { notFound } = require('./not-found')
const { reconcileChecks } = require('./meal-shopping')
const recipeLibrary = require('./recipe-library')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const states = db.collection('meal_user_states')
const members = db.collection('meal_members')

const STATE_FIELDS = [
  'favoriteRecipes',
  'schemaVersion', 'stateRevision', 'activePlan', 'draftPlan', 'planHistory', 'generationPreferences',
  'activePlanId', 'selectedDayId', 'selectedDay', 'defaultDinnerMode', 'dinnerModeByDay',
  'planUiStateByPlan', 'mealOverrides', 'checkedShoppingIds', 'customReminders', 'settings', 'waterReminder',
]
const CLIENT_EDITABLE_FIELDS = [
  'generationPreferences', 'selectedDayId', 'selectedDay', 'defaultDinnerMode', 'dinnerModeByDay',
  'planUiStateByPlan', 'mealOverrides', 'checkedShoppingIds', 'customReminders', 'settings', 'waterReminder',
]
const BUSINESS_ERROR_CODES = new Set([
  'MEMBERSHIP_REQUIRED', 'ACCOUNT_DELETION_IN_PROGRESS', 'INVALID_STATE_REVISION', 'STATE_REVISION_CONFLICT',
  'DRAFT_NOT_FOUND', 'DRAFT_EXPIRED', 'HISTORY_PLAN_NOT_FOUND', 'INVALID_USER_STATE', 'STATE_SCHEMA_UNSUPPORTED',
  'PLAN_TOO_LARGE', 'STATE_TOO_LARGE', 'STATE_HISTORY_LIMIT', 'STALE_DATA_GENERATION',
  'MEAL_REPLACEMENT_INVALID', 'MEAL_REPLACEMENT_CONFLICT', 'MEAL_REPLACEMENT_CONFIRM_REQUIRED',
  'MEAL_CONDITIONS_INVALID',
  'RECIPE_LIBRARY_INVALID', 'RECIPE_LIBRARY_FULL', 'RECIPE_LIBRARY_CONFLICT',
  'STATE_UPGRADE_WAITING_FOR_AI',
])
const CACHE_NAMESPACE_PATTERN = /^[a-f0-9]{32}$/
const MAX_LEGACY_PLAN_INJECTION_SCHEMA = 5
// Bootstrap can migrate persisted state, so reads need the same version gate as writes.
const VERSIONED_ACTIONS = new Set([
  'bootstrap', 'saveState', 'confirmDraft', 'confirmMealReplacement', 'restoreHistory', 'discardDraft',
  'addFavorite', 'removeFavorite', 'applyFavorite',
])
// Released 0.2.1 clients omit the handshake. Keep their original schema-v8
// handler, which rejects newer stored documents before writing anything.
// An explicitly supplied but invalid version must never select this path.
const LEGACY_ACTIONS = new Set(['bootstrap', 'saveState', 'confirmDraft', 'restoreHistory', 'discardDraft'])

function stateFields(value) { return Object.fromEntries(STATE_FIELDS.map((key) => [key, value[key]])) }
function atomicStateFields(value) {
  return Object.fromEntries(STATE_FIELDS.map((key) => [key, db.command.set(value[key])]))
}
function publicState(value, updatedAt) { return { ...stateFields(value), updatedAt: updatedAt || null } }

function legacyPlanFor(raw) {
  if (!raw || Number(raw.schemaVersion || 0) > MAX_LEGACY_PLAN_INJECTION_SCHEMA || raw.activePlan) return null
  return plans.find((plan) => plan.id === raw.activePlanId) || plans.find((plan) => plan.id === catalog.defaultPlanId) || null
}

function migrateStored(raw) {
  const stored = raw || {}
  return migrate(stored, {
    legacyPlan: legacyPlanFor(raw), legacyShoppingGroups: shoppingGroups, preserveUnknownFrom: stored,
  })
}

async function requireMember(openid) {
  try {
    const member = (await members.doc(openid).get()).data
    if (member && member.status === 'active') return member
  } catch (_) {}
  const error = new Error('需要有效邀请才能使用')
  error.code = 'MEMBERSHIP_REQUIRED'
  throw error
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

async function requireActiveMemberInTransaction(transaction, openid) {
  let member = null
  try {
    member = (await transaction.collection('meal_members').doc(openid).get()).data || null
  } catch (error) {
    if (!notFound(error)) throw error
  }
  if (!member || member.status !== 'active') throw membershipError(member)
  return member
}

function assertExpectedRevision(current, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    const error = new Error('请刷新数据后重试')
    error.code = 'INVALID_STATE_REVISION'
    throw error
  }
  if (current.stateRevision !== value) {
    const error = new Error('数据已在另一台设备更新，请刷新后重试')
    error.code = 'STATE_REVISION_CONFLICT'
    throw error
  }
}

function constrainUiState(state) {
  return sanitizeState(state, { preserveUnknownFrom: state })
}

async function assertMigrationTaskIdle(transaction, openid, expectedCacheNamespace) {
  const reference = transaction.collection('meal_ai_controls').doc(openid)
  let control = null
  try { control = (await reference.get()).data || null }
  catch (error) { if (!notFound(error)) throw error }
  const { _id, ...retainedControl } = control || {}
  // AI start writes this same document. A real write (including initial creation)
  // prevents snapshot-isolation write skew between task creation and migration.
  const fence = { reference, data: { ...retainedControl, owner: openid,
    cacheNamespace: expectedCacheNamespace, stateMigrationSchema: CURRENT_SCHEMA } }
  if (!control || !control.activeTaskId) return fence
  // A different account-data generation cannot write this member's state.
  if (control.cacheNamespace !== expectedCacheNamespace) return
  let task = null
  try { task = (await transaction.collection('meal_ai_tasks').doc(control.activeTaskId).get()).data || null }
  catch (error) { if (!notFound(error)) throw error }
  if (!task || task.cacheNamespace !== expectedCacheNamespace) return fence
  const terminal = ['succeeded', 'failed', 'cancelled', 'expired', 'conflict'].includes(task.status)
  const expired = Number.isSafeInteger(task.expiresAt) && task.expiresAt > 0 && task.expiresAt <= Date.now()
  if (task.owner === openid && (terminal || expired)) return fence
  const error = new Error('旧版生成任务仍在进行，请等待结束后刷新；当前餐单已保留')
  error.code = 'STATE_UPGRADE_WAITING_FOR_AI'
  throw error
}

async function bootstrap(openid, expectedCacheNamespace) {
  return db.runTransaction(async (transaction) => {
    const member = await requireActiveMemberInTransaction(transaction, openid)
    assertExpectedCacheNamespace(member, expectedCacheNamespace)
    const reference = transaction.collection('meal_user_states').doc(openid)
    let raw = null
    try { raw = (await reference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
    let migrationFence = null
    if (!raw || Number(raw.schemaVersion || 0) < CURRENT_SCHEMA) {
      migrationFence = await assertMigrationTaskIdle(transaction, openid, expectedCacheNamespace)
    }
    if (!raw) {
      const state = defaults()
      if (migrationFence) await migrationFence.reference.set({ data: migrationFence.data })
      await reference.set({ data: { ...stateFields(state), createdAt: db.serverDate(), updatedAt: db.serverDate() } })
      return publicState(state)
    }
    const state = constrainUiState(migrateStored(raw))
    if (Number(raw.schemaVersion || 0) < CURRENT_SCHEMA) {
      if (migrationFence) await migrationFence.reference.set({ data: migrationFence.data })
      await reference.update({ data: {
        ...atomicStateFields(state),
        migratedFrom: db.command.set(Number(raw.schemaVersion || 0)),
        updatedAt: db.serverDate(),
      } })
    }
    return publicState(state, raw.updatedAt)
  })
}

async function saveState(openid, incoming, expectedStateRevision, expectedCacheNamespace) {
  return db.runTransaction(async (transaction) => {
    const member = await requireActiveMemberInTransaction(transaction, openid)
    assertExpectedCacheNamespace(member, expectedCacheNamespace)
    const reference = transaction.collection('meal_user_states').doc(openid)
    const raw = (await reference.get()).data || {}
    const current = migrateStored(raw)
    assertExpectedRevision(current, expectedStateRevision)
    const value = incoming && typeof incoming === 'object' ? incoming : {}
    const editable = Object.fromEntries(CLIENT_EDITABLE_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(value, key)).map((key) => [key, value[key]]))
    const sanitized = sanitizeState({
      ...current, ...editable, stateRevision: current.stateRevision + 1,
    }, { preserveUnknownFrom: current })
    const next = constrainUiState(reconcileChecks(current, sanitized))
    await reference.update({ data: { ...atomicStateFields(next), updatedAt: db.serverDate() } })
    return publicState(next, new Date().toISOString())
  })
}

function assertDraftFresh(state) {
  const generated = state.draftPlan && Date.parse(state.draftPlan.generatedAt)
  const age = generated ? Date.now() - generated : Number.POSITIVE_INFINITY
  if (age < -5 * 60 * 1000 || age > 24 * 60 * 60 * 1000) {
    const error = new Error('候选计划已过期，请重新生成')
    error.code = 'DRAFT_EXPIRED'
    throw error
  }
}

function assertExpectedDraftPlan(state, expectedDraftPlanId) {
  const expected = typeof expectedDraftPlanId === 'string' && expectedDraftPlanId.length <= 120
    ? expectedDraftPlanId : ''
  if (!expected || !state.draftPlan || state.draftPlan.id !== expected) {
    const error = new Error('候选餐单已变化，请刷新后重试')
    error.code = 'STATE_REVISION_CONFLICT'
    throw error
  }
}

async function changePlan(openid, action, payload) {
  return db.runTransaction(async (transaction) => {
    const member = await requireActiveMemberInTransaction(transaction, openid)
    assertExpectedCacheNamespace(member, payload.expectedCacheNamespace)
    const reference = transaction.collection('meal_user_states').doc(openid)
    const raw = (await reference.get()).data || {}
    const current = migrateStored(raw)
    let next
    if (action === 'confirmDraft' || action === 'confirmMealReplacement') {
      assertExpectedDraftPlan(current, payload.expectedDraftPlanId)
      assertDraftFresh(current)
      next = action === 'confirmDraft'
        ? confirmDraft(current, payload.expectedStateRevision)
        : confirmMealReplacement(current, payload.expectedStateRevision)
    } else if (action === 'restoreHistory') {
      next = restoreHistory(current, payload.planId, payload.expectedStateRevision)
    } else if (action === 'discardDraft') {
      assertExpectedDraftPlan(current, payload.expectedDraftPlanId)
      assertExpectedRevision(current, payload.expectedStateRevision)
      next = sanitizeState({
        ...current, draftPlan: null, stateRevision: current.stateRevision + 1,
      }, { preserveUnknownFrom: current })
    } else throw new Error('不支持的计划操作')
    next = constrainUiState(next)
    await reference.update({ data: { ...atomicStateFields(next), updatedAt: db.serverDate() } })
    return publicState(next, new Date().toISOString())
  })
}

async function changeFavorite(openid, action, payload) {
  return db.runTransaction(async transaction => {
    const member = await requireActiveMemberInTransaction(transaction, openid)
    assertExpectedCacheNamespace(member, payload.expectedCacheNamespace)
    const reference = transaction.collection('meal_user_states').doc(openid)
    const raw = (await reference.get()).data || {}
    const current = migrateStored(raw)
    assertExpectedRevision(current, payload.expectedStateRevision)
    const now = new Date().toISOString()
    let next
    if (action === 'addFavorite') {
      if (!current.activePlan || payload.expectedPlanId !== current.activePlan.id) {
        const error = new Error('当前餐单已变化，请重新选择'); error.code = 'RECIPE_LIBRARY_CONFLICT'; throw error
      }
      next = recipeLibrary.add(current, payload.mealId, `fav_${crypto.randomBytes(16).toString('hex')}`, now)
    } else if (action === 'removeFavorite') next = recipeLibrary.remove(current, payload.favoriteId)
    else if (action === 'applyFavorite') next = recipeLibrary.proposal(current, payload.favoriteId, payload.target, now)
    else throw new Error('不支持的收藏操作')
    if (next === current) return publicState(current, raw.updatedAt)
    next = sanitizeState({ ...next, stateRevision: current.stateRevision + 1 }, { preserveUnknownFrom: current })
    await reference.update({ data: { ...atomicStateFields(next), updatedAt: db.serverDate() } })
    return publicState(next, now)
  })
}

function publicError(error) {
  const code = error && error.code || 'USER_DATA_FAILED'
  if (code === 'STALE_DATA_GENERATION') {
    return { code, message: '账号数据版本已变化，请刷新后重试' }
  }
  const known = BUSINESS_ERROR_CODES.has(code)
  return { code: known ? code : 'USER_DATA_FAILED', message: known ? error.message : '数据服务暂时不可用，请重试' }
}

function publicErrorMessage(error) {
  if (error && error.code === 'STATE_HISTORY_LIMIT') {
    return `历史计划已达 ${MAX_HISTORY} 份上限。为避免删除旧计划，本次计划更新未生效，请完成分页归档后重试`
  }
  if (error && error.code === 'STATE_TOO_LARGE') {
    return '计划历史已达文档容量上限。为避免删除旧计划，本次计划更新未生效，请完成分页归档后重试'
  }
  return ''
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success: false, code: 'IDENTITY_REQUIRED', message: '无法识别当前微信用户' }
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { success: false, code: 'UNSUPPORTED_ACTION', message: '不支持的数据操作' }
  }
  if (!Object.prototype.hasOwnProperty.call(event, 'clientSchemaVersion') && LEGACY_ACTIONS.has(event.action)) {
    const result = await legacyUserData.main(event)
    if (result.code === 'STATE_SCHEMA_UNSUPPORTED') {
      return { success: false, code: result.code, message: '个人数据已升级，请更新小程序后继续；原有数据仍保留' }
    }
    return result
  }
  try {
    await requireMember(OPENID)
    if (VERSIONED_ACTIONS.has(event.action) && event.clientSchemaVersion !== CURRENT_SCHEMA) {
      return { success: false, code: 'STATE_SCHEMA_UNSUPPORTED', message: '当前版本与数据服务不兼容，请更新小程序后重试；原有数据已保留' }
    }
    if (event.action === 'bootstrap') {
      return { success: true, data: await bootstrap(OPENID, event.expectedCacheNamespace) }
    }
    if (event.action === 'saveState') {
      return {
        success: true,
        data: await saveState(OPENID, event.state, event.expectedStateRevision, event.expectedCacheNamespace),
      }
    }
    if (['confirmDraft', 'confirmMealReplacement', 'restoreHistory', 'discardDraft'].includes(event.action)) {
      return { success: true, data: await changePlan(OPENID, event.action, event) }
    }
    if (['addFavorite', 'removeFavorite', 'applyFavorite'].includes(event.action)) {
      return { success: true, data: await changeFavorite(OPENID, event.action, event) }
    }
    return { success: false, code: 'UNSUPPORTED_ACTION', message: '不支持的数据操作' }
  } catch (error) {
    console.error('userData failed', { code: error && error.code, name: error && error.name })
    const failure = publicError(error)
    return { success: false, ...failure, message: publicErrorMessage(error) || failure.message }
  }
}

exports._test = {
  changeFavorite,
  bootstrap, saveState, changePlan, migrateStored, constrainUiState, stateFields, atomicStateFields,
  assertExpectedCacheNamespace, assertExpectedDraftPlan, publicError, publicErrorMessage,
}
