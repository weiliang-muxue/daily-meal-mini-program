'use strict'

const cloud = require('wx-server-sdk')
const { CURRENT_SCHEMA, MAX_HISTORY, defaults, migrate, sanitizeState, confirmDraft, restoreHistory } = require('./user-state')
const { catalog, plans, shoppingGroups } = require('./legacy-plan')
const { notFound } = require('./not-found')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const states = db.collection('meal_user_states')
const members = db.collection('meal_members')

const STATE_FIELDS = [
  'schemaVersion', 'stateRevision', 'activePlan', 'draftPlan', 'planHistory', 'generationPreferences',
  'activePlanId', 'selectedDayId', 'selectedDay', 'defaultDinnerMode', 'dinnerModeByDay',
  'planUiStateByPlan', 'mealOverrides', 'checkedShoppingIds', 'customReminders', 'settings',
]
const CLIENT_EDITABLE_FIELDS = [
  'generationPreferences', 'selectedDayId', 'selectedDay', 'defaultDinnerMode', 'dinnerModeByDay',
  'planUiStateByPlan', 'mealOverrides', 'checkedShoppingIds', 'customReminders', 'settings',
]

function stateFields(value) { return Object.fromEntries(STATE_FIELDS.map((key) => [key, value[key]])) }
function publicState(value, updatedAt) { return { ...stateFields(value), updatedAt: updatedAt || null } }

function legacyPlanFor(raw) {
  if (!raw || Number(raw.schemaVersion || 0) >= CURRENT_SCHEMA || raw.activePlan) return null
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

async function requireActiveMemberInTransaction(transaction, openid) {
  let member = null
  try {
    member = (await transaction.collection('meal_members').doc(openid).get()).data || null
  } catch (error) {
    if (!notFound(error)) throw error
  }
  if (!member || member.status !== 'active') throw membershipError(member)
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

function currentShoppingIds(plan) {
  const ids = new Set()
  if (plan && Array.isArray(plan.shoppingGroups)) {
    plan.shoppingGroups.forEach((group) => (group.items || []).forEach((item) => ids.add(item.id)))
  }
  return ids
}

function constrainUiState(state) {
  return sanitizeState(state, { preserveUnknownFrom: state })
}

async function bootstrap(openid) {
  return db.runTransaction(async (transaction) => {
    await requireActiveMemberInTransaction(transaction, openid)
    const reference = transaction.collection('meal_user_states').doc(openid)
    let raw = null
    try { raw = (await reference.get()).data || null } catch (error) { if (!notFound(error)) throw error }
    if (!raw) {
      const state = defaults()
      await reference.set({ data: { ...stateFields(state), createdAt: db.serverDate(), updatedAt: db.serverDate() } })
      return publicState(state)
    }
    const state = constrainUiState(migrateStored(raw))
    if (Number(raw.schemaVersion || 0) < CURRENT_SCHEMA) {
      await reference.update({ data: { ...stateFields(state), migratedFrom: Number(raw.schemaVersion || 0), updatedAt: db.serverDate() } })
    }
    return publicState(state, raw.updatedAt)
  })
}

async function saveState(openid, incoming, expectedStateRevision) {
  return db.runTransaction(async (transaction) => {
    await requireActiveMemberInTransaction(transaction, openid)
    const reference = transaction.collection('meal_user_states').doc(openid)
    const raw = (await reference.get()).data || {}
    const current = migrateStored(raw)
    assertExpectedRevision(current, expectedStateRevision)
    const value = incoming && typeof incoming === 'object' ? incoming : {}
    const editable = Object.fromEntries(CLIENT_EDITABLE_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(value, key)).map((key) => [key, value[key]]))
    const next = constrainUiState(sanitizeState({
      ...current, ...editable, stateRevision: current.stateRevision + 1,
    }, { preserveUnknownFrom: current }))
    await reference.update({ data: { ...stateFields(next), updatedAt: db.serverDate() } })
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

async function changePlan(openid, action, payload) {
  return db.runTransaction(async (transaction) => {
    await requireActiveMemberInTransaction(transaction, openid)
    const reference = transaction.collection('meal_user_states').doc(openid)
    const raw = (await reference.get()).data || {}
    const current = migrateStored(raw)
    let next
    if (action === 'confirmDraft') {
      assertDraftFresh(current)
      next = confirmDraft(current, payload.expectedStateRevision)
    } else if (action === 'restoreHistory') {
      next = restoreHistory(current, payload.planId, payload.expectedStateRevision)
    } else if (action === 'discardDraft') {
      assertExpectedRevision(current, payload.expectedStateRevision)
      next = sanitizeState({
        ...current, draftPlan: null, stateRevision: current.stateRevision + 1,
      }, { preserveUnknownFrom: current })
    } else throw new Error('不支持的计划操作')
    next = constrainUiState(next)
    await reference.update({ data: { ...stateFields(next), updatedAt: db.serverDate() } })
    return publicState(next, new Date().toISOString())
  })
}

function publicError(error) {
  const code = error && error.code || 'USER_DATA_FAILED'
  const known = new Set([
    'MEMBERSHIP_REQUIRED', 'ACCOUNT_DELETION_IN_PROGRESS', 'INVALID_STATE_REVISION', 'STATE_REVISION_CONFLICT', 'DRAFT_NOT_FOUND',
    'DRAFT_EXPIRED', 'HISTORY_PLAN_NOT_FOUND', 'INVALID_USER_STATE', 'STATE_SCHEMA_UNSUPPORTED',
    'PLAN_TOO_LARGE', 'STATE_TOO_LARGE', 'STATE_HISTORY_LIMIT',
  ])
  return { code: known.has(code) ? code : 'USER_DATA_FAILED', message: known.has(code) ? error.message : '数据服务暂时不可用，请重试' }
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
  try {
    await requireMember(OPENID)
    if (event.action === 'bootstrap') return { success: true, data: await bootstrap(OPENID) }
    if (event.action === 'saveState') return { success: true, data: await saveState(OPENID, event.state, event.expectedStateRevision) }
    if (['confirmDraft', 'restoreHistory', 'discardDraft'].includes(event.action)) {
      return { success: true, data: await changePlan(OPENID, event.action, event) }
    }
    return { success: false, code: 'UNSUPPORTED_ACTION', message: '不支持的数据操作' }
  } catch (error) {
    console.error('userData failed', { code: error && error.code, name: error && error.name })
    const failure = publicError(error)
    return { success: false, ...failure, message: publicErrorMessage(error) || failure.message }
  }
}

exports._test = { bootstrap, saveState, changePlan, migrateStored, constrainUiState, stateFields, publicError, publicErrorMessage }
