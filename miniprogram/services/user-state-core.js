'use strict'

const CURRENT_SCHEMA = 7
const CURRENT_AI_CONTRACT = 2
const MAX_HISTORY = 64
const MAX_PLAN_BYTES = 128 * 1024
const MAX_STATE_BYTES = 900 * 1024
const MIN_DAYS = 1
const MAX_DAYS = 14
const MAX_MEALS_PER_DAY = 5
const MAX_SHOPPING_GROUPS = 12
const MAX_SHOPPING_ITEMS_PER_GROUP = 40
const MAX_CHECKED_SHOPPING_IDS = MAX_SHOPPING_GROUPS * MAX_SHOPPING_ITEMS_PER_GROUP
const MAX_MEAL_OVERRIDES = (MAX_HISTORY + 2) * MAX_DAYS * MAX_MEALS_PER_DAY

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack']
const SCENARIOS = ['default', 'rest', 'workout']
const INTENSITIES = ['low', 'medium', 'high']
const EXERCISE_INTENTS = ['none', 'daily']

function fail(message, code = 'INVALID_USER_STATE') {
  const error = new Error(message)
  error.code = code
  throw error
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const BLOCKED_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function trustedArrayKey(value) {
  if (!isObject(value)) return ''
  if (typeof value.id === 'string' && value.id) return `id:${value.id}`
  if (Number.isSafeInteger(value.dayIndex)) return `dayIndex:${value.dayIndex}`
  return ''
}

function cloneTrustedValue(value, depth = 0) {
  if (depth > 40) fail('trusted user state is too deeply nested', 'STATE_TOO_LARGE')
  if (Array.isArray(value)) return value.map((item) => cloneTrustedValue(item, depth + 1))
  if (!isObject(value)) return value
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  const result = {}
  Object.keys(value).forEach((key) => {
    if (!BLOCKED_OBJECT_KEYS.has(key)) result[key] = cloneTrustedValue(value[key], depth + 1)
  })
  return result
}

// Sanitized values always win. Unknown keys are copied only from a trusted stored
// state, never from an incoming client object. Stable array IDs avoid attaching a
// future field to the wrong plan/day/meal when history order changes.
function mergeTrustedUnknown(sanitized, trusted, depth = 0, path = []) {
  if (depth > 40) fail('trusted user state is too deeply nested', 'STATE_TOO_LARGE')
  if (Array.isArray(sanitized)) {
    if (!Array.isArray(trusted)) return sanitized
    const byKey = new Map()
    trusted.forEach((item) => {
      const key = trustedArrayKey(item)
      if (key && !byKey.has(key)) byKey.set(key, item)
    })
    return sanitized.map((item, index) => {
      const key = trustedArrayKey(item)
      const source = key ? byKey.get(key) : trusted[index]
      return mergeTrustedUnknown(item, source, depth + 1, [...path, '[]'])
    })
  }
  if (!isObject(sanitized) || !isObject(trusted)) return sanitized
  if (typeof sanitized.id === 'string' && sanitized.id
    && typeof trusted.id === 'string' && trusted.id && sanitized.id !== trusted.id) return sanitized
  if (Number.isSafeInteger(sanitized.dayIndex) && Number.isSafeInteger(trusted.dayIndex)
    && sanitized.dayIndex !== trusted.dayIndex) return sanitized
  const result = {}
  Object.keys(sanitized).forEach((key) => {
    if (!BLOCKED_OBJECT_KEYS.has(key)) {
      result[key] = mergeTrustedUnknown(sanitized[key], trusted[key], depth + 1, [...path, key])
    }
  })
  const dynamicMap = path.length === 1 && ['dinnerModeByDay', 'planUiStateByPlan', 'mealOverrides'].includes(path[0])
  if (!dynamicMap) {
    Object.keys(trusted).forEach((key) => {
      if (!BLOCKED_OBJECT_KEYS.has(key) && !Object.prototype.hasOwnProperty.call(result, key)) {
        result[key] = cloneTrustedValue(trusted[key], depth + 1)
      }
    })
  }
  return result
}

function cleanText(value, field, maxLength, options = {}) {
  if (value === undefined || value === null) {
    if (options.required) fail(`${field} is required`)
    return ''
  }
  if (typeof value !== 'string') fail(`${field} must be a string`)
  const result = value.trim().replace(/[\u0000-\u001f\u007f]/g, '')
  if (options.required && !result) fail(`${field} is required`)
  if (result.length > maxLength) fail(`${field} exceeds ${maxLength} characters`)
  return result
}

function finiteInteger(value, field, minimum, maximum, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    fail(`${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return number
}

function uniqueTextArray(value, field, options = {}) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) fail(`${field} must be an array`)
  if (value.length > options.maxItems) fail(`${field} has too many items`)
  const result = []
  const seen = new Set()
  value.forEach((item, index) => {
    const text = cleanText(item, `${field}[${index}]`, options.maxLength, { required: true })
    if (options.allowed && !options.allowed.includes(text)) fail(`${field}[${index}] is not supported`)
    if (!seen.has(text)) {
      seen.add(text)
      result.push(text)
    }
  })
  return result
}

function optionalDate(value, field) {
  const date = cleanText(value, field, 10)
  if (!date) return ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`${field} is not a valid date`)
  const [year, month, day] = date.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) {
    fail(`${field} is not a valid calendar date`)
  }
  return date
}

function optionalTimestamp(value, field) {
  const timestamp = cleanText(value, field, 40)
  if (!timestamp) return ''
  if (Number.isNaN(Date.parse(timestamp))) fail(`${field} is not a valid timestamp`)
  return timestamp
}

function utf8ByteLength(value) {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const point = value.codePointAt(index)
    if (point <= 0x7f) bytes += 1
    else if (point <= 0x7ff) bytes += 2
    else if (point <= 0xffff) bytes += 3
    else {
      bytes += 4
      index += 1
    }
  }
  return bytes
}

function assertPlanSize(plan, field) {
  let serialized
  try { serialized = JSON.stringify(plan) } catch (_) { fail(`${field} must be serializable`) }
  if (!serialized || utf8ByteLength(serialized) > MAX_PLAN_BYTES) {
    fail(`${field} exceeds ${MAX_PLAN_BYTES} bytes`, 'PLAN_TOO_LARGE')
  }
}

function assertStateSize(state) {
  let serialized
  try { serialized = JSON.stringify(state) } catch (_) { fail('user state must be serializable') }
  if (!serialized || utf8ByteLength(serialized) > MAX_STATE_BYTES) {
    fail(`user state exceeds ${MAX_STATE_BYTES} bytes`, 'STATE_TOO_LARGE')
  }
}

function defaultGenerationPreferences() {
  return {
    contractVersion: CURRENT_AI_CONTRACT,
    durationDays: MIN_DAYS,
    startDate: '',
    mealTypes: [],
    doubleDinner: false,
    goals: [],
    styles: [],
    customGoal: '',
    restrictions: '',
    healthNotes: '',
    exerciseIntent: '',
    exerciseNotes: '',
    exerciseByDay: [],
  }
}

function defaults() {
  return {
    schemaVersion: CURRENT_SCHEMA,
    stateRevision: 0,
    activePlan: null,
    draftPlan: null,
    planHistory: [],
    generationPreferences: defaultGenerationPreferences(),
    activePlanId: '',
    selectedDayId: '',
    selectedDay: 0,
    defaultDinnerMode: 'rest',
    dinnerModeByDay: {},
    planUiStateByPlan: {},
    mealOverrides: {},
    checkedShoppingIds: [],
    customReminders: [],
    settings: { calciumAnchorReminder: false, vitaminDReminder: false },
  }
}

function sanitizeExercise(raw, field, dayIndex) {
  if (raw === undefined || raw === null) {
    return { dayIndex, planned: false, type: '', durationMinutes: 0, intensity: 'medium' }
  }
  if (!isObject(raw)) fail(`${field} must be an object`)
  const planned = Boolean(raw.planned)
  return {
    dayIndex,
    planned,
    type: planned ? cleanText(raw.type, `${field}.type`, 30) : '',
    durationMinutes: planned ? finiteInteger(raw.durationMinutes, `${field}.durationMinutes`, 0, 360, 0) : 0,
    intensity: planned && INTENSITIES.includes(raw.intensity) ? raw.intensity : 'medium',
  }
}

function sanitizeGenerationPreferences(raw) {
  const value = isObject(raw) ? raw : {}
  const durationDays = finiteInteger(
    value.durationDays, 'generationPreferences.durationDays', MIN_DAYS, MAX_DAYS, MIN_DAYS,
  )
  const mealTypes = uniqueTextArray(value.mealTypes, 'generationPreferences.mealTypes', {
    maxItems: 4, maxLength: 20, allowed: MEAL_TYPES,
  })
  const exerciseInput = value.exerciseByDay === undefined || value.exerciseByDay === null ? [] : value.exerciseByDay
  if (!Array.isArray(exerciseInput)) fail('generationPreferences.exerciseByDay must be an array')
  if (exerciseInput.length > durationDays) fail('generationPreferences.exerciseByDay has too many items')
  const seenDays = new Set()
  const exerciseByDay = exerciseInput.map((item, index) => {
    if (!isObject(item)) fail(`generationPreferences.exerciseByDay[${index}] must be an object`)
    const dayIndex = finiteInteger(item.dayIndex, `generationPreferences.exerciseByDay[${index}].dayIndex`, 0, durationDays - 1, index)
    if (seenDays.has(dayIndex)) fail('generationPreferences.exerciseByDay contains duplicate dayIndex values')
    seenDays.add(dayIndex)
    return sanitizeExercise(item, `generationPreferences.exerciseByDay[${index}]`, dayIndex)
  }).sort((left, right) => left.dayIndex - right.dayIndex)
  return {
    contractVersion: CURRENT_AI_CONTRACT,
    durationDays,
    startDate: optionalDate(value.startDate, 'generationPreferences.startDate'),
    mealTypes,
    doubleDinner: mealTypes.includes('dinner') && Boolean(value.doubleDinner),
    goals: uniqueTextArray(value.goals, 'generationPreferences.goals', { maxItems: 10, maxLength: 40 }),
    styles: uniqueTextArray(value.styles, 'generationPreferences.styles', { maxItems: 10, maxLength: 40 }),
    customGoal: cleanText(value.customGoal, 'generationPreferences.customGoal', 160),
    restrictions: cleanText(value.restrictions, 'generationPreferences.restrictions', 240),
    healthNotes: cleanText(value.healthNotes, 'generationPreferences.healthNotes', 240),
    exerciseIntent: EXERCISE_INTENTS.includes(value.exerciseIntent) ? value.exerciseIntent : '',
    exerciseNotes: cleanText(value.exerciseNotes, 'generationPreferences.exerciseNotes', 160),
    exerciseByDay,
  }
}

function sanitizeGenerationBasis(raw, field) {
  const value = isObject(raw) ? raw : {}
  const mealTypes = uniqueTextArray(value.mealTypes, `${field}.mealTypes`, {
    maxItems: 4, maxLength: 20, allowed: MEAL_TYPES,
  })
  const exerciseInput = value.exerciseByDay === undefined || value.exerciseByDay === null ? [] : value.exerciseByDay
  if (!Array.isArray(exerciseInput)) fail(`${field}.exerciseByDay must be an array`)
  if (exerciseInput.length > MAX_DAYS) fail(`${field}.exerciseByDay has too many items`)
  return {
    mealTypes,
    doubleDinner: mealTypes.includes('dinner') && Boolean(value.doubleDinner),
    goals: uniqueTextArray(value.goals, `${field}.goals`, { maxItems: 10, maxLength: 40 }),
    styles: uniqueTextArray(value.styles, `${field}.styles`, { maxItems: 10, maxLength: 40 }),
    customGoal: cleanText(value.customGoal, `${field}.customGoal`, 160),
    restrictions: cleanText(value.restrictions, `${field}.restrictions`, 240),
    healthNotes: cleanText(value.healthNotes, `${field}.healthNotes`, 240),
    exerciseIntent: EXERCISE_INTENTS.includes(value.exerciseIntent) ? value.exerciseIntent : '',
    exerciseNotes: cleanText(value.exerciseNotes, `${field}.exerciseNotes`, 160),
    exerciseByDay: exerciseInput.map((item, index) => sanitizeExercise(item, `${field}.exerciseByDay[${index}]`, index)),
  }
}

function sanitizeIngredient(raw, field) {
  if (!isObject(raw)) fail(`${field} must be an object`)
  const quantity = Number(raw.quantity)
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) fail(`${field}.quantity must be a positive number`)
  return {
    name: cleanText(raw.name, `${field}.name`, 50, { required: true }),
    quantity: Math.round(quantity * 1000) / 1000,
    unit: cleanText(raw.unit, `${field}.unit`, 12, { required: true }),
    category: cleanText(raw.category, `${field}.category`, 20, { required: true }),
  }
}

function sanitizeMeal(raw, field, options = {}) {
  if (!isObject(raw)) fail(`${field} must be an object`)
  const type = cleanText(raw.type, `${field}.type`, 20, { required: true })
  const scenario = cleanText(raw.scenario === undefined ? 'default' : raw.scenario, `${field}.scenario`, 20, { required: true })
  if (!MEAL_TYPES.includes(type)) fail(`${field}.type is not supported`)
  if (!SCENARIOS.includes(scenario)) fail(`${field}.scenario is not supported`)
  let ingredients
  if (Array.isArray(raw.ingredients)) {
    if (!raw.ingredients.length || raw.ingredients.length > 30) fail(`${field}.ingredients must contain 1 to 30 items`)
    ingredients = raw.ingredients.map((item, index) => sanitizeIngredient(item, `${field}.ingredients[${index}]`))
  } else if (options.allowTextIngredients) {
    ingredients = cleanText(raw.ingredients, `${field}.ingredients`, 500, { required: true })
  } else {
    fail(`${field}.ingredients must be a structured array`)
  }
  return {
    id: cleanText(raw.id, `${field}.id`, 120, { required: true }),
    type,
    scenario,
    label: cleanText(raw.label, `${field}.label`, 30),
    title: cleanText(raw.title, `${field}.title`, 50, { required: true }),
    ingredients,
    method: cleanText(raw.method, `${field}.method`, 500, { required: true }),
    tag: cleanText(raw.tag, `${field}.tag`, 80),
  }
}

function sanitizeDay(raw, field, dayIndex, options = {}) {
  if (!isObject(raw)) fail(`${field} must be an object`)
  if (!Array.isArray(raw.meals) || !raw.meals.length) fail(`${field}.meals must not be empty`)
  if (raw.meals.length > MAX_MEALS_PER_DAY) fail(`${field}.meals has too many items`)
  const mealIds = new Set()
  const mealKeys = new Set()
  const meals = raw.meals.map((meal, mealIndex) => {
    const result = sanitizeMeal(meal, `${field}.meals[${mealIndex}]`, options)
    if (mealIds.has(result.id)) fail(`${field}.meals contains duplicate IDs`)
    const key = `${result.type}:${result.scenario}`
    if (mealKeys.has(key)) fail(`${field}.meals contains duplicate type/scenario values`)
    mealIds.add(result.id)
    mealKeys.add(key)
    return result
  })
  return {
    id: cleanText(raw.id, `${field}.id`, 120, { required: true }),
    date: optionalDate(raw.date, `${field}.date`),
    short: cleanText(raw.short, `${field}.short`, 4),
    name: cleanText(raw.name, `${field}.name`, 12),
    theme: cleanText(raw.theme, `${field}.theme`, 40),
    exercise: sanitizeExercise(raw.exercise, `${field}.exercise`, dayIndex),
    meals,
  }
}

function sanitizeShoppingGroups(raw, field, allowEmpty) {
  if (raw === undefined || raw === null) raw = []
  if (!Array.isArray(raw)) fail(`${field} must be an array`)
  if (!allowEmpty && !raw.length) fail(`${field} must not be empty`)
  if (raw.length > MAX_SHOPPING_GROUPS) fail(`${field} has too many groups`)
  const groupIds = new Set()
  const itemIds = new Set()
  return raw.map((group, groupIndex) => {
    const groupField = `${field}[${groupIndex}]`
    if (!isObject(group)) fail(`${groupField} must be an object`)
    const id = cleanText(group.id, `${groupField}.id`, 120, { required: true })
    if (groupIds.has(id)) fail(`${field} contains duplicate group IDs`)
    groupIds.add(id)
    if (!Array.isArray(group.items) || !group.items.length) fail(`${groupField}.items must not be empty`)
    if (group.items.length > MAX_SHOPPING_ITEMS_PER_GROUP) fail(`${groupField}.items has too many items`)
    const items = group.items.map((item, itemIndex) => {
      const itemField = `${groupField}.items[${itemIndex}]`
      if (!isObject(item)) fail(`${itemField} must be an object`)
      const itemId = cleanText(item.id, `${itemField}.id`, 120, { required: true })
      if (itemIds.has(itemId)) fail(`${field} contains duplicate item IDs`)
      itemIds.add(itemId)
      return {
        id: itemId,
        name: cleanText(item.name, `${itemField}.name`, 50, { required: true }),
        amount: cleanText(item.amount, `${itemField}.amount`, 80, { required: true }),
      }
    })
    return { id, name: cleanText(group.name, `${groupField}.name`, 30, { required: true }), items }
  })
}

function sanitizePlan(raw, field = 'plan') {
  if (!isObject(raw)) fail(`${field} must be an object`)
  assertPlanSize(raw, field)
  const source = cleanText(raw.source, `${field}.source`, 20, { required: true })
  if (!['ai', 'legacy', 'user'].includes(source)) fail(`${field}.source is not supported`)
  if (!Array.isArray(raw.days)) fail(`${field}.days must be an array`)
  if (raw.days.length < MIN_DAYS) fail(`${field}.days must contain at least ${MIN_DAYS} day`)
  if (raw.days.length > MAX_DAYS) fail(`${field}.days has too many items`)
  const dayIds = new Set()
  const mealIds = new Set()
  const days = raw.days.map((day, dayIndex) => {
    const result = sanitizeDay(day, `${field}.days[${dayIndex}]`, dayIndex, { allowTextIngredients: source !== 'ai' })
    if (dayIds.has(result.id)) fail(`${field}.days contains duplicate IDs`)
    dayIds.add(result.id)
    result.meals.forEach((meal) => {
      if (mealIds.has(meal.id)) fail(`${field} contains duplicate meal IDs`)
      mealIds.add(meal.id)
    })
    return result
  })
  const durationDays = finiteInteger(raw.durationDays, `${field}.durationDays`, MIN_DAYS, MAX_DAYS, days.length)
  if (durationDays !== days.length) fail(`${field}.durationDays does not match days`)
  const result = {
    id: cleanText(raw.id, `${field}.id`, 120, { required: true }),
    planVersion: finiteInteger(raw.planVersion, `${field}.planVersion`, 1, 1000000, 1),
    contractVersion: finiteInteger(raw.contractVersion, `${field}.contractVersion`, 0, 1000000, 0),
    source,
    title: cleanText(raw.title, `${field}.title`, 50, { required: true }),
    durationDays,
    startDate: optionalDate(raw.startDate, `${field}.startDate`),
    generatedAt: optionalTimestamp(raw.generatedAt, `${field}.generatedAt`),
    preferencesHash: cleanText(raw.preferencesHash, `${field}.preferencesHash`, 64),
    generationBasis: sanitizeGenerationBasis(raw.generationBasis, `${field}.generationBasis`),
    rationale: uniqueTextArray(raw.rationale, `${field}.rationale`, { maxItems: 8, maxLength: 120 }),
    days,
    shoppingGroups: sanitizeShoppingGroups(raw.shoppingGroups, `${field}.shoppingGroups`, source === 'legacy'),
  }
  assertPlanSize(result, field)
  return result
}

function legacyMeal(raw, planId, dayId, key, type, scenario, label) {
  if (!isObject(raw)) return null
  return {
    id: `${dayId}:${key}`,
    type,
    scenario,
    label: cleanText(raw.label, `legacyPlan.${key}.label`, 30) || label,
    title: raw.title,
    ingredients: raw.ingredients,
    method: raw.method,
    tag: raw.tag,
  }
}

function convertLegacyPlan(legacyPlan, legacyShoppingGroups) {
  if (!isObject(legacyPlan)) fail('legacyPlan must be an object')
  const planId = cleanText(legacyPlan.id, 'legacyPlan.id', 120, { required: true })
  if (!Array.isArray(legacyPlan.days)) fail('legacyPlan.days must be an array')
  const days = legacyPlan.days.map((day, index) => {
    if (!isObject(day)) fail(`legacyPlan.days[${index}] must be an object`)
    if (Array.isArray(day.meals)) return { ...day }
    const dayId = cleanText(day.id, `legacyPlan.days[${index}].id`, 120, { required: true })
    const meals = [
      legacyMeal(day.breakfast, planId, dayId, 'breakfast', 'breakfast', 'default', '早餐'),
      legacyMeal(day.lunch, planId, dayId, 'lunch', 'lunch', 'default', '午餐'),
      legacyMeal(day.restDinner, planId, dayId, 'restDinner', 'dinner', 'rest', '晚餐 · 不运动'),
      legacyMeal(day.workoutDinner, planId, dayId, 'workoutDinner', 'dinner', 'workout', '晚餐 · 运动'),
      legacyMeal(day.snack, planId, dayId, 'snack', 'snack', 'default', '加餐'),
    ].filter(Boolean)
    return {
      id: dayId,
      date: day.date || '',
      short: day.short || '',
      name: day.name || '',
      theme: day.theme || '',
      exercise: day.exercise,
      meals,
    }
  })
  const candidate = {
    id: planId,
    planVersion: legacyPlan.planVersion || legacyPlan.contentVersion || 1,
    contractVersion: 0,
    source: 'legacy',
    title: legacyPlan.title || '历史餐食计划',
    durationDays: days.length,
    startDate: legacyPlan.startDate || '',
    generatedAt: legacyPlan.generatedAt || '',
    generationBasis: legacyPlan.generationBasis || {
      mealTypes: ['breakfast', 'dinner'],
      doubleDinner: true,
    },
    rationale: legacyPlan.rationale || [],
    days,
    shoppingGroups: legacyPlan.shoppingGroups || legacyShoppingGroups || [],
  }
  return sanitizePlan(candidate, 'legacyPlan')
}

function sanitizeModes(raw) {
  if (raw === undefined || raw === null) return {}
  if (!isObject(raw)) fail('dinnerModeByDay must be an object')
  const keys = Object.keys(raw)
  if (keys.length > 100) fail('dinnerModeByDay has too many entries')
  const result = {}
  keys.forEach((key, index) => {
    const id = cleanText(key, `dinnerModeByDay key ${index}`, 120, { required: true })
    result[id] = raw[key] === 'workout' ? 'workout' : 'rest'
  })
  return result
}

function planDayIds(plan) {
  return new Set(plan ? plan.days.map((day) => day.id) : [])
}

function planShoppingIds(plan) {
  const ids = new Set()
  if (plan) plan.shoppingGroups.forEach((group) => group.items.forEach((item) => ids.add(item.id)))
  return ids
}

function sanitizePlanUiState(raw, plan, field) {
  const value = isObject(raw) ? raw : {}
  const allowedDays = planDayIds(plan)
  const allowedShopping = planShoppingIds(plan)
  const selectedDay = finiteInteger(value.selectedDay, `${field}.selectedDay`, 0, 31, 0)
  const fallbackDay = plan && plan.days[Math.max(0, Math.min(plan.days.length - 1, selectedDay))]
  const selectedDayId = cleanText(value.selectedDayId, `${field}.selectedDayId`, 120)
  const dinnerModeByDay = Object.fromEntries(Object.entries(sanitizeModes(value.dinnerModeByDay))
    .filter(([dayId]) => allowedDays.has(dayId)))
  const checkedShoppingIds = uniqueTextArray(value.checkedShoppingIds, `${field}.checkedShoppingIds`, {
    maxItems: MAX_CHECKED_SHOPPING_IDS, maxLength: 120,
  }).filter((id) => allowedShopping.has(id))
  return {
    selectedDayId: allowedDays.has(selectedDayId) ? selectedDayId : (fallbackDay ? fallbackDay.id : ''),
    selectedDay: fallbackDay ? plan.days.findIndex((day) => day.id === (allowedDays.has(selectedDayId) ? selectedDayId : fallbackDay.id)) : 0,
    defaultDinnerMode: value.defaultDinnerMode === 'workout' ? 'workout' : 'rest',
    dinnerModeByDay,
    checkedShoppingIds,
  }
}

function sanitizePlanUiStateByPlan(raw, plans) {
  if (raw !== undefined && raw !== null && !isObject(raw)) fail('planUiStateByPlan must be an object')
  const source = isObject(raw) ? raw : {}
  const byId = new Map(plans.filter(Boolean).map((plan) => [plan.id, plan]))
  if (Object.keys(source).length > MAX_HISTORY + 2) fail('planUiStateByPlan has too many entries', 'STATE_HISTORY_LIMIT')
  const result = {}
  Object.entries(source).forEach(([rawPlanId, value], index) => {
    const planId = cleanText(rawPlanId, `planUiStateByPlan key ${index}`, 120, { required: true })
    const plan = byId.get(planId)
    if (plan) result[planId] = sanitizePlanUiState(value, plan, `planUiStateByPlan.${planId}`)
  })
  return result
}

function planMealIds(plans) {
  const ids = new Set()
  plans.filter(Boolean).forEach((plan) => {
    plan.days.forEach((day) => day.meals.forEach((meal) => ids.add(meal.id)))
  })
  return ids
}

function sanitizeMealOverrides(raw, plans) {
  if (raw === undefined || raw === null) return {}
  if (!isObject(raw)) fail('mealOverrides must be an object')
  const allowed = planMealIds(plans)
  const retained = Object.entries(raw).filter(([mealId]) => allowed.has(mealId))
  if (retained.length > MAX_MEAL_OVERRIDES) {
    fail(`mealOverrides exceeds ${MAX_MEAL_OVERRIDES} retained meals`, 'STATE_TOO_LARGE')
  }
  return Object.fromEntries(retained.map(([key, item], index) => {
    const id = cleanText(key, `mealOverrides key ${index}`, 120, { required: true })
    if (!isObject(item)) fail(`mealOverrides.${id} must be an object`)
    return [id, {
      title: cleanText(item.title, `mealOverrides.${id}.title`, 50),
      ingredients: cleanText(item.ingredients, `mealOverrides.${id}.ingredients`, 500),
      method: cleanText(item.method, `mealOverrides.${id}.method`, 500),
      tag: cleanText(item.tag, `mealOverrides.${id}.tag`, 80),
      updatedAt: optionalTimestamp(item.updatedAt, `mealOverrides.${id}.updatedAt`),
    }]
  }))
}

function sanitizeReminders(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) fail('customReminders must be an array')
  if (raw.length > 50) fail('customReminders has too many items')
  const ids = new Set()
  return raw.map((item, index) => {
    if (!isObject(item)) fail(`customReminders[${index}] must be an object`)
    const id = cleanText(item.id, `customReminders[${index}].id`, 100, { required: true })
    if (ids.has(id)) fail('customReminders contains duplicate IDs')
    ids.add(id)
    return {
      id,
      text: cleanText(item.text, `customReminders[${index}].text`, 80, { required: true }),
      done: Boolean(item.done),
    }
  })
}

function sanitizeHistory(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) fail('planHistory must be an array')
  if (raw.length > MAX_HISTORY) fail(`planHistory exceeds ${MAX_HISTORY} plans`, 'STATE_HISTORY_LIMIT')
  const result = []
  const ids = new Set()
  raw.forEach((plan, index) => {
    const clean = sanitizePlan(plan, `planHistory[${index}]`)
    if (ids.has(clean.id)) fail('planHistory contains duplicate plan IDs')
    ids.add(clean.id)
    result.push(clean)
  })
  return result
}

function sanitizeState(raw, options = {}) {
  const value = isObject(raw) ? raw : {}
  const base = defaults()
  const result = {}
  const checkedShoppingIds = uniqueTextArray(value.checkedShoppingIds, 'checkedShoppingIds', {
    maxItems: MAX_CHECKED_SHOPPING_IDS, maxLength: 120,
  })
  const activePlan = value.activePlan === undefined || value.activePlan === null
    ? null
    : sanitizePlan(value.activePlan, 'activePlan')
  const draftPlan = value.draftPlan === undefined || value.draftPlan === null
    ? null
    : sanitizePlan(value.draftPlan, 'draftPlan')
  const planHistory = sanitizeHistory(value.planHistory)
  const plans = [activePlan, draftPlan, ...planHistory]
  const activePlanId = activePlan ? activePlan.id : cleanText(value.activePlanId, 'activePlanId', 120)
  const planUiStateByPlan = sanitizePlanUiStateByPlan(value.planUiStateByPlan, plans)
  if (activePlan) {
    planUiStateByPlan[activePlan.id] = sanitizePlanUiState({
      selectedDayId: value.selectedDayId,
      selectedDay: value.selectedDay,
      defaultDinnerMode: value.defaultDinnerMode === 'workout' || value.dinnerMode === 'workout' ? 'workout' : 'rest',
      dinnerModeByDay: value.dinnerModeByDay,
      checkedShoppingIds,
    }, activePlan, `planUiStateByPlan.${activePlan.id}`)
  }
  const activeUi = activePlan ? planUiStateByPlan[activePlan.id] : {
    selectedDayId: cleanText(value.selectedDayId, 'selectedDayId', 120),
    selectedDay: finiteInteger(value.selectedDay, 'selectedDay', 0, 31, base.selectedDay),
    defaultDinnerMode: value.defaultDinnerMode === 'workout' || value.dinnerMode === 'workout' ? 'workout' : 'rest',
    dinnerModeByDay: sanitizeModes(value.dinnerModeByDay),
    checkedShoppingIds,
  }
  const mealOverrides = sanitizeMealOverrides(value.mealOverrides, plans)
  Object.assign(result, {
    schemaVersion: CURRENT_SCHEMA,
    stateRevision: finiteInteger(value.stateRevision, 'stateRevision', 0, Number.MAX_SAFE_INTEGER - 1, 0),
    activePlan,
    draftPlan,
    planHistory,
    generationPreferences: sanitizeGenerationPreferences(value.generationPreferences),
    activePlanId,
    selectedDayId: activeUi.selectedDayId,
    selectedDay: activeUi.selectedDay,
    defaultDinnerMode: activeUi.defaultDinnerMode,
    dinnerModeByDay: activeUi.dinnerModeByDay,
    planUiStateByPlan,
    mealOverrides,
    checkedShoppingIds: activeUi.checkedShoppingIds,
    customReminders: sanitizeReminders(value.customReminders),
    settings: {
      calciumAnchorReminder: isObject(value.settings) && value.settings.calciumAnchorReminder === true,
      vitaminDReminder: isObject(value.settings) && value.settings.vitaminDReminder === true,
    },
  })
  const trusted = isObject(options.preserveUnknownFrom) ? options.preserveUnknownFrom : null
  const finalState = trusted ? mergeTrustedUnknown(result, trusted) : result
  assertStateSize(finalState)
  return finalState
}

function migrate(raw = {}, options = {}) {
  const value = isObject(raw) ? raw : {}
  const sourceSchema = finiteInteger(value.schemaVersion, 'schemaVersion', 0, 1000000, 0)
  if (sourceSchema > CURRENT_SCHEMA) {
    fail('User state was created by a newer app version; update before continuing', 'STATE_SCHEMA_UNSUPPORTED')
  }
  const candidate = { ...value, schemaVersion: CURRENT_SCHEMA }
  if (sourceSchema < CURRENT_SCHEMA) {
    const legacyPreferences = isObject(value.generationPreferences) ? value.generationPreferences : {}
    candidate.generationPreferences = {
      ...legacyPreferences,
      contractVersion: CURRENT_AI_CONTRACT,
    }
    const activePlanId = isObject(value.activePlan) && typeof value.activePlan.id === 'string'
      ? value.activePlan.id : ''
    const savedActiveUi = activePlanId && isObject(value.planUiStateByPlan)
      ? value.planUiStateByPlan[activePlanId] : null
    if (isObject(savedActiveUi)) {
      candidate.selectedDayId = savedActiveUi.selectedDayId
      candidate.selectedDay = savedActiveUi.selectedDay
      candidate.defaultDinnerMode = savedActiveUi.defaultDinnerMode
      candidate.dinnerModeByDay = savedActiveUi.dinnerModeByDay
      candidate.checkedShoppingIds = savedActiveUi.checkedShoppingIds
    }
  }
  if (sourceSchema >= 1 && sourceSchema < 5) {
    const legacySettings = isObject(value.settings) ? value.settings : {}
    candidate.settings = {
      calciumAnchorReminder: legacySettings.calciumAnchorReminder !== false,
      vitaminDReminder: legacySettings.vitaminDReminder !== false,
    }
  }
  if (sourceSchema < CURRENT_SCHEMA && !candidate.activePlan && options.legacyPlan) {
    candidate.activePlan = convertLegacyPlan(options.legacyPlan, options.legacyShoppingGroups)
    candidate.activePlanId = candidate.activePlan.id
  }
  const preserveUnknownFrom = isObject(options.preserveUnknownFrom) ? options.preserveUnknownFrom : null
  return sanitizeState(candidate, { preserveUnknownFrom })
}

function prependHistory(history, plan, excludedId) {
  const result = []
  const ids = new Set(excludedId ? [excludedId] : [])
  if (plan && !ids.has(plan.id)) {
    result.push(plan)
    ids.add(plan.id)
  }
  history.forEach((item) => {
    if (ids.has(item.id)) return
    result.push(item)
    ids.add(item.id)
  })
  if (result.length > MAX_HISTORY) fail(`planHistory exceeds ${MAX_HISTORY} plans`, 'STATE_HISTORY_LIMIT')
  return result
}

function activatePlanUiState(state, plan) {
  const saved = state.planUiStateByPlan[plan.id]
  const next = sanitizePlanUiState(saved || {}, plan, `planUiStateByPlan.${plan.id}`)
  return {
    planUiStateByPlan: { ...state.planUiStateByPlan, [plan.id]: next },
    selectedDayId: next.selectedDayId,
    selectedDay: next.selectedDay,
    defaultDinnerMode: next.defaultDinnerMode,
    dinnerModeByDay: next.dinnerModeByDay,
    checkedShoppingIds: next.checkedShoppingIds,
  }
}

function assertRevision(state, expectedStateRevision) {
  if (!Number.isSafeInteger(expectedStateRevision) || expectedStateRevision < 0) {
    fail('expectedStateRevision is required', 'INVALID_STATE_REVISION')
  }
  if (state.stateRevision !== expectedStateRevision) {
    const error = new Error('User state changed on another device; reload before saving')
    error.code = 'STATE_REVISION_CONFLICT'
    error.currentStateRevision = state.stateRevision
    throw error
  }
}

function confirmDraft(raw, expectedStateRevision) {
  const state = sanitizeState(raw, { preserveUnknownFrom: raw })
  assertRevision(state, expectedStateRevision)
  if (!state.draftPlan) fail('There is no draft plan to confirm', 'DRAFT_NOT_FOUND')
  const activePlan = state.draftPlan
  const activeUi = activatePlanUiState(state, activePlan)
  const candidate = {
    ...state,
    stateRevision: state.stateRevision + 1,
    activePlan,
    draftPlan: null,
    planHistory: prependHistory(state.planHistory, state.activePlan, activePlan.id),
    activePlanId: activePlan.id,
    ...activeUi,
  }
  return sanitizeState(candidate, { preserveUnknownFrom: candidate })
}

function restoreHistory(raw, historyPlanId, expectedStateRevision) {
  const state = sanitizeState(raw, { preserveUnknownFrom: raw })
  assertRevision(state, expectedStateRevision)
  const planId = cleanText(historyPlanId, 'historyPlanId', 120, { required: true })
  const restored = state.planHistory.find((plan) => plan.id === planId)
  if (!restored) fail('The requested history plan does not exist', 'HISTORY_PLAN_NOT_FOUND')
  const remaining = state.planHistory.filter((plan) => plan.id !== planId)
  const activeUi = activatePlanUiState(state, restored)
  const candidate = {
    ...state,
    stateRevision: state.stateRevision + 1,
    activePlan: restored,
    planHistory: prependHistory(remaining, state.activePlan, restored.id),
    activePlanId: restored.id,
    ...activeUi,
  }
  return sanitizeState(candidate, { preserveUnknownFrom: candidate })
}

module.exports = {
  CURRENT_SCHEMA,
  CURRENT_AI_CONTRACT,
  MAX_HISTORY,
  MAX_MEAL_OVERRIDES,
  defaults,
  migrate,
  sanitizeState,
  sanitizePlan,
  sanitizeGenerationPreferences,
  confirmDraft,
  restoreHistory,
}
