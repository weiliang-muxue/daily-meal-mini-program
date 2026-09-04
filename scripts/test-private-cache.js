'use strict'

const assert = require('assert')

const removed = []
global.wx = { removeStorageSync(key) { removed.push(key) } }

const {
  privateCacheKeys, stalePrivateCacheKeys, clearPrivateCache, reconcilePrivateCaches,
} = require('../miniprogram/services/private-cache')
const namespace = 'a'.repeat(32)
const other = 'b'.repeat(32)
const keys = [
  'meal_membership_v1',
  'meal_auth_profile_v1',
  'meal_user_state_v2',
  'meal_health_month_v1_2026-08',
  `meal_auth_profile_v1_${namespace}`,
  `meal_user_state_v3_${namespace}`,
  `meal_user_pending_v1_${namespace}`,
  `meal_ai_task_v1_${namespace}`,
  `meal_ai_task_v2_${namespace}`,
  `meal_health_month_v1_${namespace}_2026-08`,
  `meal_health_month_v1_${namespace}_2026-09`,
  `meal_auth_profile_v1_${other}`,
  `meal_user_state_v3_${other}`,
  `meal_health_month_v1_${other}_2026-08`,
  'meal_health_month_v1_invalid-month',
  `meal_auth_profile_v1_${'Z'.repeat(32)}`,
  'unrelated-setting',
]

const currentAndLegacy = keys.slice(0, 11)
assert.deepStrictEqual(privateCacheKeys(namespace, keys), currentAndLegacy)
assert.deepStrictEqual(privateCacheKeys('', keys), [])
assert.deepStrictEqual(clearPrivateCache(namespace, { keys }), currentAndLegacy)
assert.deepStrictEqual(removed, currentAndLegacy)

removed.length = 0
const stale = [keys[0], keys[1], keys[2], keys[3], keys[11], keys[12], keys[13]]
assert.deepStrictEqual(stalePrivateCacheKeys(namespace, keys), stale)
assert.deepStrictEqual(reconcilePrivateCaches(namespace, { keys }), stale)
assert.deepStrictEqual(removed, stale)

const failures = []
assert.doesNotThrow(() => clearPrivateCache(namespace, null, {
  getStorageInfoSync() { throw new Error('storage enumeration failed') },
  removeStorageSync() { failures.push('unexpected') },
}))
assert.deepStrictEqual(failures, [])

assert.doesNotThrow(() => reconcilePrivateCaches(namespace, { keys: stale }, {
  removeStorageSync(key) {
    failures.push(key)
    if (key === stale[1]) throw new Error('single-key delete failed')
  },
}))
assert.deepStrictEqual(failures, stale, '单键删除失败不能阻止后续私密键继续清理')

console.log('private cache tests passed')
