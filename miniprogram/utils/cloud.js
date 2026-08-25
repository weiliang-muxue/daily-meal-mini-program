function callFunction(name, action, payload = {}) {
  if (!wx.cloud) return Promise.reject(new Error('当前微信版本不支持云开发'))
  return wx.cloud.callFunction({ name, data: { action, ...payload } }).then(({ result }) => {
    if (!result || result.success !== true) throw new Error(result && result.message || '云服务暂时不可用')
    return result.data
  })
}

function wxLogin() {
  return new Promise((resolve, reject) => wx.login({ success: resolve, fail: reject }))
}

module.exports = { callFunction, wxLogin }
