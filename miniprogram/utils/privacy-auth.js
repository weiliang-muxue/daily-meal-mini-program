'use strict'

const { LEGAL_CONSENT_VERSION } = require('./legal-consent')
const LOCAL_PRIVACY_PATH = '/pages/legal/privacy'
const USER_AGREEMENT_PATH = '/pages/legal/user-agreement'
const LEGAL_DOCUMENT_READY_EVENT = 'legalDocumentReady'

function currentWx(wxApi) {
  if (wxApi) return wxApi
  return typeof wx === 'undefined' ? null : wx
}

function invoke(wxApi, method, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (handler) => (result) => {
      if (settled) return
      settled = true
      handler(result || {})
    }
    try {
      wxApi[method]({ ...options, success: finish(resolve), fail: finish(reject) })
    } catch (error) {
      finish(reject)(error)
    }
  })
}

async function getPrivacyAuthorizationState(wxApi) {
  const api = currentWx(wxApi)
  const supported = Boolean(api
    && typeof api.getPrivacySetting === 'function'
    && typeof api.requirePrivacyAuthorize === 'function')
  if (!supported) {
    return { supported: false, needAuthorization: false, authorized: true, legacy: true }
  }

  try {
    const setting = await invoke(api, 'getPrivacySetting')
    const needAuthorization = Boolean(setting.needAuthorization)
    return {
      supported: true,
      needAuthorization,
      authorized: !needAuthorization,
      privacyContractName: typeof setting.privacyContractName === 'string' ? setting.privacyContractName : '',
    }
  } catch (_) {
    return {
      supported: true,
      needAuthorization: null,
      authorized: false,
      code: 'PRIVACY_SETTING_UNAVAILABLE',
      message: '暂时无法确认隐私授权状态，请重试或先查看《隐私保护指引》。',
    }
  }
}

async function ensurePrivacyAuthorized(wxApi) {
  const api = currentWx(wxApi)
  const state = await getPrivacyAuthorizationState(api)
  if (!state.supported || state.authorized) return state
  if (state.needAuthorization !== true) return state

  try {
    await invoke(api, 'requirePrivacyAuthorize')
    return { ...state, needAuthorization: false, authorized: true }
  } catch (_) {
    return {
      ...state,
      authorized: false,
      code: 'PRIVACY_AUTHORIZATION_REJECTED',
      message: '你尚未完成微信隐私授权，当前操作未继续。请重试授权，或先查看《隐私保护指引》。',
    }
  }
}

function notifyDocumentRead(options, document) {
  if (typeof options.onRead !== 'function') return
  try { options.onRead({ document, version: LEGAL_CONSENT_VERSION }) } catch (_) {}
}

// Navigation alone does not prove that the local text was displayed: require
// both navigation success and the legal page's initial-render callback.
async function navigateTo(wxApi, url, document, options = {}) {
  const api = currentWx(wxApi)
  if (!api || typeof api.navigateTo !== 'function') {
    return { navigated: false, url }
  }
  let navigated = false
  let ready = false
  let reported = false
  const report = () => {
    if (!navigated || !ready || reported) return
    reported = true
    notifyDocumentRead(options, document)
  }
  try {
    await invoke(api, 'navigateTo', {
      url,
      events: {
        [LEGAL_DOCUMENT_READY_EVENT]: (detail) => {
          if (!detail || detail.document !== document || detail.version !== LEGAL_CONSENT_VERSION) return
          ready = true
          report()
        },
      },
    })
    navigated = true
    report()
    return { navigated: true, url }
  } catch (_) {
    return { navigated: false, url }
  }
}

function navigateToUserAgreement(wxApi, options = {}) {
  return navigateTo(wxApi, USER_AGREEMENT_PATH, 'agreement', options)
}

function navigateToLocalPrivacy(wxApi, options = {}) {
  return navigateTo(wxApi, LOCAL_PRIVACY_PATH, 'privacy', options)
}

function reportLegalDocumentReady(page, document) {
  if (!['privacy', 'agreement'].includes(document)) return false
  try {
    const channel = page && typeof page.getOpenerEventChannel === 'function' && page.getOpenerEventChannel()
    if (!channel || typeof channel.emit !== 'function') return false
    channel.emit(LEGAL_DOCUMENT_READY_EVENT, { document, version: LEGAL_CONSENT_VERSION })
    return true
  } catch (_) { return false }
}

async function openPrivacyContractOrLocal(wxApi, options = {}) {
  const api = currentWx(wxApi)
  if (api && typeof api.openPrivacyContract === 'function') {
    try {
      await invoke(api, 'openPrivacyContract')
      notifyDocumentRead(options, 'privacy')
      return { openedPlatformContract: true, usedLocalFallback: false }
    } catch (_) {}
  }

  const hasCustomFallback = typeof options.onFallback === 'function'
  const fallback = hasCustomFallback ? options.onFallback : () => navigateToLocalPrivacy(api, options)
  try {
    const fallbackResult = await fallback()
    const fallbackFailed = fallbackResult === false
      || Boolean(fallbackResult && fallbackResult.usedLocalFallback === false)
      || Boolean(fallbackResult && fallbackResult.navigated === false)
    if (!fallbackFailed && (hasCustomFallback || (fallbackResult && fallbackResult.navigated === true))) {
      return { openedPlatformContract: false, usedLocalFallback: true }
    }
  } catch (_) {}

  return {
    openedPlatformContract: false,
    usedLocalFallback: false,
    error: '微信平台《隐私保护指引》和本地隐私说明均暂时无法打开，请稍后重试。',
  }
}

module.exports = {
  LOCAL_PRIVACY_PATH,
  USER_AGREEMENT_PATH,
  ensurePrivacyAuthorized,
  getPrivacyAuthorizationState,
  navigateToLocalPrivacy,
  navigateToUserAgreement,
  openPrivacyContractOrLocal,
  reportLegalDocumentReady,
}
