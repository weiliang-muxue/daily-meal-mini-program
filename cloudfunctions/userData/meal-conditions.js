'use strict'

// Original, pure calculation rules for the upcoming cooking-condition contract.
// No network, storage, account identifiers, implicit unit conversion or stock writes.
const MAX_SERVINGS = 12
const MIN_COOKING_MINUTES = 5
const MAX_COOKING_MINUTES = 180
const MAX_PANTRY_ITEMS = 30
const MAX_QUANTITY = 100000
// A plan can aggregate 14 days × 5 variants × 30 ingredients. A purchase
// total is not an individual ingredient input and may legitimately be larger.
const MAX_REQUIRED_QUANTITY = MAX_QUANTITY * 14 * 5 * 30
const UNITS = Object.freeze(['g', 'kg', 'ml', 'L', '个', '颗', '枚', '片', '根', '把', '盒', '袋', '瓶', '罐', '份', '勺', '茶匙', '汤匙'])
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
function fail(message) { const error = new Error(message); error.code = 'MEAL_CONDITIONS_INVALID'; throw error }
function cleanText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${label}不完整或过长`)
  return value.trim()
}
function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label}需为 ${min}–${max} 的整数`)
  return value
}
function quantityTicks(value, label, allowZero = false, max = MAX_QUANTITY) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < (allowZero ? 0 : 0.001) || value > max) {
    fail(`${label}需为 ${allowZero ? 0 : 0.001}–${max} 的数字`)
  }
  const ticks = Math.round(value * 1000)
  if (Math.abs(value * 1000 - ticks) > 0.000001) fail(`${label}最多保留三位小数`)
  return ticks
}
function nameIdentity(name) {
  const value = cleanText(name, '食材名称', 50)
  return (typeof value.normalize === 'function' ? value.normalize('NFKC') : value).toLowerCase().replace(/\s/gu, '')
}
function unit(value) {
  const cleaned = cleanText(value, '食材单位', 12)
  if (!UNITS.includes(cleaned)) fail('请选择支持的食材单位，不自动换算单位')
  return cleaned
}
function pantryKey(item) { return JSON.stringify([nameIdentity(item.name), unit(item.unit)]) }
function normalizePantry(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_PANTRY_ITEMS) fail(`已有食材最多 ${MAX_PANTRY_ITEMS} 项`)
  const seen = new Set()
  return raw.map(item => {
    if (!object(item) || Object.keys(item).some(key => !['name', 'quantity', 'unit'].includes(key))) fail('已有食材只接受名称、数量和单位')
    const result = { name: cleanText(item.name, '食材名称', 50), quantity: quantityTicks(item.quantity, '已有数量') / 1000, unit: unit(item.unit) }
    const key = pantryKey(result)
    if (seen.has(key)) fail('同名、同单位的已有食材不能重复，请合并数量')
    seen.add(key)
    return result
  })
}
function normalizeConditions(raw, options = {}) {
  if (!object(raw)) fail('就餐与做饭条件必须为对象')
  const required = options.required === true
  for (const field of ['servings', 'maxCookingMinutes', 'pantryItems']) {
    if (required && raw[field] === undefined) fail('请重新确认就餐人数、做饭时间和已有食材')
  }
  return {
    servings: integer(raw.servings === undefined ? 1 : raw.servings, '就餐人数', 1, MAX_SERVINGS),
    maxCookingMinutes: integer(raw.maxCookingMinutes === undefined ? 30 : raw.maxCookingMinutes, '做饭时间', MIN_COOKING_MINUTES, MAX_COOKING_MINUTES),
    pantryItems: normalizePantry(raw.pantryItems === undefined ? [] : raw.pantryItems),
  }
}
function storedConditions(raw) {
  if (!object(raw) || !['servings', 'maxCookingMinutes', 'pantryItems'].some(key => raw[key] !== undefined)) return {}
  return normalizeConditions(raw, { required: true })
}
function storedMealConditions(raw, options = {}) {
  if (!object(raw) || !['servings', 'quantityBasis', 'estimatedCookingMinutes'].some(key => raw[key] !== undefined)) return {}
  if (raw.quantityBasis !== 'total') fail('保存的食材必须为总份量，不能把单人份再次放大')
  return { servings: integer(raw.servings, '就餐人数', 1, MAX_SERVINGS), quantityBasis: 'total',
    estimatedCookingMinutes: options.allowUnknownTime && raw.estimatedCookingMinutes === null ? null
      : integer(raw.estimatedCookingMinutes, '预计总做饭时间', 1, MAX_COOKING_MINUTES) }
}
function normalizePerPersonMeal(raw, rawConditions) {
  const conditions = normalizeConditions(rawConditions, { required: true })
  if (!object(raw) || raw.quantityBasis !== 'per-person') fail('生成食材必须明确为单人份，不能再次放大总份量')
  if (raw.servings !== undefined && raw.servings !== 1) fail('单人份原始食材不能携带多人份数')
  const estimatedCookingMinutes = integer(raw.estimatedCookingMinutes, '预计总做饭时间', 1, conditions.maxCookingMinutes)
  if (!Array.isArray(raw.ingredients) || raw.ingredients.length < 1 || raw.ingredients.length > 30) fail('每餐需有 1–30 项食材')
  const ingredients = raw.ingredients.map(item => {
    if (!object(item)) fail('生成食材不完整')
    const ticks = quantityTicks(item.quantity, '单人用量')
    return { name: cleanText(item.name, '食材名称', 50), quantity: ticks / 1000,
      unit: unit(item.unit), category: cleanText(item.category, '食材分类', 20) }
  })
  return { ...raw, ingredients, servings: 1, quantityBasis: 'per-person', estimatedCookingMinutes }
}
function scalePerPersonMeal(raw, rawConditions) {
  const conditions = normalizeConditions(rawConditions, { required: true })
  const one = normalizePerPersonMeal(raw, conditions)
  const ingredients = one.ingredients.map(item => {
    const totalTicks = quantityTicks(item.quantity, '单人用量') * conditions.servings
    if (totalTicks > MAX_QUANTITY * 1000) fail('多人总用量超过安全范围，请减少人数或调整食材')
    return { ...item, quantity: totalTicks / 1000 }
  })
  // Only final assembly scales ingredients; the time estimate already covers
  // the full cooking session. Stored total portions cannot enter this path again.
  return { ...one, ingredients, servings: conditions.servings, quantityBasis: 'total' }
}

