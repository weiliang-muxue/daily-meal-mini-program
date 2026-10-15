'use strict'

// The phone feature is retired. Strip legacy responses as well as offline
// profile caches, so an older server cannot reintroduce this data on a device.
const RETIRED_PHONE_FIELDS = Object.freeze([
  'phoneBound', 'maskedPhone', 'phoneBoundAt', 'phoneNumber', 'purePhoneNumber', 'countryCode',
  'phoneVisibilityConsent', 'phoneVisibilitySupported', 'phoneVisibilityEnabled', 'phoneVisibilityRevision',
  'phoneStatus', 'phoneText',
])

function withoutPhoneData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  if (!RETIRED_PHONE_FIELDS.some(field => Object.prototype.hasOwnProperty.call(value, field))) return value
  const result = { ...value }
  for (const field of RETIRED_PHONE_FIELDS) delete result[field]
  return result
}

function purgeRetiredPhoneCaches(storage = typeof wx === 'undefined' ? null : wx) {
  if (!storage || typeof storage.getStorageInfoSync !== 'function') return
  let keys
  try { keys = storage.getStorageInfoSync().keys || [] } catch (_) { return }
  for (const key of keys) {
    // These pre-identity global caches are already retired by private-cache;
    // never read or adopt them as the current member's profile.
    if (key === 'meal_membership_v1' || key === 'meal_auth_profile_v1') {
      try { storage.removeStorageSync(key) } catch (_) {}
      continue
    }
    if (!/^meal_auth_profile_v1_[a-f0-9]{32}$/.test(key)) continue
    try {
      const previous = storage.getStorageSync(key)
      if (previous && RETIRED_PHONE_FIELDS.some(field => Object.prototype.hasOwnProperty.call(previous, field))) {
        storage.setStorageSync(key, withoutPhoneData(previous))
      }
    } catch (_) {
      // Failed cache rewrites must not leave a retired private field behind.
      // Only this profile cache is discarded; meal and health caches are untouched.
      try { storage.removeStorageSync(key) } catch (_) {}
    }
  }
}

module.exports = { RETIRED_PHONE_FIELDS, withoutPhoneData, purgeRetiredPhoneCaches }
