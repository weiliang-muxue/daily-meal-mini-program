'use strict'

const cloud = require('wx-server-sdk')
const { createService } = require('./service')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const service = createService({ db: cloud.database(), send: (data) => cloud.openapi.subscribeMessage.send(data) })
const MESSAGES = {
  MEMBERSHIP_REQUIRED: '请先完成成员验证', STALE_DATA_GENERATION: '账号已变化，请重新进入',
  LEGAL_CONSENT_REQUIRED: '请先阅读并同意当前协议', WATER_NOT_CONFIGURED: '微信消息提醒暂未开通',
  WATER_SCHEDULE_REQUIRED: '请先开启并保存提醒时间', WATER_INTENT_INVALID: '本次授权已过期，请刷新后重新订阅',
  WATER_SCHEMA_UNSUPPORTED: '提醒数据版本较新，请更新小程序', INVALID_ACTION: '暂不支持此操作',
}

exports.main = async (event = {}) => {
  const context = cloud.getWXContext() || {}
  try {
    // Trusted context, never event.Type/event.SOURCE or a user-selected recipient.
    if (context.SOURCE === 'wx_trigger' && !context.OPENID) return { success: true, data: await service.tick() }
    if (!context.OPENID || context.SOURCE === 'wx_trigger') return { success: false, code: 'MEMBERSHIP_REQUIRED', message: MESSAGES.MEMBERSHIP_REQUIRED }
    return { success: true, data: await service.action(context.OPENID, event.cacheNamespace, event) }
  } catch (error) {
    const code = Object.prototype.hasOwnProperty.call(MESSAGES, error && error.code) ? error.code : 'WATER_UNAVAILABLE'
    return { success: false, code, message: MESSAGES[code] || '微信提醒服务暂时不可用，请稍后重试' }
  }
}
