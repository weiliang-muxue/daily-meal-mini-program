'use strict'

const assert = require('assert')
const path = require('path')
const root = path.resolve(__dirname, '..')
const cloudPath = path.join(root, 'miniprogram/utils/cloud.js')
const membershipPath = path.join(root, 'miniprogram/services/membership-store.js')
const { LEGAL_CONSENT_VERSION, hasCurrentLegalConsent, hasServiceLegalConsent, legalConsentPayload } = require('../miniprogram/utils/legal-consent')
const namespaceA = 'a'.repeat(32)
const namespaceB = 'b'.repeat(32)
const consent = { version: LEGAL_CONSENT_VERSION, privacyRead: true, agreementRead: true, accepted: true }
const active = { status: 'active', cacheNamespace: namespaceA }
const consented = { ...active, legalConsentVersion: LEGAL_CONSENT_VERSION, legalConsentAccepted: true }
let handler = async () => active
let calls = []
global.wx = { getStorageInfoSync: () => ({ keys: [] }), removeStorageSync() {} }
require.cache[cloudPath] = {
  id: cloudPath, filename: cloudPath, loaded: true,
  exports: {
    wxLogin: async () => ({}),
    callFunction(...args) { calls.push(args); return Promise.resolve().then(() => handler(...args)) },
  },
}
delete require.cache[membershipPath]
const { MembershipStore } = require(membershipPath)

async function testStrictProofAndRuntimeProjection() {
  assert.strictEqual(LEGAL_CONSENT_VERSION, 2)
  assert.strictEqual(LEGAL_CONSENT_VERSION, require('../cloudfunctions/membership/core').LEGAL_CONSENT_VERSION)
  for (const member of [active, { ...active, legalConsentAccepted: true },
    { ...active, legalConsentVersion: 0, legalConsentAccepted: true },
    { ...active, legalConsentVersion: LEGAL_CONSENT_VERSION, legalConsentAccepted: false }]) {
    assert.strictEqual(hasCurrentLegalConsent(member), false)
    const store = new MembershipStore()
    handler = async () => member
    assert.strictEqual((await store.init()).status, 'consent_required')
    assert.strictEqual((await store.init()).status, 'consent_required', '复用运行时状态不能跳过同意')
    assert.strictEqual((await store.init({ allowUnconsented: true })).status, 'active')
    assert.strictEqual((await store.init()).status, 'consent_required', 'Access 特许读取不能污染普通入口')
    handler = async () => { throw new Error('offline') }
    assert.strictEqual((await store.init({ force: true })).status, 'consent_required', '离线回退仍需同意')
  }
  handler = async () => consented
  const store = new MembershipStore()
  assert.strictEqual((await store.init()).status, 'active')
  assert.strictEqual(hasCurrentLegalConsent(store.member), true)
}

async function testCoalescedInitKeepsPerCallerGate() {
  for (const accessFirst of [false, true]) {
    const store = new MembershipStore()
    let resolveStatus
    handler = () => new Promise((resolve) => { resolveStatus = resolve })
    const first = store.init(accessFirst ? { allowUnconsented: true } : {})
    const second = store.init(accessFirst ? {} : { allowUnconsented: true })
    await new Promise((resolve) => setImmediate(resolve))
    resolveStatus(active)
    const results = await Promise.all([first, second])
    assert.deepStrictEqual(results.map((member) => member.status),
      accessFirst ? ['active', 'consent_required'] : ['consent_required', 'active'])
  }
}

