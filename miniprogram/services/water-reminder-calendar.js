'use strict'

const { sanitizeWaterReminder } = require('./user-state-core')

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const CALENDAR_REPEAT_DAYS = 30
const WEEKDAYS = [1, 2, 3, 4, 5]
const WEEKDAY_LABELS = { 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五' }

function parseMinute(time) {
  const [hour, minute] = String(time).split(':').map(Number)
  return hour * 60 + minute
}

function formatMinute(minuteOfDay) {
  const hour = Math.floor(minuteOfDay / 60)
  const minute = minuteOfDay % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function reminderTimes(raw) {
  const setting = sanitizeWaterReminder(raw)
  const start = parseMinute(setting.startTime)
  const end = parseMinute(setting.endTime)
  const result = []
  for (let minute = start; minute <= end; minute += setting.intervalMinutes) {
    result.push(formatMinute(minute))
  }
  return result
}

function beijingDate(nowMs) {
  const shifted = new Date(nowMs + BEIJING_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  }
}

function addDays(parts, days) {
  const value = new Date(Date.UTC(parts.year, parts.month, parts.day + days))
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth(),
    day: value.getUTCDate(),
    weekday: value.getUTCDay(),
  }
}

function beijingEpochSeconds(parts, time) {
  const [hour, minute] = String(time).split(':').map(Number)
  return Math.floor(Date.UTC(parts.year, parts.month, parts.day, hour - 8, minute, 0, 0) / 1000)
}

function nextDailyStart(nowMs, time) {
  const today = beijingDate(nowMs)
  let startTime = beijingEpochSeconds(today, time)
  if (startTime <= Math.floor(nowMs / 1000)) startTime = beijingEpochSeconds(addDays(today, 1), time)
  return startTime
}

function nextWeekdayStart(nowMs, weekday, time) {
  const today = beijingDate(nowMs)
  let daysAhead = (weekday - today.weekday + 7) % 7
  let startTime = beijingEpochSeconds(addDays(today, daysAhead), time)
  if (startTime <= Math.floor(nowMs / 1000)) {
    daysAhead += 7
    startTime = beijingEpochSeconds(addDays(today, daysAhead), time)
  }
  return startTime
}

function buildCalendarEntries(raw, nowMs = Date.now()) {
  const setting = sanitizeWaterReminder(raw)
  if (!setting.enabled) return []
  const times = reminderTimes(setting)
  const repeatEndTime = beijingEpochSeconds(addDays(beijingDate(nowMs), CALENDAR_REPEAT_DAYS), '23:59')
  const description = '来自“每天怎么吃”的可选喝水提醒。修改或关闭小程序设置不会自动删除此日历事项。'
  if (setting.cadence === 'daily') {
    return times.map((time) => ({
      key: `daily:${time}`,
      label: `每日 ${time}`,
      options: {
        title: '喝水提醒',
        startTime: nextDailyStart(nowMs, time),
        description,
        alarm: true,
        alarmOffset: 0,
        repeatInterval: 'day',
        repeatEndTime,
      },
    }))
  }
  return times.flatMap((time) => WEEKDAYS.map((weekday) => ({
    key: `weekday:${weekday}:${time}`,
    label: `${WEEKDAY_LABELS[weekday]} ${time}`,
    options: {
      title: '喝水提醒',
      startTime: nextWeekdayStart(nowMs, weekday, time),
      description,
      alarm: true,
      alarmOffset: 0,
      repeatInterval: 'week',
      repeatEndTime,
    },
  })))
}

function callAddPhoneRepeatCalendar(wxApi, options) {
  return new Promise((resolve, reject) => {
    try {
      wxApi.addPhoneRepeatCalendar({ ...options, success: resolve, fail: reject })
    } catch (error) { reject(error) }
  })
}

function isPermissionDenied(error) {
  const message = String(error && (error.errMsg || error.message) || '')
  return /auth deny|authorize.*deny|permission.*denied|user deny|用户拒绝/i.test(message)
}

function canUseRepeatCalendar(wxApi) {
  if (!wxApi || typeof wxApi.addPhoneRepeatCalendar !== 'function') return false
  if (typeof wxApi.canIUse !== 'function') return true
  try { return wxApi.canIUse('addPhoneRepeatCalendar') !== false } catch (_) { return false }
}

async function installCalendarEntries(wxApi, entries, onProgress, options = {}) {
  if (!canUseRepeatCalendar(wxApi)) {
    const error = new Error('当前微信版本不支持添加重复日历，请更新微信后重试')
    error.code = 'CALENDAR_API_UNAVAILABLE'
    throw error
  }
  const list = Array.isArray(entries) ? entries : []
  const shouldContinue = typeof options.shouldContinue === 'function' ? options.shouldContinue : () => true
  const result = {
    total: list.length, created: 0, failed: 0, skipped: 0,
    permissionDenied: false, cancelled: false, failures: [],
  }
  for (let index = 0; index < list.length; index += 1) {
    if (!shouldContinue()) {
      result.cancelled = true
      result.skipped += list.length - index
      if (typeof onProgress === 'function') onProgress({ ...result, completed: index })
      break
    }
    const entry = list[index]
    try {
      await callAddPhoneRepeatCalendar(wxApi, entry.options)
      result.created += 1
    } catch (error) {
      result.failed += 1
      result.failures.push({ key: entry.key, label: entry.label, message: String(error && (error.errMsg || error.message) || '添加失败') })
      if (isPermissionDenied(error)) {
        result.permissionDenied = true
        result.skipped = list.length - index - 1
        if (typeof onProgress === 'function') onProgress({ ...result, completed: index + 1 })
        break
      }
    }
    if (typeof onProgress === 'function') onProgress({ ...result, completed: index + 1 })
  }
  return result
}

module.exports = {
  CALENDAR_REPEAT_DAYS,
  WEEKDAYS,
  reminderTimes,
  buildCalendarEntries,
  canUseRepeatCalendar,
  installCalendarEntries,
  isPermissionDenied,
}
