'use strict'

const assert = require('assert')
const Module = require('module')

let memberReadError = null
let transactionError = null

function collection(name) {
  return {
    doc() {
      return {
        async get() {
          if (name === 'meal_members') {
            if (memberReadError) {
              const error = memberReadError
              memberReadError = null
              throw error
            }
            return { data: { status: 'active' } }
          }
          return { data: null }
        },
      }
    },
    where() { return { limit() { return { async get() { return { data: [] } } } } } },
  }
}

const database = {
  command: { inc: (value) => ({ value }) },
  collection,
  serverDate() { return { $serverDate: true } },
  async runTransaction() {
    if (transactionError) {
      const error = transactionError
      transactionError = null
      throw error
    }
    throw new Error('unexpected transaction execution')
  },
}

const cloudStub = {
  DYNAMIC_CURRENT_ENV: 'dynamic-current-env',
  init() {},
  database() { return database },
  getWXContext() { return { OPENID: 'test-user' } },
}

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloudStub
  return originalLoad.call(this, request, parent, isMain)
}
let auth
try { auth = require('./index') } finally { Module._load = originalLoad }

async function tests() {
  const privateDetail = 'private database detail must not escape'
  transactionError = Object.assign(new Error(privateDetail), { code: 'PRIVATE_DATABASE_FAILURE' })
  const unknown = await auth.main({ action: 'login' })
  assert.deepStrictEqual(unknown, {
    success: false,
    code: 'AUTH_FAILED',
    message: '账号服务暂时不可用',
  })
  assert.strictEqual(JSON.stringify(unknown).includes(privateDetail), false)

  memberReadError = Object.assign(new Error(privateDetail), { code: 'MEMBERSHIP_REQUIRED' })
  const known = await auth.main({ action: 'login' })
  assert.deepStrictEqual(known, {
    success: false,
    code: 'MEMBERSHIP_REQUIRED',
    message: '需要有效邀请才能使用',
  })
  assert.strictEqual(JSON.stringify(known).includes(privateDetail), false)

  const validation = await auth.main({ action: 'updateProfile', profile: { nickname: '' } })
  assert.deepStrictEqual(validation, {
    success: false,
    code: 'AUTH_REQUEST_INVALID',
    message: '请填写昵称',
  })

  console.log('auth public error boundary tests passed')
}

tests().catch((error) => { console.error(error); process.exitCode = 1 })
