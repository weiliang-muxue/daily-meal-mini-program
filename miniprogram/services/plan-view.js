/*
 * Pure view-model helpers for confirmed dynamic meal plans.
 * This module deliberately has no wx, cloud, env, or configuration dependency.
 */

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack']
const MEAL_LABELS = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' }
const SCENARIOS = ['default', 'rest', 'workout']

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function number(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback
}

function uniqueStrings(value) {
  return Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === 'string' && item))] : []
}

function stableDayId(plan, day, index) {
  return text(day && day.id, `${text(plan && plan.id, 'plan')}-d${index + 1}`)
}

function stableMealId(plan, dayId, meal, type, scenario, index) {
  return text(meal && (meal.id || meal.mealId), `${text(plan && plan.id, 'plan')}:${dayId}:meal:${type}:${scenario}:${index + 1}`)
}

function normalizeScenario(value) {
  return SCENARIOS.includes(value) ? value : 'default'
}

function normalizeType(value) {
  return MEAL_TYPES.includes(value) ? value : 'snack'
}

function displayMeal(plan, dayId, meal, index, state) {
  const type = normalizeType(meal && meal.type)
  const scenario = normalizeScenario(meal && meal.scenario)
  const mealId = stableMealId(plan, dayId, meal, type, scenario, index)
  const ingredientItems = Array.isArray(meal && meal.ingredients) ? meal.ingredients : []
  const ingredientsText = ingredientItems.length
    ? ingredientItems.map((item) => `${text(item.name)} ${number(item.quantity)} ${text(item.unit)}`).join(' · ')
    : text(meal && meal.ingredients)
  const overrides = state && state.mealOverrides && typeof state.mealOverrides === 'object'
    ? state.mealOverrides : {}
  const override = overrides[mealId] && typeof overrides[mealId] === 'object' ? overrides[mealId] : null
  return {
    ...(meal && typeof meal === 'object' ? meal : {}),
    mealId,
    id: text(meal && meal.id, mealId),
    type,
    scenario,
    label: text(meal && meal.label, MEAL_LABELS[type]),
    title: text(override && override.title, text(meal && meal.title, '未命名餐食')),
    ingredients: text(override && override.ingredients, ingredientsText),
    ingredientItems,
    method: text(override && override.method, text(meal && meal.method)),
    tag: text(override && override.tag, text(meal && meal.tag)),
    personalized: Boolean(override),
  }
}

function selectedDinnerMode(state, dayId) {
  const byDay = state && state.dinnerModeByDay && typeof state.dinnerModeByDay === 'object'
    ? state.dinnerModeByDay : {}
  const mode = byDay[dayId] || (state && state.defaultDinnerMode)
  return mode === 'workout' ? 'workout' : 'rest'
}

function buildDay(plan, day, dayIndex, state) {
  const dayId = stableDayId(plan, day, dayIndex)
  const sourceMeals = Array.isArray(day && day.meals) ? day.meals : []
  const meals = sourceMeals.map((meal, index) => displayMeal(plan, dayId, meal, index, state))
  const dinners = meals.filter((meal) => meal.type === 'dinner')
  const hasRest = dinners.some((meal) => meal.scenario === 'rest')
  const hasWorkout = dinners.some((meal) => meal.scenario === 'workout')
  const mode = selectedDinnerMode(state, dayId)
  const visibleMeals = dinners.length && hasRest && hasWorkout
    ? meals.filter((meal) => meal.type !== 'dinner' || meal.scenario === 'default' || meal.scenario === mode)
    : meals
  return {
    ...(day && typeof day === 'object' ? day : {}),
    id: dayId,
    dayIndex,
    short: text(day && day.short),
    name: text(day && day.name, `第 ${dayIndex + 1} 天`),
    date: text(day && day.date),
    meals: visibleMeals,
    allMeals: meals,
    dinnerMode: mode,
    hasDinnerAlternatives: hasRest && hasWorkout,
    mealCount: visibleMeals.length,
    selected: false,
  }
}

function dateRange(days) {
  const dates = days.map((day) => day.date).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
  if (!dates.length) return { startDate: '', endDate: '', text: '' }
  const sorted = [...dates].sort()
  return { startDate: sorted[0], endDate: sorted[sorted.length - 1], text: `${sorted[0]} ~ ${sorted[sorted.length - 1]}` }
}

