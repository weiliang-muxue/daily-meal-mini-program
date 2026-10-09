'use strict'
const assert = require('assert')
const fs = require('fs')
const vm = require('vm')
const path = require('path')
let context = {}, actions = [], ticks = 0, thrown = null
const cloud = { DYNAMIC_CURRENT_ENV: 'mock', init() {}, database: () => ({}),
  getWXContext: () => context, openapi: { subscribeMessage: { send() { throw Error('no real sends in test') } } } }
const service = { async tick() { ticks++; return { accepted: 0 } }, async action(...args) {
  actions.push(args); if (thrown) throw thrown; return { ready: false }
} }
const sandbox = { exports: {}, require: (name) => {
  if (name === 'wx-server-sdk') return cloud
  if (name === './service') return { createService: () => service }
  throw Error('unexpected import')
} }
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'), sandbox)
async function main() {
  const main = sandbox.exports.main
  assert.equal((await main({ Type: 'Timer', SOURCE: 'wx_trigger' })).success, false)
  assert.equal(ticks, 0)
  context = { SOURCE: 'wx_client', OPENID: 'synthetic-self' }
  assert.equal((await main({ action: 'status', owner: 'synthetic-other', cacheNamespace: 'synthetic-namespace', SOURCE: 'wx_trigger' })).success, true)
  assert.equal(ticks, 0); assert.equal(actions[0][0], 'synthetic-self'); assert.equal(actions[0][1], 'synthetic-namespace')
  context = { SOURCE: 'wx_trigger', OPENID: 'synthetic-self' }
  assert.equal((await main()).success, false); assert.equal(ticks, 0)
  context = { SOURCE: 'wx_trigger' }
  assert.equal((await main()).success, true); assert.equal(ticks, 1)
  context = { SOURCE: 'wx_client', OPENID: 'synthetic-self' }
  thrown = new Error('private SDK response must not escape')
  const failure = await main({ action: 'status' })
  assert.equal(failure.code, 'WATER_UNAVAILABLE'); assert(!JSON.stringify(failure).includes('private SDK'))
  thrown.code = 'WATER_NOT_CONFIGURED'
  assert.equal((await main({ action: 'status' })).code, 'WATER_NOT_CONFIGURED')
  console.log('water push entrypoint: trusted identity, timer isolation and error redaction passed (offline only)')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
