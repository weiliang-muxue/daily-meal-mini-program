'use strict'

// Pure shared projection: no API, account data, storage or third-party code.
const text = value => typeof value === 'string' ? value.trim() : ''
const identity = value => {
  const source = text(value)
  return (typeof source.normalize === 'function' ? source.normalize('NFKC') : source).toLowerCase().replace(/\s/gu, '')
}
const keyOf = item => JSON.stringify([text(item.category), identity(item.name), text(item.unit)])
const round = value => Math.round(value * 1000) / 1000
const amount = item => `${round(item.quantity)} ${item.unit}`
function stableId(planId, key, kind = 'item') {
  // Not an authorization token. Collisions are checked by the projection below.
  const input = JSON.stringify([planId, kind, key]); let a = 2166136261, b = 3339675911
  for (let i = 0; i < input.length; i++) {
    a = Math.imul(a ^ input.charCodeAt(i), 16777619)
    b = Math.imul(b ^ input.charCodeAt(i), 2246822519)
  }
  return `personal-${kind}-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`
}
function ingredientsFor(meal, overrides = {}) {
  const override = overrides[meal.id || meal.mealId]
  return override && Array.isArray(override.ingredientItems) ? override.ingredientItems : meal.ingredients
}
function descriptors(plan) {
  return (plan.shoppingGroups || []).flatMap(group => (group.items || []).map(item => ({
    item, group, category: text(group.name), name: text(item.name),
    unit: text(item.unit) || (text(item.amount).match(/^\d+(?:\.\d+)?\s+(.+)$/u) || [])[1] || '',
  })))
}
function inventory(plan, meals, overrides = {}, allowNew = true) {
  if (!plan || !meals.length) return null
  const totals = new Map(), original = descriptors(plan)
  for (const meal of meals) {
    const items = ingredientsFor(meal, overrides)
    if (!Array.isArray(items) || !items.length) return null
    for (const item of items) {
      if (!item || !text(item.name) || !text(item.unit) || !text(item.category)
        || !Number.isFinite(item.quantity) || item.quantity <= 0) return null
      const key = keyOf(item), previous = totals.get(key)
      totals.set(key, { ...item, quantity: round((previous ? previous.quantity : 0) + item.quantity) })
    }
  }
  const groups = new Map(), ids = new Map(), groupIds = new Map()
  for (const [key, total] of totals) {
    const exact = original.find(d => keyOf(d) === key)
    const unspecified = original.filter(d => d.category === total.category && identity(d.name) === identity(total.name) && !d.unit)
    const match = exact || (unspecified.length === 1 ? unspecified[0] : null)
    if (!match && !allowNew) return null
    const id = match ? match.item.id : stableId(plan.id, key)
    if ((ids.has(id) && ids.get(id) !== key) || (!match && original.some(d => d.item.id === id))) {
      if (!allowNew) return null // An ambiguous legacy list keeps its original display.
      throw new Error('采购项标识冲突，请调整食材名称后重试')
    }
    ids.set(id, key)
    if (!groups.has(total.category)) {
      const originalGroup = (plan.shoppingGroups || []).find(g => g.name === total.category)
      const groupId = originalGroup ? originalGroup.id : stableId(plan.id, total.category, 'group')
      if ((groupIds.has(groupId) && groupIds.get(groupId) !== total.category)
        || (!originalGroup && (plan.shoppingGroups || []).some(g => g.id === groupId))) throw new Error('采购分类标识冲突，请调整分类后重试')
      groupIds.set(groupId, total.category)
      groups.set(total.category, { id: groupId, name: total.category, items: [] })
    }
    groups.get(total.category).items.push({ ...(match ? match.item : {}), id, name: total.name,
      quantity: total.quantity, unit: total.unit, amount: amount(total) })
  }
  const order = (plan.shoppingGroups || []).map(g => g.name)
  return [...groups.values()].sort((a, b) => {
    const ai = order.indexOf(a.name), bi = order.indexOf(b.name)
    return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi)
  }).map(group => ({ ...group, items: group.items.sort((a, b) => {
    const ai = original.findIndex(d => d.item.id === a.id), bi = original.findIndex(d => d.item.id === b.id)
    return (ai < 0 ? original.length : ai) - (bi < 0 ? original.length : bi)
  }) }))
}
function allMeals(plan) { return (plan && plan.days || []).flatMap(day => day.meals || []) }
function selectedDinnerMode(plan, day, dayIndex, state, dayId) {
  const byDay = state && state.dinnerModeByDay || {}
  if (Object.prototype.hasOwnProperty.call(byDay, dayId) && ['rest', 'workout'].includes(byDay[dayId])) return byDay[dayId]
  const exercise = day && day.exercise
  const rows = plan && plan.generationBasis && plan.generationBasis.exerciseByDay || []
  const meaningfulExercise = exercise && typeof exercise.planned === 'boolean'
    && (plan.source !== 'legacy' || rows.some(row => row && Number(row.dayIndex) === dayIndex)
      || exercise.planned === true || text(exercise.type) || Number(exercise.durationMinutes) > 0)
  if (meaningfulExercise) return exercise.planned ? 'workout' : 'rest'
  return plan.source === 'legacy' && state && state.defaultDinnerMode === 'workout' ? 'workout' : 'rest'
}
function selectedMeals(plan, state) {
  return (plan.days || []).flatMap((day, index) => {
    const meals = day.meals || []
    const alternatives = ['rest', 'workout'].every(scenario => meals.some(meal => meal.type === 'dinner' && meal.scenario === scenario))
    const mode = selectedDinnerMode(plan, day, index, state, day.id)
    return alternatives ? meals.filter(meal => meal.type !== 'dinner' || !meal.scenario || meal.scenario === 'default' || meal.scenario === mode) : meals
  })
}
function shoppingIds(plan, overrides = {}) {
  const ids = new Set(descriptors(plan).map(d => d.item.id))
  if (!allMeals(plan).some(meal => overrides[meal.id] && Array.isArray(overrides[meal.id].ingredientItems))) return ids
  const groups = inventory(plan, allMeals(plan), overrides)
  if (groups && (groups.length > 12 || groups.some(g => g.items.length > 40))) throw new Error('个人食材采购项过多，请减少分类或食材')
  if (groups) groups.forEach(g => g.items.forEach(i => ids.add(i.id)))
  return ids
}
function totalsFor(items) {
  const result = new Map()
  if (Array.isArray(items)) items.forEach(i => result.set(keyOf(i), round((result.get(keyOf(i)) || 0) + i.quantity)))
  return result
}
function changedKeys(plan, before = {}, after = {}) {
  const result = new Set()
  allMeals(plan).forEach(meal => {
    const left = totalsFor(ingredientsFor(meal, before)), right = totalsFor(ingredientsFor(meal, after))
    new Set([...left.keys(), ...right.keys()]).forEach(key => { if (left.get(key) !== right.get(key)) result.add(key) })
  })
  return result
}
function reconcileChecks(before, after) {
  const byPlan = { ...after.planUiStateByPlan }
  let activeChecked = after.checkedShoppingIds || []
  const plans = [after.activePlan, after.draftPlan, ...(after.planHistory || [])].filter(Boolean)
  for (const plan of plans) {
    const affected = changedKeys(plan, before.mealOverrides, after.mealOverrides)
    if (!affected.size) continue
    const entry = byPlan[plan.id]
    const meals = selectedMeals(plan, after.activePlan && plan.id === after.activePlan.id ? after : entry)
    const left = inventory(plan, meals, before.mealOverrides) || []
    const right = inventory(plan, meals, after.mealOverrides) || []
    const flatten = groups => groups.flatMap(g => g.items.map(i => ({ ...i, category: g.name })))
    const leftItems = flatten(left), rightItems = flatten(right)
    const leftTotals = totalsFor(leftItems), rightTotals = totalsFor(rightItems)
    const removed = new Set()
    ;[...leftItems, ...rightItems].forEach(item => {
      const key = keyOf(item)
      if (affected.has(key) && leftTotals.get(key) !== rightTotals.get(key)) removed.add(item.id)
    })
    if (entry) byPlan[plan.id] = { ...entry, checkedShoppingIds: (entry.checkedShoppingIds || []).filter(id => !removed.has(id)) }
    if (after.activePlan && plan.id === after.activePlan.id) activeChecked = activeChecked.filter(id => !removed.has(id))
  }
  return { ...after, planUiStateByPlan: byPlan, checkedShoppingIds: activeChecked }
}
module.exports = { identity, keyOf, inventory, ingredientsFor, allMeals, selectedDinnerMode, shoppingIds, reconcileChecks }