function mealSummary(days) {
  const counts = { breakfast: 0, lunch: 0, dinner: 0, snack: 0 }
  days.forEach((day) => day.meals.forEach((meal) => { counts[meal.type] = (counts[meal.type] || 0) + 1 }))
  const parts = MEAL_TYPES.filter((type) => counts[type] > 0).map((type) => `${MEAL_LABELS[type]} ${counts[type]} 次`)
  return { counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0), text: parts.join(' · ') }
}

function shoppingView(plan, state) {
  const checked = new Set(uniqueStrings(state && state.checkedShoppingIds))
  const groups = Array.isArray(plan && plan.shoppingGroups) ? plan.shoppingGroups.map((group, groupIndex) => {
    const groupId = text(group && group.id, `${text(plan && plan.id, 'plan')}:shopping:g${groupIndex + 1}`)
    const items = Array.isArray(group && group.items) ? group.items.map((item, itemIndex) => {
      const itemId = text(item && (item.id || item.itemId), `${groupId}:i${itemIndex + 1}`)
      return { ...(item && typeof item === 'object' ? item : {}), id: itemId, itemId, checked: checked.has(itemId) }
    }) : []
    const checkedCount = items.filter((item) => item.checked).length
    return {
      ...(group && typeof group === 'object' ? group : {}),
      id: groupId,
      items,
      checkedCount,
      totalCount: items.length,
      allChecked: items.length > 0 && checkedCount === items.length,
    }
  }) : []
  const totalCount = groups.reduce((sum, group) => sum + group.totalCount, 0)
  const checkedCount = groups.reduce((sum, group) => sum + group.checkedCount, 0)
  return {
    groups,
    checkedIds: groups.flatMap((group) => group.items.filter((item) => item.checked).map((item) => item.itemId)),
    checkedCount,
    totalCount,
    remainingCount: totalCount - checkedCount,
    allChecked: totalCount > 0 && checkedCount === totalCount,
  }
}

function historySummary(state) {
  const history = Array.isArray(state && state.planHistory) ? state.planHistory : []
  return history.map((plan, index) => ({
    id: text(plan && plan.id, `history-${index + 1}`),
    title: text(plan && plan.title, '未命名计划'),
    durationDays: number(plan && plan.durationDays, Array.isArray(plan && plan.days) ? plan.days.length : 0),
    planVersion: number(plan && plan.planVersion, 0),
    source: text(plan && plan.source, 'unknown'),
    generatedAt: text(plan && (plan.generatedAt || plan.createdAt)),
  }))
}

function emptyView(state = {}) {
  return {
    hasPlan: false,
    plan: null,
    planId: '',
    title: '',
    durationDays: 0,
    planVersion: 0,
    days: [],
    selectedDayId: '',
    selectedDayIndex: -1,
    selectedDay: null,
    canSwitch: false,
    canSwitchDay: false,
    dateRange: dateRange([]),
    mealSummary: mealSummary([]),
    shopping: shoppingView(null, state),
    history: historySummary(state),
  }
}

function buildPlanView(activePlan, state = {}, options = {}) {
  if (!activePlan || typeof activePlan !== 'object' || !Array.isArray(activePlan.days) || !activePlan.days.length) return emptyView(state)
  const days = activePlan.days.map((day, index) => buildDay(activePlan, day, index, state))
  const requestedId = text(options.dayId || options.selectedDayId || state.selectedDayId)
  let selectedDayIndex = days.findIndex((day) => day.id === requestedId)
  if (selectedDayIndex < 0) {
    const fallback = Math.max(0, Math.min(days.length - 1, number(options.selectedDay ?? state.selectedDay, 0)))
    selectedDayIndex = fallback
  }
  const selectedDayId = days[selectedDayIndex].id
  const markedDays = days.map((day, index) => ({ ...day, selected: index === selectedDayIndex }))
  return {
    hasPlan: true,
    plan: activePlan,
    planId: text(activePlan.id),
    title: text(activePlan.title),
    durationDays: number(activePlan.durationDays, days.length),
    planVersion: number(activePlan.planVersion, 0),
    days: markedDays,
    selectedDayId,
    selectedDayIndex,
    selectedDay: markedDays[selectedDayIndex],
    canSwitch: days.length > 1,
    canSwitchDay: days.length > 1,
    dateRange: dateRange(days),
    mealSummary: mealSummary(markedDays),
    shopping: shoppingView(activePlan, state),
    history: historySummary(state),
  }
}

function selectDay(activePlan, state = {}, dayId) {
  return buildPlanView(activePlan, state, { dayId })
}

module.exports = {
  buildPlanView,
  selectDay,
  shoppingView,
  historySummary,
  dateRange,
  mealSummary,
}
