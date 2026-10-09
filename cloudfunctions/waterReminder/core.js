'use strict'

const crypto = require('crypto')
const COLLECTION = 'meal_water_push'
const LEGAL_VERSION = 2
const MAX_CREDITS = 24
const MINUTE = 60000
const OFFSET = 8 * 60 * MINUTE
const INTENT_TTL = 5 * MINUTE
const DUE_WINDOW = 2 * MINUTE
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const namespaceValid = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)

function fail(code) { const error = new Error(code); error.code = code; throw error }

// No endpoint, credential or account-specific template is part of source code.
// Enabling requires manual verification of the account's approved template.
function configuration(env = {}) {
  const templateId = String(env.WATER_PUSH_TEMPLATE_ID || '').trim()
  const type = String(env.WATER_PUSH_TEMPLATE_TYPE || '')
  const stage = String(env.WATER_PUSH_MINIPROGRAM_STATE || '')
  let fields = null
  try { fields = JSON.parse(env.WATER_PUSH_FIELDS || '') } catch (_) {}
  const entries = fields && !Array.isArray(fields) && typeof fields === 'object' ? Object.entries(fields) : []
  const fieldsValid = entries.length >= 2 && entries.length <= 5
    && entries.some(([key, value]) => /^thing\d+$/.test(key) && value === 'message')
    && entries.some(([key, value]) => /^time\d+$/.test(key) && value === 'time')
    && entries.every(([key, value]) => (/^thing\d+$/.test(key) && value === 'message')
      || (/^time\d+$/.test(key) && value === 'time'))
  const ready = env.WATER_PUSH_ENABLED === 'true' && env.WATER_PUSH_TEMPLATE_CONFIRMED === 'true'
    && /^[A-Za-z0-9_-]{10,128}$/.test(templateId) && ['once', 'longterm'].includes(type)
    && ['developer', 'trial', 'formal'].includes(stage) && fieldsValid
  return {
    ready: Boolean(ready), templateId, type, stage, fields: fieldsValid ? fields : {},
    revision: hash([templateId, type, stage, fieldsValid ? entries.sort() : []]),
  }
}

function schedule(raw) {
  if (!raw || typeof raw !== 'object') return null
  const minute = (text) => {
    if (typeof text !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text)) return NaN
    const [h, m] = text.split(':').map(Number)
    return h * 60 + m
  }
  const start = minute(raw.startTime), end = minute(raw.endTime)
  if (raw.timeZone !== 'Asia/Shanghai' || !['daily', 'weekdays'].includes(raw.cadence)
    || !Number.isFinite(start) || !Number.isFinite(end) || end <= start
    || ![30, 45, 60, 90, 120].includes(raw.intervalMinutes)
    || Math.floor((end - start) / raw.intervalMinutes) + 1 > 24) return null
  return { enabled: raw.enabled === true, cadence: raw.cadence, startTime: raw.startTime,
    endTime: raw.endTime, start, end, intervalMinutes: raw.intervalMinutes, timeZone: 'Asia/Shanghai' }
}

function scheduleKey(raw) {
  const value = schedule(raw)
  // Saving off and back on must not revive a previous grant, even if times match.
  return value ? hash([value, Number(raw.scheduleVersion) || 0]) : ''
}

function slots(raw, now) {
  const value = schedule(raw)
  if (!value || !value.enabled) return []
  const date = new Date(now + OFFSET)
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - OFFSET
  const result = []
  for (let d = 0; d < 8; d += 1) {
    const start = midnight + d * 86400000
    const weekday = new Date(start + OFFSET).getUTCDay()
    if (value.cadence === 'weekdays' && (weekday === 0 || weekday === 6)) continue
    for (let m = value.start; m <= value.end; m += value.intervalMinutes) result.push(start + m * MINUTE)
  }
  return result
}

function nextSlot(raw, now) { return slots(raw, now).find((value) => value > now) || null }
function dueSlot(raw, state, now) {
  // Never catch up old reminders in a burst after an outage or new authorization.
  return slots(raw, now).filter((value) => value <= now && now - value < DUE_WINDOW
    && value > Number(state.authorizedAt || 0) && value > Number(state.lastSlot || 0)).pop() || null
}

function freshState(owner, cacheNamespace, config, now) {
  return { schemaVersion: 1, owner, cacheNamespace, configRevision: config.revision,
    enabled: false, credits: 0, longTermAccepted: false, authorizedAt: 0, grantedScheduleKey: '',
    lastSlot: 0, lastOutcome: '', updatedAt: now, intent: null, attempt: null }
}

function currentState(raw, owner, cacheNamespace, config, now) {
  if (!raw) return freshState(owner, cacheNamespace, config, now)
  if (raw.schemaVersion !== 1) fail('WATER_SCHEMA_UNSUPPORTED')
  if (raw.owner !== owner || raw.cacheNamespace !== cacheNamespace) fail('STALE_DATA_GENERATION')
  if (raw.configRevision !== config.revision) return freshState(owner, cacheNamespace, config, now)
  const { _id, ...state } = raw
  return { ...state, credits: Math.min(MAX_CREDITS, Math.max(0, Math.floor(Number(state.credits) || 0))) }
}

function eligible(state, config, rawSchedule) {
  return config.ready && state.enabled === true
    && Boolean(state.grantedScheduleKey) && state.grantedScheduleKey === scheduleKey(rawSchedule)
    && (config.type === 'longterm' ? state.longTermAccepted === true : state.credits > 0)
}

function publicState(state, config, rawSchedule, now) {
  const times = schedule(rawSchedule)
  const enabled = eligible(state, config, rawSchedule) && Boolean(times && times.enabled)
  return { ready: config.ready, type: config.ready ? config.type : '', enabled,
    remaining: config.ready && config.type === 'once' && state.grantedScheduleKey === scheduleKey(rawSchedule) ? state.credits : 0,
    nextAt: enabled ? nextSlot(rawSchedule, Math.max(now, Number(state.lastSlot || 0))) : null,
    lastOutcome: ['sent', 'rejected', 'unknown', 'failed', 'stopped'].includes(state.lastOutcome) ? state.lastOutcome : '',
    templateId: config.ready ? config.templateId : '',
    intentId: config.ready && state.intent && !state.intent.used && state.intent.expiresAt > now ? state.intent.id : '',
    intentExpiresAt: config.ready && state.intent && !state.intent.used ? state.intent.expiresAt : 0 }
}

function messageData(config, when) {
  const stamp = new Date(when + OFFSET).toISOString().slice(0, 16).replace('T', ' ')
  return Object.fromEntries(Object.entries(config.fields).map(([key, value]) => [key,
    { value: value === 'time' ? stamp : '记得适量喝水' }]))
}

module.exports = { COLLECTION, LEGAL_VERSION, MAX_CREDITS, INTENT_TTL, DUE_WINDOW,
  fail, namespaceValid, configuration, schedule, scheduleKey, nextSlot, dueSlot,
  freshState, currentState, eligible, publicState, messageData }
