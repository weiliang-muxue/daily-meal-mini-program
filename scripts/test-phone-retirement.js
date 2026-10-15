'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const { RETIRED_PHONE_FIELDS, withoutPhoneData, purgeRetiredPhoneCaches } = require('../miniprogram/services/retired-phone-data')
const a = 'a'.repeat(32), b = 'b'.repeat(32)
const old = { nickname: '合成昵称', avatarUrl: 'synthetic-avatar', createdAt: 10,
  ...Object.fromEntries(RETIRED_PHONE_FIELDS.map(field => [field, 'synthetic-legacy-value'])) }
const clean = { nickname: old.nickname, avatarUrl: old.avatarUrl, createdAt: 10 }
assert.deepEqual(withoutPhoneData(old), clean)
assert.notDeepEqual(old, clean, '不修改传入对象或其他请求持有的快照')
assert.equal(withoutPhoneData(clean), clean)
assert.equal(withoutPhoneData(null), null)
const records = new Map([
  ['meal_auth_profile_v1_' + a, old], ['meal_auth_profile_v1_' + b, old],
  ['meal_auth_profile_v1', old], ['meal_membership_v1', old],
  ['meal_user_state_v3_' + a, { meals: ['preserved'] }],
  ['meal_health_month_v1_' + a + '_2026-10', { records: ['preserved'] }],
])
const storage = {
  getStorageInfoSync: () => ({ keys: [...records.keys()] }),
  getStorageSync: key => records.get(key),
  setStorageSync: (key, value) => records.set(key, value),
  removeStorageSync: key => records.delete(key),
}
purgeRetiredPhoneCaches(storage)
for (const key of ['meal_auth_profile_v1_' + a, 'meal_auth_profile_v1_' + b]) assert.deepEqual(records.get(key), clean)
assert(!records.has('meal_membership_v1') && !records.has('meal_auth_profile_v1'))
assert.deepEqual(records.get('meal_user_state_v3_' + a), { meals: ['preserved'] })
assert.deepEqual(records.get('meal_health_month_v1_' + a + '_2026-10'), { records: ['preserved'] })
const first = [...records]
purgeRetiredPhoneCaches(storage)
assert.deepEqual([...records], first, '重复清理必须幂等')
records.set('meal_auth_profile_v1_' + a, old)
purgeRetiredPhoneCaches({ ...storage, setStorageSync() { throw Error('synthetic disk failure') } })
assert(!records.has('meal_auth_profile_v1_' + a), '写缓存失败仅移除该资料缓存，不清除餐单/健康记录')

global.wx = { getStorageSync() {} }
let page
global.Page = value => { page = value }
require('../miniprogram/pages/profile/profile')
const { authStore } = require('../miniprogram/services/auth-store')
const { membershipStore } = require('../miniprogram/services/membership-store')
assert.equal(authStore.bindPhoneNumber, undefined)
assert.equal(membershipStore.setPhoneVisibility, undefined)
for (const handler of ['onGetPhoneNumber', 'onPhoneNumberError', 'changePhoneVisibility']) assert.equal(page[handler], undefined)
for (const handler of ['onChooseAvatar', 'onNicknameInput', 'saveProfile', 'saveMemberNote']) assert.equal(typeof page[handler], 'function')
const wxml = fs.readFileSync(require.resolve('../miniprogram/pages/profile/profile.wxml'), 'utf8')
assert(!/getPhoneNumber|phoneVisibility|手机尾号|绑定手机号/.test(wxml))
assert(wxml.includes('type="nickname"') && wxml.includes('open-type="chooseAvatar"'))
assert(wxml.includes('profileSaveError'), '移除手机号不能误删头像昵称保存失败反馈')
console.log('phone retirement, cache erasure, and retained identity controls passed')
