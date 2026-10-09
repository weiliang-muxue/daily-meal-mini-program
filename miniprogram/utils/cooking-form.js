'use strict'

const { normalizeConditions, normalizePantry, pantryKey, UNITS, MAX_PANTRY_ITEMS } = require('../services/meal-conditions')

function fromPreferences(preferences, previousRows = []) {
  const value = normalizeConditions(preferences)
  return {
    servings: String(value.servings), maxCookingMinutes: String(value.maxCookingMinutes),
    rows: value.pantryItems.map((item, index) => ({ id: previousRows.length === value.pantryItems.length ? previousRows[index].id : `saved-${index}`, name: item.name,
      quantity: String(item.quantity), unit: item.unit })),
  }
}

// Keep unfinished text separate from the last valid, persisted preferences.
function validate(draft) {
  const errors = { servings: '', maxCookingMinutes: '', rows: {} }
  for (const [key, min, max, label] of [
    ['servings', 1, 12, '就餐人数'], ['maxCookingMinutes', 5, 180, '每餐做饭时间'],
  ]) {
    const raw = String(draft[key] || '').trim()
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) errors[key] = `${label}请输入 ${min}–${max} 的整数`
  }
  let message = errors.servings || errors.maxCookingMinutes
  const seen = new Set()
  const pantryItems = []
  const rows = Array.isArray(draft.rows) ? draft.rows : []
  if (!Array.isArray(draft.rows) || rows.length > MAX_PANTRY_ITEMS) message = message || '已有食材最多 30 项'
  rows.forEach((row, index) => {
    try {
      const raw = String(row.quantity || '').trim()
      if (!/^\d+(?:\.\d{1,3})?$/.test(raw)) throw new Error('数量请输入正数，最多三位小数')
      const item = normalizePantry([{ name: row.name, quantity: Number(raw), unit: row.unit }])[0]
      const key = pantryKey(item)
      if (seen.has(key)) throw new Error('同名、同单位的食材已填写，请合并数量')
      seen.add(key)
      pantryItems.push(item)
    } catch (error) {
      errors.rows[row.id] = error.message
      message = message || `第 ${index + 1} 项已有食材：${error.message}`
    }
  })
  return { errors, message, value: message ? null : normalizeConditions({
    servings: Number(draft.servings), maxCookingMinutes: Number(draft.maxCookingMinutes), pantryItems,
  }, { required: true }) }
}

function view(draft, errors = {}) {
  return { servingsInput: draft.servings, cookingMinutesInput: draft.maxCookingMinutes,
    servingsError: errors.servings || '', cookingMinutesError: errors.maxCookingMinutes || '',
    pantryRows: draft.rows.map(row => ({ ...row, unitIndex: UNITS.indexOf(row.unit), error: (errors.rows || {})[row.id] || '' })) }
}

module.exports = { fromPreferences, validate, view, UNITS, MAX_PANTRY_ITEMS }