function applyPantry(groups, rawPantry) {
  const pantry = normalizePantry(rawPantry)
  if (!Array.isArray(groups)) fail('采购需求必须为分组数组')
  if (groups.length > 12) fail('采购分类最多 12 组')
  const available = new Map(pantry.map(item => [pantryKey(item), quantityTicks(item.quantity, '已有数量')]))
  const rows = [], groupIds = new Set(), itemIds = new Set()
  groups.forEach((group, groupIndex) => {
    if (!object(group) || !Array.isArray(group.items)) fail('采购分组不完整')
    if (group.items.length > 40) fail('每组采购食材最多 40 项')
    const groupId = cleanText(group.id, '采购分组标识', 120)
    if (groupIds.has(groupId)) fail('采购分组标识重复')
    groupIds.add(groupId)
    group.items.forEach((item, itemIndex) => {
      if (!object(item)) fail('采购项不完整')
      const id = cleanText(item.id, '采购项标识', 120)
      if (itemIds.has(id)) fail('采购项标识重复')
      itemIds.add(id)
      // Existing personal edits may use a custom unit. It remains a distinct
      // purchase item; it must not break an otherwise valid stock projection.
      const key = JSON.stringify([nameIdentity(item.name), cleanText(item.unit, '食材单位', 12)])
      rows.push({ item, groupIndex, itemIndex, groupId, id, key, required: quantityTicks(item.quantity, '餐单总需求', false, MAX_REQUIRED_QUANTITY) })
    })
  })
  // A stock item can cover more than one category, but is spent only once.
  // Stable IDs break ties so reordering groups/items cannot shift the allocation.
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
  const allocation = new Map()
  rows.slice().sort((a, b) => compare(a.key, b.key) || compare(a.groupId, b.groupId) || compare(a.id, b.id)).forEach(row => {
    const stock = available.get(row.key) || 0
    const used = Math.min(stock, row.required), remaining = row.required - used
    available.set(row.key, stock - used)
    allocation.set(row.id, { ...row.item, requiredQuantity: row.required / 1000, pantryQuantity: used / 1000,
      quantity: remaining / 1000, amount: `${remaining / 1000} ${cleanText(row.item.unit, '食材单位', 12)}` })
  })
  const project = covered => groups.map(group => ({ ...group,
    items: group.items.map(item => allocation.get(item.id)).filter(item => covered ? item.quantity === 0 : item.quantity > 0),
  })).filter(group => group.items.length)
  return { groups: project(false), coveredGroups: project(true),
    unusedPantry: pantry.map(item => ({ ...item, quantity: (available.get(pantryKey(item)) || 0) / 1000 })).filter(item => item.quantity > 0) }
}

module.exports = { MAX_SERVINGS, MIN_COOKING_MINUTES, MAX_COOKING_MINUTES, MAX_PANTRY_ITEMS, MAX_QUANTITY, MAX_REQUIRED_QUANTITY,
  UNITS, normalizeConditions, normalizePantry, storedConditions, storedMealConditions, pantryKey, normalizePerPersonMeal, scalePerPersonMeal, applyPantry }
