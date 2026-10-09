'use strict'
const assert = require('assert')
const { createService } = require('./service')
const core = require('./core')
const clone = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v))

class Database {
  constructor() { this.docs = {}; this.tail = Promise.resolve() }
  collection(name, source) {
    const db = this, records = () => { const all = source || db.docs; return all[name] || (all[name] = {}) }
    return {
      doc(id) { return {
        async get() { return { data: clone(records()[id]) } },
        async set({ data }) { records()[id] = clone(data) },
        async update({ data }) { if (!records()[id]) throw Error('missing'); Object.assign(records()[id], clone(data)) },
        async remove() { delete records()[id] },
      } },
      where(criteria) { return { limit(max) { return { async get() { return { data: Object.entries(records())
        .filter(([, value]) => Object.entries(criteria).every(([k, v]) => value[k] === v)).slice(0, max)
        .map(([id, value]) => ({ _id: id, ...clone(value) })) } } } } } },
    }
  }
  runTransaction(fn) {
    const run = this.tail.then(async () => { const next = clone(this.docs); const result = await fn({ collection: (name) => this.collection(name, next) }); this.docs = next; return result })
    this.tail = run.catch(() => {}); return run
  }
}

const namespace = 'a'.repeat(32), secondNamespace = 'b'.repeat(32)
const raw = { enabled: true, cadence: 'daily', startTime: '09:00', endTime: '18:00', intervalMinutes: 60, timeZone: 'Asia/Shanghai' }
const baseEnv = { WATER_PUSH_ENABLED: 'true', WATER_PUSH_TEMPLATE_CONFIRMED: 'true',
  WATER_PUSH_TEMPLATE_ID: 'offline-template-placeholder', WATER_PUSH_TEMPLATE_TYPE: 'once',
  WATER_PUSH_MINIPROGRAM_STATE: 'developer', WATER_PUSH_FIELDS: JSON.stringify({ thing1: 'message', time2: 'time' }) }