async function testConsentActionsAndIdentityReset() {
  const store = new MembershipStore()
  calls = []
  for (const invalid of [null, { accepted: true }, { ...consent, version: 0 },
    { ...consent, privacyRead: false }, { ...consent, agreementRead: false }, { ...consent, accepted: false }]) {
    assert.strictEqual(legalConsentPayload(invalid), null)
    await assert.rejects(store.acceptInvite('CODE', invalid), { code: 'LEGAL_CONSENT_REQUIRED' })
    await assert.rejects(store.acceptLegalConsent(invalid), { code: 'LEGAL_CONSENT_REQUIRED' })
  }
  assert.deepStrictEqual(calls, [], '缺少当前主动同意时不允许调用云端')
  handler = async () => consented
  await store.acceptInvite('CODE', { ...consent, untrustedExtra: true })
  assert.deepStrictEqual(calls.pop(), ['membership', 'acceptInvite', { code: 'CODE', legalConsent: consent, legalConsentVersion: 2 }])
  store.save(active)
  await store.acceptLegalConsent(consent)
  assert.deepStrictEqual(calls.pop(), ['membership', 'acceptLegalConsent', { legalConsent: consent, cacheNamespace: namespaceA, legalConsentVersion: 2 }])
  assert.strictEqual((await store.init()).status, 'active')
  store.reset()
  await assert.rejects(store.acceptLegalConsent(consent), { code: 'STALE_IDENTITY_RESPONSE' })
  assert.deepStrictEqual(calls, [])

  store.save(active)
  let resolveAcceptance
  handler = () => new Promise((resolve) => { resolveAcceptance = resolve })
  const pending = store.acceptLegalConsent(consent)
  await new Promise((resolve) => setImmediate(resolve))
  store.reset()
  store.save({ ...active, cacheNamespace: namespaceB })
  resolveAcceptance(consented)
  await assert.rejects(pending, { code: 'STALE_IDENTITY_RESPONSE' })
  assert.strictEqual(store.cacheNamespace, namespaceB)
  assert.strictEqual((await store.init()).status, 'consent_required')
}

async function testVersionNegotiationCannotBeOverridden() {
  const store = new MembershipStore()
  calls = []
  handler = async () => consented
  await store.init()
  assert.deepStrictEqual(calls.pop(), ['membership', 'status', { legalConsentVersion: 2 }])
  await store.transferOwner('synthetic-member-reference', true)
  assert.deepStrictEqual(calls.pop(), ['membership', 'transferOwner', {
    memberRef: 'synthetic-member-reference', confirmed: true, legalConsentVersion: 2,
  }])
  await store.runIdentityAction('acceptLegalConsent', { legalConsent: consent, legalConsentVersion: 1 })
  assert.strictEqual(calls.pop()[2].legalConsentVersion, 2, '调用参数不能使当前客户端降级协议')
}

async function testLegacyConsentKeepsCoreAccessWithoutSharing() {
  for (const member of [
    { ...active, legalConsentVersion: 1, legalConsentAccepted: true },
    { ...active, legalConsentVersion: 2, legalConsentAccepted: false, serviceConsentAccepted: true },
  ]) {
    assert.strictEqual(hasCurrentLegalConsent(member), false)
    assert.strictEqual(hasServiceLegalConsent(member), true)
    const store = new MembershipStore()
    handler = async () => member
    assert.strictEqual((await store.init()).status, 'active', '有效旧同意不重复拦截入口')
    handler = async () => { throw new Error('offline') }
    assert.strictEqual((await store.init({ force: true })).status, 'active')
    assert.strictEqual(store.member.phoneVisibilityEnabled, undefined, '进入不能替成员开启展示')
  }
  for (const member of [
    { ...active, serviceConsentAccepted: true },
    { ...active, legalConsentVersion: 3, legalConsentAccepted: true, serviceConsentAccepted: true },
    { ...active, legalConsentVersion: 2, serviceConsentAccepted: 'true' },
    { ...consented, status: 'deleting' }, { ...consented, status: 'invite_required' },
  ]) assert.strictEqual(hasServiceLegalConsent(member), false)
  const store = new MembershipStore()
  store.save({ ...active, legalConsentVersion: 2, serviceConsentAccepted: true,
    phoneVisibilitySupported: true, phoneVisibilityEnabled: false, phoneVisibilityRevision: 0 })
  calls = []
  for (const invalid of [null, 'true', 1, {}]) await assert.rejects(store.setPhoneVisibility(invalid))
  assert.deepStrictEqual(calls, [])
  handler = async () => ({ ...store.member, phoneVisibilityEnabled: true, phoneVisibilityRevision: 1 })
  await store.setPhoneVisibility(true)
  assert.deepStrictEqual(calls.pop(), ['membership', 'setPhoneVisibility', {
    allowed: true, phoneVisibilityVersion: 1, cacheNamespace: namespaceA, expectedRevision: 0, legalConsentVersion: 2,
  }])
  assert.strictEqual(store.member.phoneVisibilityEnabled, true)
  assert.strictEqual(store.member.legalConsentAccepted, undefined, '尾号选择不能伪造整套协议再次同意')
}

async function main() {
  await testStrictProofAndRuntimeProjection()
  await testCoalescedInitKeepsPerCallerGate()
  await testConsentActionsAndIdentityReset()
  await testVersionNegotiationCannotBeOverridden()
  await testLegacyConsentKeepsCoreAccessWithoutSharing()
  console.log('legal consent membership gate tests passed')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
