const PUBLIC_ERROR = Symbol('publicCloudError')

function publicError(code, message) {
  const error = new Error(message)
  error.code = code
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
    return publicError('CLOUD_FUNCTION_NOT_DEPLOYED', '云服务尚未部署完成，请联系管理员后重试')
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
