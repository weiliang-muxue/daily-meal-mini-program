'use strict'

const crypto = require('crypto')
const { notFound } = require('./not-found')
const { COLLECTION, LEGAL_VERSION, MAX_CREDITS, INTENT_TTL, fail, namespaceValid,
  configuration, schedule, scheduleKey, dueSlot, currentState, eligible, publicState, messageData } = require('./core')

function createService({ db, send, env = () => process.env, now = Date.now,
  random = () => crypto.randomBytes(16).toString('hex') }) {
  async function read(reference) {
    try { return (await reference.get()).data || null }
    catch (error) { if (notFound(error)) return null; throw error }
  }
  async function member(transaction, owner, namespace) {
    const record = await read(transaction.collection('meal_members').doc(owner))
    if (!record || record.status !== 'active') fail('MEMBERSHIP_REQUIRED')
    if (!namespaceValid(namespace) || record.cacheNamespace !== namespace) fail('STALE_DATA_GENERATION')
    if (!record.legalConsent || record.legalConsent.version !== LEGAL_VERSION) fail('LEGAL_CONSENT_REQUIRED')
    return record
  }
  async function settings(transaction, owner) {
    const record = await read(transaction.collection('meal_user_states').doc(owner))
    return record && record.waterReminder
  }
  async function action(owner, namespace, event) {
    if (!owner) fail('MEMBERSHIP_REQUIRED')
    if (!['status', 'prepare', 'grant', 'stop'].includes(event.action)) fail('INVALID_ACTION')
    const config = configuration(env()), timestamp = now(), candidateId = random()
    return db.runTransaction(async (transaction) => {
      await member(transaction, owner, namespace)
      const reference = transaction.collection(COLLECTION).doc(owner)
      const raw = await read(reference), times = await settings(transaction, owner)
      const state = currentState(raw, owner, namespace, config, timestamp)
      if (event.action === 'status') return publicState(state, config, times, timestamp)
      if (event.action === 'stop') {
        state.enabled = false
        state.credits = 0
        state.longTermAccepted = false
        state.intent = null
        // Fence a previous in-flight send. It cannot be recalled, but its late
        // result must not replace this explicit stop. Keep lastSlot consumed.
        state.attempt = null
        state.lastOutcome = 'stopped'
      } else {
        if (!config.ready) fail('WATER_NOT_CONFIGURED')
        if (!schedule(times) || !times.enabled) fail('WATER_SCHEDULE_REQUIRED')
        const key = scheduleKey(times)
        if (event.action === 'prepare') {
          if (!state.intent || state.intent.used || state.intent.expiresAt <= timestamp || state.intent.scheduleKey !== key) {
            state.intent = { id: candidateId, expiresAt: timestamp + INTENT_TTL, scheduleKey: key, used: false }
          }
        } else {
          if (!state.intent || event.intentId !== state.intent.id || state.intent.scheduleKey !== key) fail('WATER_INTENT_INVALID')
          // A duplicate acknowledgement cannot manufacture additional send slots.
          if (state.intent.used) return publicState(state, config, times, timestamp)
          if (state.intent.expiresAt <= timestamp || event.accepted !== true) fail('WATER_INTENT_INVALID')
          state.intent.used = true
          state.enabled = true
          if (state.grantedScheduleKey !== key) { state.credits = 0; state.longTermAccepted = false }
          state.grantedScheduleKey = key
          if (config.type === 'once') state.credits = Math.min(MAX_CREDITS, state.credits + 1)
          else state.longTermAccepted = true
          state.authorizedAt = timestamp
          // A new explicit grant supersedes the previous delivery attempt;
          // neither its late failure nor crash recovery may revoke this grant.
          // Do not refund its credit or clear lastSlot (no replay).
          state.attempt = null
          state.lastOutcome = ''
        }
      }
      state.updatedAt = timestamp
      // Write the member too: deletion's status change serializes with this write.
      await transaction.collection('meal_members').doc(owner).update({ data: { waterPushTouchedAt: timestamp } })
      await reference.set({ data: state })
      return publicState(state, config, times, timestamp)
    })
  }

  async function claim(owner, config) {
    const timestamp = now(), attemptId = random()
    return db.runTransaction(async (transaction) => {
      const reference = transaction.collection(COLLECTION).doc(owner), raw = await read(reference)
      if (!raw || raw.configRevision !== config.revision) return null
      try { await member(transaction, owner, raw.cacheNamespace) } catch (error) {
        if (['MEMBERSHIP_REQUIRED', 'STALE_DATA_GENERATION', 'LEGAL_CONSENT_REQUIRED'].includes(error.code)) return null
        throw error
      }
      const state = currentState(raw, owner, raw.cacheNamespace, config, timestamp)
      const times = await settings(transaction, owner)
      if (state.attempt && state.attempt.status === 'sending') {
        // Claim-before-send gives at-most-once attempts, not exactly-once delivery.
        // After a crash/timeout do not reuse the credit or resend an uncertain message.
        if (timestamp - state.attempt.at < 2 * 60000) return null
        state.enabled = false
        state.lastOutcome = 'unknown'
        state.attempt.status = 'unknown'
        state.updatedAt = timestamp
        await reference.set({ data: state })
        return null
      }
      if (!eligible(state, config, times)) return null
      const slot = dueSlot(times, state, timestamp)
      if (!slot) return null
      state.lastSlot = slot
      if (config.type === 'once') state.credits -= 1
      state.attempt = { id: attemptId, at: timestamp, slot, status: 'sending', scheduleKey: scheduleKey(times) }
      state.updatedAt = timestamp
      await transaction.collection('meal_members').doc(owner).update({ data: { waterPushTouchedAt: timestamp } })
      await reference.set({ data: state })
      return { owner, namespace: state.cacheNamespace, configRevision: state.configRevision,
        id: attemptId, slot, scheduleKey: state.attempt.scheduleKey }
    })
  }

  async function stillCurrent(attempt, config) {
    return db.runTransaction(async (transaction) => {
      await member(transaction, attempt.owner, attempt.namespace)
      const state = await read(transaction.collection(COLLECTION).doc(attempt.owner))
      const times = await settings(transaction, attempt.owner)
      return Boolean(state && state.enabled && state.configRevision === config.revision
        && state.attempt && state.attempt.id === attempt.id && state.attempt.status === 'sending'
        && schedule(times) && times.enabled && scheduleKey(times) === attempt.scheduleKey)
    })
  }

  async function settle(attempt, outcome) {
    return db.runTransaction(async (transaction) => {
      const reference = transaction.collection(COLLECTION).doc(attempt.owner)
      const state = await read(reference)
      const identity = await read(transaction.collection('meal_members').doc(attempt.owner))
      if (!identity || identity.status !== 'active' || identity.cacheNamespace !== attempt.namespace
        || !state || state.cacheNamespace !== attempt.namespace || state.configRevision !== attempt.configRevision
        || !state.attempt || state.attempt.id !== attempt.id || state.attempt.status !== 'sending') return
      state.attempt.status = outcome
      state.lastOutcome = outcome
      state.updatedAt = now()
      if (outcome !== 'sent') {
        state.enabled = false
        state.credits = 0
        state.longTermAccepted = false
        state.intent = null
      }
      const { _id, ...data } = state
      await reference.set({ data })
    })
  }

  async function tick() {
    const config = configuration(env())
    const summary = { ready: config.ready, attempted: 0, accepted: 0, skipped: 0, errors: 0 }
    if (!config.ready) return summary
    // The invitation system caps the app at 11 members. This bounds work even on corrupt data.
    const candidates = await db.collection(COLLECTION).where({ enabled: true }).limit(100).get()
    for (const record of candidates.data || []) {
      try {
        if (!record.owner || record._id !== record.owner) { summary.skipped += 1; continue }
        const attempt = await claim(record.owner, config)
        if (!attempt) { summary.skipped += 1; continue }
        let current = false
        try { current = await stillCurrent(attempt, config) } catch (_) {}
        if (!current) { await settle(attempt, 'stopped'); summary.skipped += 1; continue }
        summary.attempted += 1
        let outcome = 'unknown'
        try {
          const result = await send({ touser: attempt.owner, templateId: config.templateId,
            page: 'pages/water-reminder/water-reminder', miniprogramState: config.stage, lang: 'zh_CN',
            data: messageData(config, attempt.slot) })
          const code = result && (result.errCode !== undefined ? result.errCode : result.errcode)
          outcome = code === 0 || code === '0' ? 'sent' : Number(code) === 43101 ? 'rejected' : 'failed'
        } catch (error) {
          const code = error && (error.errCode !== undefined ? error.errCode : error.errcode)
          if (Number(code) === 43101) outcome = 'rejected'
          else if ([40037, 47003, 41030].includes(Number(code))) outcome = 'failed'
        }
        await settle(attempt, outcome)
        if (outcome === 'sent') summary.accepted += 1
        else summary.errors += 1
      } catch (_) { summary.errors += 1 }
    }
    return summary
  }
  return { action, tick, claim }
}

module.exports = { createService }
