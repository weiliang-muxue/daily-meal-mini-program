'use strict'

// Presentation only. Scope validation is repeated by both cloud functions.
const replacement = require('./meal-replacement')
const { buildPlanView } = require('./plan-view')
const { shoppingChanges } = require('./meal-editor')
const LABELS = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' }
function fail(message) { throw new Error(message) }
function routeScope(options = {}) {
  if (!['planId', 'mealId', 'dinnerMode'].some(key => Object.prototype.hasOwnProperty.call(options, key))) return null
  for (const key of ['planId', 'mealId']) {
    if (typeof options[key] !== 'string' || !options[key].trim() || options[key].length > 120 || /[\u0000-\u001f\u007f]/.test(options[key])) fail('餐食入口已失效，请返回餐单重新选择')
  }
  if (options.dinnerMode !== undefined && !['rest', 'workout'].includes(options.dinnerMode)) fail('晚餐模式无效，请重新选择')
  return { planId: options.planId, mealId: options.mealId, ...(options.dinnerMode ? { dinnerMode: options.dinnerMode } : {}) }
}
function plannerUrl(scope) {
  const valid = routeScope(scope)
  if (!valid) fail('请先选择一餐')
  return `/pages/planner/planner?${Object.keys(valid).map(key => `${key}=${encodeURIComponent(valid[key])}`).join('&')}`
}
function createContext(state, scope) {
  if (!state.activePlan || state.activePlan.id !== scope.planId) fail('当前餐单已变化，请返回重新选择')
  const target = replacement.createTarget(state, scope.mealId, scope)
  const current = replacement.assertTargetCurrent(state, target)
  return { target, date: current.day.date, mealType: current.meal.type,
    label: `${current.day.date} · ${LABELS[current.meal.type]}`,
    dinnerLocked: current.meal.type === 'dinner',
    mode: target.dinnerMode || target.originalDinnerMode,
    exercise: current.day.exercise || {},
  }
}
function lockPreferences(preferences, context) {
  if (!context) return preferences
  const exercise = { ...(preferences.exerciseByDay && preferences.exerciseByDay[0] || {}), dayIndex: 0 }
  if (context.dinnerLocked) {
    exercise.planned = context.mode === 'workout'
    if (!exercise.planned) Object.assign(exercise, { type: '', durationMinutes: 0, intensity: 'medium' })
  }
  return { ...preferences, durationDays: 1, startDate: context.date, mealTypes: [context.mealType], doubleDinner: false,
    exerciseNotes: (context.dinnerLocked ? !exercise.planned : preferences.exerciseIntent === 'none') ? '' : preferences.exerciseNotes,
    exerciseIntent: context.dinnerLocked ? (exercise.planned ? 'daily' : 'none') : preferences.exerciseIntent, exerciseByDay: [exercise] }
}
function initialPreferences(state, context) {
  return lockPreferences({ ...(state.generationPreferences || {}), exerciseIntent: context.exercise.planned ? 'daily' : 'none',
    exerciseByDay: [{ ...context.exercise, dayIndex: 0 }] }, context)
}
function preview(state, draft) {
  const next = replacement.proposal(state, draft)
  const target = draft.replacementTarget
  const beforeDay = buildPlanView(state.activePlan, state).days.find(day => day.id === target.dayId)
  const afterDay = buildPlanView(next.activePlan, next).days.find(day => day.id === target.dayId)
  const targetMeal = beforeDay.allMeals.find(meal => meal.id === target.mealId)
  const modeChanged = Boolean(target.dinnerMode && target.dinnerMode !== target.originalDinnerMode)
  const original = modeChanged ? beforeDay.meals.find(meal => meal.type === 'dinner') : targetMeal
  const candidate = afterDay.allMeals.find(meal => meal.id === target.mealId)
  return { label: `${beforeDay.date} · ${LABELS[targetMeal.type]}`, original, candidate,
    targetMealTitle: original.id !== targetMeal.id ? targetMeal.title : '',
    modeNote: modeChanged ? `同时将当天晚餐改为${target.dinnerMode === 'rest' ? '不运动' : '运动'}方案；不会改动运动打卡记录。` : '',
    ...shoppingChanges(state, next) }
}
module.exports = { routeScope, plannerUrl, createContext, lockPreferences, initialPreferences, preview }
