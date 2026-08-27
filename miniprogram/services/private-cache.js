'use strict'

const EXACT_PREFIXES = [
  'meal_auth_profile_v1_',
    'meal_user_state_v3_',
    'meal_user_pending_v1_',
  'meal_ai_task_v1_',
]
const MONTH_PREFIX = 'meal_health_month_v1_'

function validNamespace(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
}

function privateCacheKeys(namespace, allKeys) {
  if (!validNamespace(namespace)) return []
  const exact = new Set(EXACT_PREFIXES.map((prefix) => `${prefix}${namespace}`))
  const monthPrefix = `${MONTH_PREFIX}${namespace}_`
  return (Array.isArray(allKeys) ? allKeys : []).filter((key) => (
    typeof key === 'string' && (exact.has(key) || key.startsWith(monthPrefix))
  ))
}

function clearPrivateCache(namespace, storageInfo) {
  const keys = privateCacheKeys(namespace, storageInfo && storageInfo.keys)
  keys.forEach((key) => wx.removeStorageSync(key))
  return keys
}

module.exports = { privateCacheKeys, clearPrivateCache }
