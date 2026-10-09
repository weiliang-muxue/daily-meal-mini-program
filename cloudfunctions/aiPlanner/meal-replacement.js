'use strict'

// Single-meal replacement invariants. Pure, account-local, no network or storage.
const shopping = require('./meal-shopping')
const TARGET_VERSION = 1
const MAX_SNAPSHOT_LENGTH = 16000
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const copy = value => JSON.parse(JSON.stringify(value))
function fail(message, code = 'MEAL_REPLACEMENT_INVALID') {
  const error = new Error(message); error.code = code; throw error
}
function bounded(value, max, field, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${field}无效，请重新选择餐食`)
  return value
}
function canonical(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  fail('原餐食数据无效，请刷新后重试')
}
function findMeal(plan, mealId) {
  for (const [dayIndex, day] of (plan && plan.days || []).entries()) {
    const meal = (day.meals || []).find(item => item.id === mealId)
    if (meal) return { plan, day, dayIndex, meal }
  }
  return null
}
function sourceSnapshot(state, found) {
  const meal = found.meal, override = (state.mealOverrides || {})[meal.id]
  const ingredients = items => Array.isArray(items)
    ? items.map(item => ({ name: item.name, quantity: item.quantity, unit: item.unit, category: item.category })) : items
  const fields = value => ({ title: value.title || '', ingredients: ingredients(value.ingredients || ''), method: value.method || '', tag: value.tag || '' })
  const projected = override ? { ...fields(override), ingredientItems: ingredients(override.ingredientItems || null), updatedAt: override.updatedAt || '' } : null
  return canonical({ meal: { ...fields(meal), type: meal.type, scenario: meal.scenario || 'default' }, override: projected })
}
function sanitizeTarget(raw) {
  if (!object(raw) || raw.version !== TARGET_VERSION) fail('单餐替换版本不受支持')
  const allowed = ['version', 'planId', 'dayId', 'mealId', 'sourceSnapshot', 'originalDinnerMode', 'dinnerMode']
  if (Object.keys(raw).some(key => !allowed.includes(key))) fail('单餐替换范围包含未知字段')
  if (!['rest', 'workout'].includes(raw.originalDinnerMode) || !['', 'rest', 'workout'].includes(raw.dinnerMode)) fail('单餐替换运动条件无效')
  return {
    version: TARGET_VERSION,
    planId: bounded(raw.planId, 120, '餐单标识'), dayId: bounded(raw.dayId, 120, '日期标识'),
    mealId: bounded(raw.mealId, 120, '餐次标识'),
    sourceSnapshot: bounded(raw.sourceSnapshot, MAX_SNAPSHOT_LENGTH, '原餐食快照'),
    originalDinnerMode: raw.originalDinnerMode, dinnerMode: raw.dinnerMode,
  }
}
function createTarget(state, mealId, options = {}) {
  const found = findMeal(state.activePlan, mealId)
  if (!found || !found.plan.id || !found.day.id) fail('这餐已不存在，请返回餐单重新选择', 'MEAL_REPLACEMENT_CONFLICT')
  if (!found.day.date) fail('这份旧餐单没有具体日期，请先定制有日期的餐单')
  if (shopping.allMeals(found.plan).some(meal => !Array.isArray(meal.ingredients))) fail('旧餐单缺少完整食材份量，请先使用新版定制餐单')
  const dinnerMode = options.dinnerMode === undefined ? '' : options.dinnerMode
  if (dinnerMode && (found.meal.type !== 'dinner' || (found.meal.scenario !== 'default' && found.meal.scenario !== dinnerMode))) fail('请先选择对应的运动或不运动晚餐')
  const originalDinnerMode = shopping.selectedDinnerMode(found.plan, found.day, found.dayIndex, state, found.day.id)
  if (!dinnerMode && found.meal.type === 'dinner' && found.meal.scenario !== 'default' && found.meal.scenario !== originalDinnerMode) fail('请从当前选中的晚餐发起替换')
  return sanitizeTarget({ version: TARGET_VERSION, planId: found.plan.id, dayId: found.day.id, mealId,
    sourceSnapshot: sourceSnapshot(state, found),
    originalDinnerMode, dinnerMode })
}
function assertTargetCurrent(state, rawTarget) {
  const target = sanitizeTarget(rawTarget)
  const found = findMeal(state.activePlan, target.mealId)
  if (!found || found.plan.id !== target.planId || found.day.id !== target.dayId
    || sourceSnapshot(state, found) !== target.sourceSnapshot
    || shopping.selectedDinnerMode(found.plan, found.day, found.dayIndex, state, found.day.id) !== target.originalDinnerMode) {
    fail('原餐食或晚餐模式已变化，请重新预览生成', 'MEAL_REPLACEMENT_CONFLICT')
  }
  createTarget(state, target.mealId, { dinnerMode: target.dinnerMode })
  return { target, ...found }
}
function assertRequest(state, rawTarget, input) {
  const current = assertTargetCurrent(state, rawTarget)
  if (!input || input.durationDays !== 1 || !Array.isArray(input.mealTypes) || input.mealTypes.length !== 1
    || input.mealTypes[0] !== current.meal.type || input.doubleDinner !== false
    || input.startDate !== current.day.date) fail('只换一餐只能生成所选日期的一个餐次')
  const expectedMode = current.target.dinnerMode || current.target.originalDinnerMode
  if (current.meal.type === 'dinner' && (!Array.isArray(input.exerciseByDay) || input.exerciseByDay.length !== 1
    || Boolean(input.exerciseByDay[0].planned) !== (expectedMode === 'workout'))) fail('生成条件与所选晚餐运动模式不一致')
  return current.target
}
function assertSingleMealDraft(draft) {
  if (!draft || !draft.replacementTarget) fail('没有待确认的单餐候选')
  const target = sanitizeTarget(draft.replacementTarget)
  if (draft.source !== 'ai' || draft.durationDays !== 1 || !Array.isArray(draft.days) || draft.days.length !== 1
    || !Array.isArray(draft.days[0].meals) || draft.days[0].meals.length !== 1) fail('单餐候选必须恰好包含一天一餐')
  const meal = draft.days[0].meals[0]
  if (meal.scenario !== 'default' || !Array.isArray(meal.ingredients) || !meal.ingredients.length) fail('单餐候选结构无效')
  if (meal.ingredients.length > 30 || meal.ingredients.some(item => !object(item)
    || !Number.isFinite(item.quantity) || item.quantity < 0.001 || item.quantity > 100000
    || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 50
    || typeof item.unit !== 'string' || !item.unit.trim() || item.unit.length > 12
    || typeof item.category !== 'string' || !item.category.trim() || item.category.length > 20)) fail('单餐食材份量无效')
  return { target, meal, day: draft.days[0] }
}
function proposal(state, draft) {
  const generated = assertSingleMealDraft(draft)
  const current = assertTargetCurrent(state, generated.target)
  if (generated.meal.type !== current.meal.type || generated.day.date !== current.day.date
    || draft.startDate !== current.day.date) fail('候选餐次或日期与原餐不一致')
  const expectedExercise = generated.target.dinnerMode || generated.target.originalDinnerMode
  if (current.meal.type === 'dinner' && Boolean(generated.day.exercise && generated.day.exercise.planned) !== (expectedExercise === 'workout')) fail('候选晚餐运动条件不一致')
  const newMeal = generated.meal
  const override = {
    title: newMeal.title, ingredients: newMeal.ingredients.map(item => `${item.name} ${item.quantity} ${item.unit}`).join(' · ').slice(0, 500),
    ingredientItems: copy(newMeal.ingredients), method: newMeal.method, tag: newMeal.tag || '', updatedAt: draft.generatedAt,
  }
  const mealOverrides = { ...state.mealOverrides, [generated.target.mealId]: override }
  const dinnerModeByDay = { ...state.dinnerModeByDay }
  if (generated.target.dinnerMode) dinnerModeByDay[generated.target.dayId] = generated.target.dinnerMode
  const next = shopping.reconcileChecks(state, { ...state, mealOverrides, dinnerModeByDay })
  // Validate dynamic shopping IDs/capacity before a draft can be confirmed.
  shopping.shoppingIds(next.activePlan, mealOverrides)
  return { ...next, draftPlan: null, stateRevision: state.stateRevision + 1 }
}
module.exports = { TARGET_VERSION, sanitizeTarget, createTarget, assertTargetCurrent, assertRequest, assertSingleMealDraft, proposal }
