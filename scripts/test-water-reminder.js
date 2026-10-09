'use strict'
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '..')
const { membershipStore } = require('../miniprogram/services/membership-store')
const { userStore } = require('../miniprogram/services/user-store')
const push = require('../miniprogram/services/water-push')
global.Page = () => {}
global.wx = { showToast() {} }
const { waterReminderPage: definition, reminderForSave } = require('../miniprogram/pages/water-reminder/water-reminder')
const raw = { enabled: true, cadence: 'daily', startTime: '09:00', endTime: '18:00', intervalMinutes: 60, timeZone: 'Asia/Shanghai', scheduleVersion: 1, updatedAt: null }
const ns = 'a'.repeat(32)
let cases = 0
async function check(name, fn) { await fn(); cases += 1; console.log('PASS', name) }
function page() {
  const p = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(patch) { Object.assign(this.data, patch) } }
  p.data.saved = { ...raw }; p.data.draft = { ...raw }; p.data.loading = false
  p.intent = { id: 'offline-intent', templateId: 'offline-template', expiresAt: Date.now() + 60000 }
  p.data.canSubscribe = true
  return p
}
async function main() {
  membershipStore.cacheNamespace = ns; membershipStore.verifiedInRuntime = true
  const originalRequest = push.request
  await check('no calendar implementation, permission or entry remains', async () => {
    assert(!fs.existsSync(path.join(root, 'miniprogram/services/water-reminder-calendar.js')))
    for (const file of ['miniprogram/pages/water-reminder/water-reminder.js', 'miniprogram/pages/water-reminder/water-reminder.wxml', 'miniprogram/pages/water-reminder/push-actions.js']) {
      const text = fs.readFileSync(path.join(root, file), 'utf8')
      assert(!/addPhone(Calendar|RepeatCalendar)|scope\.addPhoneCalendar|addToCalendar|calendarInstalling/.test(text), file)
    }
    assert.equal(definition.data.draft.enabled, false); assert.equal(definition.data.canSubscribe, false)
  })
  await check('schedule validation, turn off invalid hidden form, preview', async () => {
    assert.equal(push.reminderTimes(raw).length, 10)
    assert.equal(reminderForSave({ ...raw, enabled: false, endTime: '08:00' }, raw).enabled, false)
    assert.throws(() => reminderForSave({ ...raw, endTime: '08:00' }, raw))
    const p = page(); p.refreshPreview(); assert.equal(p.data.previewTimes[0], '09:00')
    p.data.draft.endTime = '08:00'; p.refreshPreview(); assert(p.data.scheduleInvalid)
  })
  await check('subscription native call happens in gesture, no cloud before accept', async () => {
    const p = page(), order = []; let accept
    wx.requestSubscribeMessage = (options) => { order.push('native'); accept = options.success }
    push.request = async (action) => { order.push(action); return { ready: true, type: 'once', enabled: true, remaining: 1 } }
    p.subscribe(); assert.deepEqual(order, ['native']); assert(p.data.subscribing)
    p.subscribe(); assert.deepEqual(order, ['native'])
    accept({ 'offline-template': 'accept' }); await new Promise(setImmediate)
    assert.deepEqual(order, ['native', 'grant']); assert.equal(p.data.pendingGrant, false)
  })
  await check('rejection and failures never register a send credit', async () => {
    let calls = 0; push.request = async () => { calls += 1 }
    for (const result of ['reject', 'ban', 'filter']) {
      const p = page(); wx.requestSubscribeMessage = (o) => o.success({ 'offline-template': result }); p.subscribe()
      assert(!p.data.subscribing); assert(p.data.pushError)
    }
    const p = page(); wx.requestSubscribeMessage = (o) => o.fail({ errMsg: 'raw private error' }); p.subscribe()
    assert(!p.data.pushError.includes('private')); assert.equal(calls, 0)
  })
  await check('expired intent and dirty/pending drafts cannot subscribe', async () => {
    let count = 0; wx.requestSubscribeMessage = () => { count += 1 }
    for (const change of [{ dirty: true }, { syncPending: true }, { saving: true }, { canSubscribe: false }]) { const p = page(); Object.assign(p.data, change); p.subscribe() }
    const p = page(); p.intent.expiresAt = 1; p.subscribe(); assert.equal(count, 0); assert(p.data.pushError)
  })
  await check('grant retry is idempotent cloud-only and does not re-prompt', async () => {
    const p = page(); let calls = 0, prompt = 0
    wx.requestSubscribeMessage = (o) => { prompt += 1; o.success({ 'offline-template': 'accept' }) }
    push.request = async () => { if (++calls === 1) throw Error('offline'); return { ready: true, type: 'once', remaining: 1, enabled: true } }
    p.subscribe(); await new Promise(setImmediate); assert(p.data.pendingGrant)
    await p.submitGrant(); assert(!p.data.pendingGrant); assert.equal(prompt, 1); assert.equal(calls, 2)
  })
  await check('stale namespace/unloaded page cannot register native callbacks', async () => {
    let calls = 0, callback; push.request = async () => { calls += 1 }
    wx.requestSubscribeMessage = (o) => { callback = o.success }
    const p = page(); p.subscribe(); membershipStore.cacheNamespace = 'b'.repeat(32); callback({ 'offline-template': 'accept' })
    await new Promise(setImmediate); assert.equal(calls, 0); membershipStore.cacheNamespace = ns
    const q = page(); q.subscribe(); q.unloaded = true; callback({ 'offline-template': 'accept' }); assert.equal(calls, 0)
  })
  await check('state refresh never automatically invokes native authorization', async () => {
    let prompts = 0; wx.requestSubscribeMessage = () => { prompts += 1 }
    push.request = async () => ({ ready: false }); const p = page(); await p.refreshPush()
    assert(!p.data.canSubscribe); assert(p.data.pushTitle.includes('暂未开通')); assert.equal(prompts, 0)
  })
  await check('identity changes clear the previous user schedule and displayed status', async () => {
    const p = page(); p.load = async () => {}; p.setupTheme = () => {}; p.refreshNavigation = () => {}
    await p.onLoad(); p.data.previewTimes = ['09:00']; p.data.pushDetail = 'previous status'
    try {
      membershipStore.namespaceListeners.forEach((listener) => listener())
      assert.equal(p.data.saved.enabled, false); assert.equal(p.data.draft.enabled, false)
      assert.deepEqual(p.data.previewTimes, []); assert.equal(p.data.pushDetail, '')
      assert(!p.data.canSubscribe); assert(p.data.loadError)
    } finally { p.onUnload() }
  })
  await check('save only patches schedule; retry does not increment the schedule twice', async () => {
    const originalPatch = userStore.patch, originalFlush = userStore.flush
    const p = page(); p.refreshPush = async () => {}; p.data.dirty = true; p.data.draft.startTime = '10:00'
    let fields, options
    userStore.patch = async (value, settings) => { fields = value; options = settings; return value }
    try {
      await p.save()
      assert.deepEqual(Object.keys(fields), ['waterReminder']); assert.equal(options.immediate, true)
      assert.equal(fields.waterReminder.scheduleVersion, 2); assert.equal(p.data.saved.startTime, '10:00')
      assert(!p.data.dirty); assert(!p.data.saving)
      p.data.syncPending = true; userStore.flush = async () => fields
      await p.retrySync(); assert.equal(p.data.saved.scheduleVersion, 2); assert(!p.data.syncPending)
      p.data.dirty = true; userStore.patch = async () => { throw new Error('temporary failure') }
      await p.save(); assert(p.data.saveError); assert(!p.data.saving); assert(p.data.dirty)
    } finally { userStore.patch = originalPatch; userStore.flush = originalFlush }
  })
  await check('editing during pending preparation cannot unlock stale subscription', async () => {
    const p = page(); let done; push.request = () => new Promise(resolve => { done = resolve })
    const pending = p.refreshPush(); p.updateDraft({ startTime: '10:00' })
    done({ ready: true, intentId: 'stale', templateId: 'offline-template', intentExpiresAt: Date.now() + 60000 })
    await pending; assert(!p.data.canSubscribe); assert(!p.intent)
  })
  await check('unconfigured and limited authorization copy never promises permanent messages', async () => {
    assert(push.presentation({ ready: false }).title.includes('暂未开通'))
    assert(push.presentation({ ready: true, type: 'once', remaining: 2 }).detail.includes('用完需再次订阅'))
    assert(push.presentation({ ready: true, type: 'once', lastOutcome: 'unknown' }).detail.includes('已暂停'))
    const styles = fs.readFileSync(path.join(root, 'miniprogram/pages/water-reminder/water-reminder.wxss'), 'utf8')
    assert(/\.push-button[^}]*min-height: 48px/.test(styles)); assert(styles.includes('prefers-reduced-motion'))
  })
  push.request = originalRequest
  console.log(`water reminder page: ${cases} scenarios passed (mock native API only)`)
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
