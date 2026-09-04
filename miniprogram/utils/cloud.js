const PUBLIC_ERROR = Symbol('publicCloudError')
const PUBLIC_STAGES = new Set([
  'PREFLIGHT', 'STORAGE_PROBE',
  'START_TRANSACTION_BEGIN', 'START_TRANSACTION_READ', 'START_TRANSACTION_VALIDATE',
  'START_TRANSACTION_WRITE', 'START_TRANSACTION_COMMIT',
  'STATUS_TRANSACTION_BEGIN', 'STATUS_TRANSACTION_READ', 'STATUS_TRANSACTION_VALIDATE',
  'STATUS_TRANSACTION_WRITE', 'STATUS_TRANSACTION_COMMIT',
  'STATUS_READ_MEMBER', 'STATUS_READ_TASK', 'STATUS_READ_STATE', 'STATUS_READ_CONTROL',
  'STATUS_STATE_MIGRATE', 'STATUS_PUBLIC_PROJECT',
  'ADVANCE_CLAIM', 'ADVANCE_EXECUTE', 'ADVANCE_SETTLE_SUCCESS', 'ADVANCE_SETTLE_FAILURE',
  'UNKNOWN',
])

function publicError(code, message, stage) {
  const error = new Error(message)
  error.code = code
  if (PUBLIC_STAGES.has(stage)) error.stage = stage
  error[PUBLIC_ERROR] = true
  return error
}

function transportText(error) {
  return `${error && error.errCode || ''} ${error && error.errMsg || ''} ${error && error.message || ''}`.toLowerCase()
}

function safeTransportError(error) {
  if (error && error[PUBLIC_ERROR]) return error
  const text = transportText(error)
  if (/function_not_found|functionname.+not be found|-501000/.test(text)) {
    return publicError('CLOUD_FUNCTION_NOT_DEPLOYED', '服务尚未准备好，请稍后再试')
  }
  if (/timeout|timed out|超时/.test(text)) {
    return publicError('CLOUD_TIMEOUT', '云服务响应超时，请稍后重试')
  }
  if (/network|request:fail|connection|offline|网络/.test(text)) {
    return publicError('NETWORK_UNAVAILABLE', '网络连接不可用，请检查网络后重试')
  }
  return publicError('CLOUD_TRANSPORT_FAILED', '云服务暂时不可用，请稍后重试')
}

function callFunction(name, action, payload = {}) {
  if (!wx.cloud) return Promise.reject(publicError('CLOUD_UNSUPPORTED', '当前微信版本不支持云开发，请更新微信后重试'))
  return wx.cloud.callFunction({ name, data: { action, ...payload } })
    .then(({ result }) => {
      if (!result || result.success !== true) {
        throw publicError(
          result && result.code || 'CLOUD_FUNCTION_FAILED',
          result && result.message || '云服务暂时不可用，请稍后重试',
          result && result.stage,
        )
      }
      return result.data
    })
    .catch((error) => { throw safeTransportError(error) })
}

function wxLogin() {
  return new Promise((resolve, reject) => wx.login({
    success: resolve,
    fail: (error) => reject(safeTransportError(error)),
  }))
}

module.exports = { callFunction, wxLogin, safeTransportError }
