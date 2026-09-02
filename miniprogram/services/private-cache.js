'use strict'

const EXACT_PREFIXES = [
  'meal_auth_profile_v1_',
  'meal_user_state_v3_',
  'meal_user_pending_v1_',
  'meal_ai_task_v1_',
  'meal_ai_task_v2_',
]
const MONTH_PREFIX = 'meal_health_month_v1_'
const LEGACY_EXACT_KEYS = new Set([
  'meal_membership_v1',
  'meal_auth_profile_v1',
  'meal_user_state_v2',
])
const LEGACY_HEALTH_PATTERN = /^meal_health_month_v1_\d{4}-(?:0[1-9]|1[0-2])$/

function validNamespace(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
}

function legacyPrivateCacheKey(key) {
  return typeof key === 'string'
    && (LEGACY_EXACT_KEYS.has(key) || LEGACY_HEALTH_PATTERN.test(key))
}

function privateCacheNamespace(key) {
  if (typeof key !== 'string') return ''
  for (const prefix of EXACT_PREFIXES) {
    const match = new RegExp(`^${prefix}([a-f0-9]{32})$`).exec(key)
    if (match) return match[1]
  }
  const health = /^meal_health_month_v1_([a-f0-9]{32})_/.exec(key)
  return health ? health[1] : ''
}

function privateCacheKeys(namespace, allKeys) {
  if (!validNamespace(namespace)) return []
  const exact = new Set(EXACT_PREFIXES.map((prefix) => `${prefix}${namespace}`))
  const monthPrefix = `${MONTH_PREFIX}${namespace}_`
  return (Array.isArray(allKeys) ? allKeys : []).filter((key) => (
    typeof key === 'string'
      && (legacyPrivateCacheKey(key) || exact.has(key) || key.startsWith(monthPrefix))
  ))
}

function stalePrivateCacheKeys(currentNamespace, allKeys) {
  const keep = validNamespace(currentNamespace) ? currentNamespace : ''
  return (Array.isArray(allKeys) ? allKeys : []).filter((key) => {
    if (legacyPrivateCacheKey(key)) return true
    const namespace = privateCacheNamespace(key)
    return Boolean(namespace) && namespace !== keep
  })
}

function storageKeys(storageApi, storageInfo) {
  if (storageInfo && Array.isArray(storageInfo.keys)) return storageInfo.keys
  try {
    const info = storageApi && typeof storageApi.getStorageInfoSync === 'function'
      ? storageApi.getStorageInfoSync() : null
    return info && Array.isArray(info.keys) ? info.keys : []
  } catch (_) { return [] }
}

function removeKeysBestEffort(keys, storageApi) {
  if (!storageApi || typeof storageApi.removeStorageSync !== 'function') return
  keys.forEach((key) => {
    try { storageApi.removeStorageSync(key) } catch (_) {}
  })
}

function clearPrivateCache(namespace, storageInfo, storageApi = wx) {
  const keys = privateCacheKeys(namespace, storageKeys(storageApi, storageInfo))
  removeKeysBestEffort(keys, storageApi)
  return keys
}

function reconcilePrivateCaches(currentNamespace, storageInfo, storageApi = wx) {
  const keys = stalePrivateCacheKeys(currentNamespace, storageKeys(storageApi, storageInfo))
  removeKeysBestEffort(keys, storageApi)
  return keys
}

module.exports = {
  privateCacheKeys, stalePrivateCacheKeys, clearPrivateCache, reconcilePrivateCaches,
}
