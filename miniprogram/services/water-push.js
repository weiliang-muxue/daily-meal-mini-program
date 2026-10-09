'use strict'
const { callFunction } = require('../utils/cloud')
const { membershipStore } = require('./membership-store')
const { sanitizeWaterReminder } = require('./user-state-core')

function reminderTimes(raw) {
  const value = sanitizeWaterReminder(raw)
  const minute = (text) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3))
  const times = []
  for (let m = minute(value.startTime); m <= minute(value.endTime); m += value.intervalMinutes) {
    times.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
  }
  return times
}
function request(action, payload = {}, namespace = membershipStore.cacheNamespace) {
  if (!namespace || namespace !== membershipStore.cacheNamespace || !membershipStore.verifiedInRuntime) return Promise.reject(new Error('账号已变化，请重新进入'))
  return callFunction('waterReminder', action, { ...payload, cacheNamespace: namespace }).then((result) => {
    if (namespace !== membershipStore.cacheNamespace) throw new Error('账号已变化，请重新进入')
    return result
  })
}
function presentation(state) {
  if (!state || !state.ready) return { title: '微信消息提醒暂未开通', detail: '需要管理员完成消息模板配置。可以先保存提醒时间。', next: '' }
  const errors = {
    rejected: '微信未授予可用的发送次数，请重新订阅后继续。',
    unknown: '上次发送结果未确认，已暂停以避免重复。请重新订阅后继续。',
    failed: '上次发送失败，已暂停推送。持续失败请联系管理员。',
  }
  return { title: state.enabled ? '微信提醒已开启' : '微信提醒未开启',
    detail: errors[state.lastOutcome] || (state.type === 'longterm' ? '使用长期订阅；授权后按已保存时段提醒，关闭后停止后续发送。'
      : `已登记 ${Math.max(0, Number(state.remaining) || 0)} 次待提醒。每次允许只增加一次，以微信实际授权为准；用完需再次订阅。`),
    next: state.enabled && Number.isFinite(state.nextAt) && state.nextAt > 0
      ? `下次计划：${new Date(state.nextAt + 8 * 3600000).toISOString().slice(5, 16).replace('T', ' ')}（北京时间）` : '' }
}
module.exports = { request, presentation, reminderTimes }
