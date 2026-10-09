'use strict'

// Private recipe snapshots; no AI transmission, account identifiers or network.
const conditions = require('./meal-conditions')
const shopping = require('./meal-shopping')
const replacement = require('./meal-replacement')
const MAX_FAVORITES = 30
const MAX_LIBRARY_BYTES = 128 * 1024
const copy = value => JSON.parse(JSON.stringify(value))
const object = value => value && typeof value === 'object' && !Array.isArray(value)
function fail(message, code = 'RECIPE_LIBRARY_INVALID') {
  const error = new Error(message); error.code = code; throw error
}
function text(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || (required && !value.trim())) fail('收藏内容无效，请重新选择餐食')
  return value.trim()
}
function ingredient(item) {
  if (!object(item) || typeof item.quantity !== 'number' || !Number.isFinite(item.quantity)
    || item.quantity < 0.001 || item.quantity > 100000
    || Math.abs(item.quantity * 1000 - Math.round(item.quantity * 1000)) > 0.000001) fail('收藏食材份量无效')
  return { name: text(item.name, 50, true), quantity: item.quantity, unit: text(item.unit, 12, true), category: text(item.category, 20, true) }
}
function sanitizeRecipe(raw) {
  if (!object(raw)) fail('收藏餐食无效')
  const result = {
    title: text(raw.title, 50, true), ingredients: text(raw.ingredients, 500),
    method: text(raw.method, 500), tag: text(raw.tag, 80),
    ...conditions.storedMealConditions(raw, { allowUnknownTime: true }),
  }
  if (raw.ingredientItems !== undefined) {
    if (!Array.isArray(raw.ingredientItems) || !raw.ingredientItems.length || raw.ingredientItems.length > 30) fail('收藏食材需要 1–30 项')
    result.ingredientItems = raw.ingredientItems.map(ingredient)
  }
  return result
}
function sanitizeFavorites(raw) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) fail('收藏列表无效')
  if (raw.length > MAX_FAVORITES) fail(`最多收藏 ${MAX_FAVORITES} 餐，请先移除不再需要的收藏`, 'RECIPE_LIBRARY_FULL')
  const ids = new Set()
  const result = raw.map(item => {
    if (!object(item) || typeof item.id !== 'string' || !/^fav_[a-f0-9]{32}$/.test(item.id) || ids.has(item.id)) fail('收藏标识无效')
    ids.add(item.id)
    if (typeof item.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.createdAt)
      || !Number.isFinite(Date.parse(item.createdAt)) || new Date(item.createdAt).toISOString() !== item.createdAt) fail('收藏时间无效')
    if (!['ai', 'legacy', 'personal'].includes(item.source)) fail('收藏来源无效')
    return { id: item.id, createdAt: item.createdAt, source: item.source, recipe: sanitizeRecipe(item.recipe) }
  })
  // UTF-8 upper bound, also available in the native runtime without Buffer.
  if (encodeURIComponent(JSON.stringify(result)).replace(/%[A-F\d]{2}/g, '_').length > MAX_LIBRARY_BYTES) fail('收藏容量已满，请先移除不再需要的收藏', 'RECIPE_LIBRARY_FULL')
  return result
}
function findMeal(state, mealId) {
  for (const day of (state.activePlan && state.activePlan.days || [])) {
    const meal = day.meals.find(item => item.id === mealId)
    if (meal) return meal
  }
  fail('这餐已变化，请返回餐单重新选择', 'RECIPE_LIBRARY_CONFLICT')
}
function rowsText(rows) { return rows.map(item => `${item.name} ${item.quantity} ${item.unit}`).join(' · ').slice(0, 500) }
function capture(state, mealId) {
  const meal = findMeal(state, mealId), override = (state.mealOverrides || {})[mealId] || {}
  const baseText = Array.isArray(meal.ingredients) ? rowsText(meal.ingredients) : meal.ingredients || ''
  const hasStructuredOverride = Array.isArray(override.ingredientItems)
  const textOnlyEdit = !hasStructuredOverride && override.ingredients && override.ingredients !== baseText
  const items = hasStructuredOverride ? override.ingredientItems : !textOnlyEdit && Array.isArray(meal.ingredients) ? meal.ingredients : null
  let metadata = conditions.storedMealConditions(override, { allowUnknownTime: true })
  if (!metadata.quantityBasis) {
    metadata = conditions.storedMealConditions(meal, { allowUnknownTime: true })
    if (metadata.quantityBasis && (hasStructuredOverride || textOnlyEdit || (override.method && override.method !== meal.method))) metadata.estimatedCookingMinutes = null
  }
  return sanitizeRecipe({
    title: override.title || meal.title, ingredients: items ? rowsText(items) : override.ingredients || baseText,
    method: override.method || meal.method || '', tag: override.tag || meal.tag || '',
    ...metadata, ...(items ? { ingredientItems: items } : {}),
  })
}
function add(state, mealId, id, now) {
  const recipe = capture(state, mealId), favorites = sanitizeFavorites(state.favoriteRecipes)
  if (favorites.some(item => JSON.stringify(item.recipe) === JSON.stringify(recipe))) return state
  return { ...state, favoriteRecipes: sanitizeFavorites([{ id, createdAt: now,
    source: ['ai', 'legacy'].includes(state.activePlan.source) ? state.activePlan.source : 'personal', recipe }, ...favorites]) }
}
function remove(state, id) {
  const favorites = sanitizeFavorites(state.favoriteRecipes)
  if (!favorites.some(item => item.id === id)) fail('这条收藏已变化，请刷新后重试', 'RECIPE_LIBRARY_CONFLICT')
  return { ...state, favoriteRecipes: favorites.filter(item => item.id !== id) }
}
function reusable(item) {
  return Boolean(item && item.recipe && Array.isArray(item.recipe.ingredientItems) && item.recipe.quantityBasis === 'total')
}
function proposal(state, id, target, now) {
  const favorite = sanitizeFavorites(state.favoriteRecipes).find(item => item.id === id)
  if (!favorite) fail('这条收藏已变化，请刷新后重试', 'RECIPE_LIBRARY_CONFLICT')
  if (!reusable(favorite)) fail('这条旧收藏缺少食材份量或人数，只可查看；请使用份量完整的餐食')
  if (target && target.dinnerMode) fail('收藏安排不切换晚餐模式，请先在餐单选择')
  const current = replacement.assertTargetCurrent(state, target)
  const override = { ...copy(favorite.recipe), updatedAt: now }
  const mealOverrides = { ...state.mealOverrides, [current.meal.id]: override }
  shopping.shoppingIds(state.activePlan, mealOverrides)
  return shopping.reconcileChecks(state, { ...state, mealOverrides })
}
module.exports = { MAX_FAVORITES, sanitizeFavorites, capture, add, remove, reusable, proposal }
