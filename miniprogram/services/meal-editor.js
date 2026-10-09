'use strict'
const { shoppingView } = require('./plan-view')
const { reconcileChecks, shoppingIds } = require('./meal-shopping')
const { storedMealConditions } = require('./meal-conditions')
const FIELDS = ['name', 'quantity', 'unit', 'category']
function rowSnapshot(rows = []) { return JSON.stringify(rows.map(row => FIELDS.map(field => String(row[field] === undefined ? '' : row[field]).trim()))) }
function cleanRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 30) throw new Error('请保留 1–30 项食材')
  return rows.map((row, index) => {
    const result = {}
    for (const [key, max] of [['name', 50], ['unit', 12], ['category', 20]]) {
      const value = typeof row[key] === 'string' ? row[key].trim() : ''
      if (!value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`第 ${index + 1} 项食材的名称、单位或分类不完整`)
      result[key] = value
    }
    const quantityText = String(row.quantity).trim()
    if (!/^\d+(?:\.\d{1,3})?$/.test(quantityText) || Number(quantityText) <= 0 || Number(quantityText) > 100000) throw new Error(`第 ${index + 1} 项数量需为 0.001–100000，最多三位小数`)
    result.quantity = Number(quantityText)
    return result
  })
}
function rowsText(rows) { return rows.map(i => `${i.name} ${i.quantity} ${i.unit}`).join(' · ').slice(0, 500) }
function draftOverride(form, base, rows, baseRows, existing, rowsChanged) {
  const structured = rowsChanged || Boolean(existing && Array.isArray(existing.ingredientItems))
  const ingredients = structured ? cleanRows(rows) : null
  const normalized = ingredients ? { ...form, ingredients: rowsText(ingredients) } : form
  const unchangedText = ['title', 'ingredients', 'method', 'tag'].every(key => normalized[key] === base[key])
  const originalRows = !ingredients || rowSnapshot(ingredients) === rowSnapshot(baseRows)
  const source = existing && existing.quantityBasis ? existing : base
  const conditions = storedMealConditions(source, { allowUnknownTime: true })
  const metadataMatchesBase = JSON.stringify(conditions) === JSON.stringify(storedMealConditions(base, { allowUnknownTime: true }))
  if (unchangedText && originalRows && metadataMatchesBase) return null
  if (conditions.quantityBasis && (rowsChanged || normalized.method !== (existing && existing.method || base.method)
    || (!existing?.quantityBasis && (normalized.method !== base.method || !originalRows)))) {
    conditions.estimatedCookingMinutes = null // A manually changed recipe has no verified duration estimate.
  }
  return { ...normalized, ...conditions, ...(ingredients ? { ingredientItems: ingredients } : {}), updatedAt: new Date().toISOString() }
}
function previewChange(state, mealId, override) {
  const overrides = { ...state.mealOverrides }
  if (override === null) delete overrides[mealId]; else overrides[mealId] = override
  // Validate aggregate bounds before presenting a saveable preview.
  if (state.activePlan) shoppingIds(state.activePlan, overrides)
  const next = reconcileChecks(state, { ...state, mealOverrides: overrides })
  return shoppingChanges(state, next)
}
function shoppingChanges(state, next) {
  const flatten = value => shoppingView(value.activePlan, value).groups.flatMap(g => g.items.map(i => ({ ...i, category: g.name })))
  const before = flatten(state), after = flatten(next), changes = []
  const ids = new Set([...before.map(i => i.id), ...after.map(i => i.id)])
  ids.forEach(id => {
    const left = before.find(i => i.id === id), right = after.find(i => i.id === id)
    if (left && right && left.amount === right.amount && left.name === right.name) return
    changes.push({ id, name: (right || left).name, before: left ? left.amount : '无', after: right ? right.amount : '移除' })
  })
  return { changes, checkedReset: before.filter(i => i.checked && !(next.checkedShoppingIds || []).includes(i.id)).length }
}
module.exports = { rowSnapshot, cleanRows, rowsText, draftOverride, previewChange, shoppingChanges }
