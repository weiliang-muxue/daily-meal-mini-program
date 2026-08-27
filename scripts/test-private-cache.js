'use strict'

const assert = require('assert')

const removed = []
global.wx = { removeStorageSync(key) { removed.push(key) } }

const { privateCacheKeys, clearPrivateCache } = require('../miniprogram/services/private-cache')
const namespace = 'a'.repeat(32)
const other = 'b'.repeat(32)
const keys = [
  `meal_auth_profile_v1_${namespace}`,
  `meal_user_state_v3_${namespace}`,
  `meal_user_pending_v1_${namespace}`,
  `meal_ai_task_v1_${namespace}`,
  `meal_health_month_v1_${namespace}_2026-08`,
  `meal_health_month_v1_${namespace}_2026-09`,
  `meal_auth_profile_v1_${other}`,
  `meal_user_state_v3_${other}`,
  'unrelated-setting',
]

assert.deepStrictEqual(privateCacheKeys(namespace, keys), keys.slice(0, 6))
assert.deepStrictEqual(privateCacheKeys('', keys), [])
assert.deepStrictEqual(clearPrivateCache(namespace, { keys }), keys.slice(0, 6))
assert.deepStrictEqual(removed, keys.slice(0, 6))

console.log('private cache tests passed')
