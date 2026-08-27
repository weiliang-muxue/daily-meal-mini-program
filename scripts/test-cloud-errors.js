'use strict'

const assert = require('assert')
const path = require('path')

const cloudPath = path.resolve(__dirname, '..', 'miniprogram', 'utils', 'cloud.js')

function loadWithWx(mockWx) {
  global.wx = mockWx
  delete require.cache[cloudPath]
  return require(cloudPath)
}

async function rejected(promise) {
  try { await promise } catch (error) { return error }
  throw new Error('Expected promise to reject')
}

async function run() {
  const internalMessage = 'cloud.callFunction:fail Error: errCode: -501000 | errMsg: FunctionName parameter could not be found. callId: TEST_PRIVATE_CALL_ID https://internal.invalid/error'
  let api = loadWithWx({
    cloud: { callFunction: () => Promise.reject({ errCode: -501000, errMsg: internalMessage }) },
    login() {},
  })
  let error = await rejected(api.callFunction('membership', 'status'))
  assert.strictEqual(error.code, 'CLOUD_FUNCTION_NOT_DEPLOYED')
  assert.strictEqual(error.message, '云服务尚未部署完成，请联系管理员后重试')
  assert(!/callId|https?:|FunctionName|-501000/.test(error.message), '底层云错误不得显示给用户')

  api = loadWithWx({
    cloud: { callFunction: () => Promise.reject({ errMsg: 'request:fail network unavailable' }) },
    login() {},
  })
  error = await rejected(api.callFunction('membership', 'status'))
  assert.strictEqual(error.code, 'NETWORK_UNAVAILABLE')
  assert(!/request:fail/.test(error.message))

  api = loadWithWx({
    cloud: { callFunction: () => Promise.resolve({ result: { success: false, code: 'INVITE_EXPIRED', message: '邀请码已过期' } }) },
    login() {},
  })
  error = await rejected(api.callFunction('membership', 'acceptInvite'))
  assert.strictEqual(error.code, 'INVITE_EXPIRED')
  assert.strictEqual(error.message, '邀请码已过期', '云函数返回的受控业务提示必须保留')

  api = loadWithWx({
    cloud: {},
    login({ fail }) { fail({ errMsg: 'login:fail timeout with internal detail' }) },
  })
  error = await rejected(api.wxLogin())
  assert.strictEqual(error.code, 'CLOUD_TIMEOUT')
  assert(!/internal detail/.test(error.message))

  api = loadWithWx({ login() {} })
  error = await rejected(api.callFunction('membership', 'status'))
  assert.strictEqual(error.code, 'CLOUD_UNSUPPORTED')

  console.log('cloud error boundary tests passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