const time = (text) => Date.parse(text + '+08:00')
function fixture() {
  const db = new Database(), sent = [], env = { ...baseEnv }
  let timestamp = time('2026-10-09T08:59:00'), seq = 0, sender = async () => ({ errCode: 0 })
  db.docs = { meal_members: { alpha: { status: 'active', cacheNamespace: namespace, legalConsent: { version: 2 } },
    beta: { status: 'active', cacheNamespace: secondNamespace, legalConsent: { version: 2 } } },
  meal_user_states: { alpha: { waterReminder: clone(raw) }, beta: { waterReminder: clone(raw) } } }
  const service = createService({ db, env: () => env, now: () => timestamp, random: () => String(++seq).padStart(32, '0'),
    send: async (message) => { sent.push(message); return sender(message) } })
  return { db, sent, env, service, setTime: (v) => { timestamp = time(v) }, setSender: (fn) => { sender = fn },
    state: () => db.docs.meal_water_push && db.docs.meal_water_push.alpha,
    call: (action, payload = {}, owner = 'alpha', ns = namespace) => service.action(owner, ns, { action, ...payload }) }
}
async function grant(f) { const p = await f.call('prepare'); return f.call('grant', { intentId: p.intentId, accepted: true }) }
let cases = 0
async function check(name, fn) { await fn(); cases += 1; console.log('PASS', name) }
async function main() {
  await check('configuration fails closed; no template, type, fields or stage guessed', async () => {
    assert(!core.configuration({}).ready)
    for (const field of Object.keys(baseEnv)) assert(!core.configuration({ ...baseEnv, [field]: '' }).ready, field)
    assert(!core.configuration({ ...baseEnv, WATER_PUSH_FIELDS: '{"url1":"message"}' }).ready)
    assert(!core.configuration({ ...baseEnv, WATER_PUSH_TEMPLATE_TYPE: 'unlimited' }).ready)
  })
  await check('Beijing weekday/Friday end/weekend/midnight scheduling', async () => {
    assert.equal(core.nextSlot({ ...raw, cadence: 'weekdays' }, time('2026-10-09T18:00:00')), time('2026-10-12T09:00:00'))
    assert.equal(core.nextSlot(raw, time('2026-10-09T23:59:00')), time('2026-10-10T09:00:00'))
    assert.equal(core.nextSlot({ ...raw, enabled: false }, time('2026-10-09T08:59:00')), null)
    for (const patch of [{ startTime: '25:00' }, { endTime: '08:00' }, { intervalMinutes: 0 }, { cadence: 'sometimes' }, { timeZone: 'UTC' }, { startTime: '00:00', endTime: '23:59', intervalMinutes: 30 }]) assert.equal(core.schedule({ ...raw, ...patch }), null)
  })
  await check('saved schedule preferences never auto-subscribe', async () => {
    const f = fixture(); assert(!(await f.call('status')).enabled); await f.service.tick(); assert.equal(f.sent.length, 0)
  })
  await check('identity generation, deletion and consent checks', async () => {
    const f = fixture()
    await assert.rejects(f.call('prepare', {}, 'alpha', secondNamespace), /STALE/)
    await assert.rejects(f.call('prepare', {}, 'outsider'), /MEMBERSHIP/)
    f.db.docs.meal_members.alpha.status = 'deleting'; await assert.rejects(f.call('prepare'), /MEMBERSHIP/)
    f.db.docs.meal_members.alpha.status = 'active'; f.db.docs.meal_members.alpha.legalConsent.version = 1
    await assert.rejects(f.call('prepare'), /LEGAL/)
  })
  await check('grant is single-use and replay safe, user-selected recipient ignored', async () => {
    const f = fixture(), p = await f.call('prepare')
    const payload = { intentId: p.intentId, accepted: true, owner: 'beta', touser: 'beta', credits: 999 }
    await Promise.all([f.call('grant', payload), f.call('grant', payload)])
    assert.equal(f.state().credits, 1); assert(!f.db.docs.meal_water_push.beta)
    const visible = await f.call('status'); assert(!('owner' in visible)); assert(!('cacheNamespace' in visible))
  })
  await check('expired, rejected, forged, changed-schedule intent denied', async () => {
    const f = fixture(), p = await f.call('prepare')
    await assert.rejects(f.call('grant', { intentId: p.intentId, accepted: false }), /INTENT/)
    await assert.rejects(f.call('grant', { intentId: 'forged', accepted: true }), /INTENT/)
    f.db.docs.meal_user_states.alpha.waterReminder.startTime = '10:00'
    await assert.rejects(f.call('grant', { intentId: p.intentId, accepted: true }), /INTENT/)
    f.db.docs.meal_user_states.alpha.waterReminder.startTime = '09:00'; f.setTime('2026-10-09T09:05:00')
    await assert.rejects(f.call('grant', { intentId: p.intentId, accepted: true }), /INTENT/)
  })
  await check('concurrent timers send one message, recipient from trusted identity', async () => {
    const f = fixture(); await grant(f); f.setTime('2026-10-09T09:00:00')
    await Promise.all([f.service.tick(), f.service.tick(), f.service.tick()])
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].touser, 'alpha'); assert.equal(f.state().credits, 0)
    assert.equal(f.state().lastOutcome, 'sent'); assert.equal(f.sent[0].data.time2.value, '2026-10-09 09:00')
    f.setTime('2026-10-09T10:00:00'); await f.service.tick(); assert.equal(f.sent.length, 1)
  })
  await check('no overdue burst and new grant never sends a past slot', async () => {
    const f = fixture(); await grant(f); f.setTime('2026-10-09T09:02:00'); await f.service.tick(); assert.equal(f.sent.length, 0)
    f.setTime('2026-10-09T10:00:00'); await f.service.tick(); assert.equal(f.sent.length, 1)
    const g = fixture(); g.setTime('2026-10-09T09:00:20'); await grant(g); await g.service.tick(); assert.equal(g.sent.length, 0)
  })
  await check('persisted off switch stops sends, no collateral private data writes', async () => {
    const f = fixture(); await grant(f); const before = clone(f.db.docs.meal_user_states)
    f.db.docs.meal_user_states.alpha.waterReminder.enabled = false; f.setTime('2026-10-09T09:00:00')
    await f.service.tick(); assert.equal(f.sent.length, 0)
    f.db.docs.meal_user_states.alpha.waterReminder.enabled = true
    await f.call('stop'); await f.service.tick(); assert.equal(f.sent.length, 0); assert.equal(f.state().credits, 0)
    assert.deepEqual(f.db.docs.meal_user_states, before)
  })
  await check('timeouts pause without retrying or refunding uncertain delivery', async () => {
    const f = fixture(); await grant(f); await grant(f); f.setSender(async () => { throw Error('timeout containing private data') })
    f.setTime('2026-10-09T09:00:00'); await f.service.tick(); await f.service.tick()
    assert.equal(f.sent.length, 1); assert.equal(f.state().lastOutcome, 'unknown'); assert(!f.state().enabled)
    assert(!JSON.stringify(f.state()).includes('private data'))
  })
  await check('saving off/on or changing schedule requires fresh explicit authorization', async () => {
    const f = fixture(); await grant(f)
    f.db.docs.meal_user_states.alpha.waterReminder.scheduleVersion = 2
    f.setTime('2026-10-09T09:00:00'); await f.service.tick()
    assert.equal(f.sent.length, 0); assert(!(await f.call('status')).enabled)
    assert.equal((await f.call('status')).remaining, 0)
    await grant(f); assert.equal(f.state().credits, 1)
    f.setTime('2026-10-09T10:00:00'); await f.service.tick(); assert.equal(f.sent.length, 1)
  })
  await check('WeChat denial and known errors stop; no raw errors persisted', async () => {
    for (const code of [43101, 47003, 40037]) {
      const f = fixture(); await grant(f); f.setSender(async () => ({ errCode: code, errMsg: 'sensitive' }))
      f.setTime('2026-10-09T09:00:00'); await f.service.tick(); assert(!f.state().enabled); assert.equal(f.state().credits, 0)
      assert(!JSON.stringify(f.state()).includes('sensitive'))
    }
  })
  await check('crash after claim prevents retries and pauses stale attempts', async () => {
    const f = fixture(); await grant(f); f.setTime('2026-10-09T09:00:00'); await f.service.claim('alpha', core.configuration(f.env))
    await f.service.tick(); assert.equal(f.sent.length, 0)
    f.setTime('2026-10-09T09:03:00'); await f.service.tick(); assert.equal(f.state().lastOutcome, 'unknown'); assert(!f.state().enabled)
  })
  await check('empty or malformed send responses never count as platform acceptance', async () => {
    for (const response of [undefined, {}, { errCode: '' }, { errCode: false }, { errCode: null }]) {
      const f = fixture(); await grant(f); f.setSender(async () => response)
      f.setTime('2026-10-09T09:00:00'); const result = await f.service.tick()
      assert.equal(result.accepted, 0); assert(!f.state().enabled)
    }
  })
  await check('member deletion/generation change blocks future sends', async () => {
    for (const patch of [{ status: 'deleting' }, { cacheNamespace: secondNamespace }]) {
      const f = fixture(); await grant(f); Object.assign(f.db.docs.meal_members.alpha, patch)
      f.setTime('2026-10-09T09:00:00'); await f.service.tick(); assert.equal(f.sent.length, 0)
    }
  })
  await check('settlement after deletion never recreates private records', async () => {
    const f = fixture(); await grant(f); f.setTime('2026-10-09T09:00:00')
    f.setSender(async () => { delete f.db.docs.meal_water_push.alpha; f.db.docs.meal_members.alpha.status = 'deleting'; return { errCode: 0 } })
    await f.service.tick(); assert(!f.state())
  })
  await check('late delivery outcomes cannot overwrite an explicit stop', async () => {
    for (const outcome of ['sent', 'rejected', 'unknown']) {
      const f = fixture(); await grant(f); f.setTime('2026-10-09T09:00:00')
      let stopped
      f.setSender(async () => {
        await f.call('stop'); stopped = clone(f.state())
        if (outcome === 'unknown') throw Error('synthetic transport timeout')
        return { errCode: outcome === 'sent' ? 0 : 43101 }
      })
      await f.service.tick()
      assert.deepEqual(f.state(), stopped, outcome)
      assert.equal((await f.call('status')).lastOutcome, 'stopped')
      f.setTime('2026-10-09T10:00:00'); await f.service.tick()
      assert.equal(f.sent.length, 1)
    }
  })
  await check('late outcomes cannot revoke a newer explicit subscription', async () => {
    for (const type of ['once', 'longterm']) for (const stopFirst of [false, true]) {
      for (const outcome of ['sent', 'rejected', 'unknown']) {
        const f = fixture(); f.env.WATER_PUSH_TEMPLATE_TYPE = type; await grant(f)
        const privateBefore = clone(f.db.docs.meal_user_states)
        f.setTime('2026-10-09T09:00:00')
        let renewed
        f.setSender(async () => {
          if (stopFirst) await f.call('stop')
          f.setTime('2026-10-09T09:00:30'); await grant(f); renewed = clone(f.state())
          if (outcome === 'unknown') throw Error('synthetic transport timeout')
          return { errCode: outcome === 'sent' ? 0 : 43101 }
        })
        await f.service.tick()
        assert.deepEqual(f.state(), renewed, `${type}/${stopFirst}/${outcome}`)
        assert((await f.call('status')).enabled)
        assert.equal(f.state().credits, type === 'once' ? 1 : 0)
        // No refund or replay for the attempt already handed to the platform.
        await f.service.tick(); assert.equal(f.sent.length, 1)
        f.setSender(async () => ({ errCode: 0 }))
        f.setTime('2026-10-09T10:00:00'); await f.service.tick()
        assert.equal(f.sent.length, 2)
        assert.deepEqual(f.db.docs.meal_user_states, privateBefore)
      }
    }
  })
  await check('fresh subscription retires a crashed claim without refund or replay', async () => {
    const f = fixture(); await grant(f); f.setTime('2026-10-09T09:00:00')
    await f.service.claim('alpha', core.configuration(f.env))
    assert.equal(f.state().credits, 0)
    const claimedSlot = f.state().lastSlot
    f.setTime('2026-10-09T09:00:30'); await grant(f)
    assert.equal(f.state().credits, 1); assert.equal(f.state().lastSlot, claimedSlot)
    f.setTime('2026-10-09T09:03:00'); await f.service.tick()
    assert((await f.call('status')).enabled); assert.equal(f.sent.length, 0)
    f.setTime('2026-10-09T10:00:00'); await f.service.tick()
    assert.equal(f.sent.length, 1); assert.equal(f.state().credits, 0)
  })
  await check('template/type/config change invalidates authorization', async () => {
    const f = fixture(); await grant(f); f.env.WATER_PUSH_TEMPLATE_TYPE = 'longterm'; f.setTime('2026-10-09T09:00:00')
    assert(!(await f.call('status')).enabled); await f.service.tick(); assert.equal(f.sent.length, 0)
  })
  await check('long-term only explicit config plus fresh user authorization', async () => {
    const f = fixture(); f.env.WATER_PUSH_TEMPLATE_TYPE = 'longterm'; await grant(f)
    f.setTime('2026-10-09T09:00:00'); await f.service.tick(); f.setTime('2026-10-09T10:00:00'); await f.service.tick()
    assert.equal(f.sent.length, 2); await f.call('stop'); f.setTime('2026-10-09T11:00:00'); await f.service.tick(); assert.equal(f.sent.length, 2)
  })
  await check('credit cap and second-user isolation', async () => {
    const f = fixture(); for (let n = 0; n < 26; n += 1) await grant(f)
    assert.equal(f.state().credits, 24)
    const other = await f.call('status', {}, 'beta', secondNamespace); assert.equal(other.remaining, 0); assert(!other.enabled)
  })
  console.log(`water push backend: ${cases} scenarios passed (offline only)`)
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
