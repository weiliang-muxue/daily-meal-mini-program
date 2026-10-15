'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../miniprogram/services/auth-store.js'), 'utf8')
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture() {
  const requests = [], cached = new Map(), listeners = new Set()
  const member = { cacheNamespace: 'a'.repeat(32), onCacheNamespaceChange(fn) { listeners.add(fn); return () => listeners.delete(fn) } }
  const exports = { exports: {} }
  vm.runInNewContext(source, { module: exports, require(name) {
    if (name === './membership-store') return { membershipStore: member }
    if (name === '../utils/cloud') return { wxLogin: async () => ({}), callFunction(name, action) {
      const request = deferred(); requests.push({ action, ...request }); return request.promise
    } }
    if (name === './retired-phone-data') return require('../miniprogram/services/retired-phone-data')
    throw Error('Unexpected import')
  }, wx: { getStorageSync: key => cached.get(key), setStorageSync: (key, value) => cached.set(key, value) } })
  return { store: exports.exports.authStore, requests, cached,
    async tick() { await new Promise(resolve => setImmediate(resolve)) } }
}

for (const action of ['updateProfile']) {
  test('late login cannot replace a completed ' + action + ' in memory or cache', async () => {
    const f = fixture(), reading = f.store.init()
    await f.tick()
    const writing = f.store.updateProfile({ nickname: 'new' })
    const saved = { nickname: 'saved' }
    f.requests[1].resolve(saved); await writing
    f.requests[0].resolve({ nickname: 'stale', phoneBound: false }); await reading
    assert.equal(f.store.profile, saved)
    assert.equal([...f.cached.values()][0], saved)
    assert.equal(f.store.state, 'ready')
  })
}

for (const fail of [false, true]) {
  test('newer forced login survives an older ' + (fail ? 'failure' : 'success'), async () => {
    const f = fixture(), old = f.store.init()
    await f.tick()
    const latest = f.store.init({ force: true }); await f.tick()
    const fresh = { nickname: 'latest' }
    f.requests[1].resolve(fresh); await latest
    if (fail) f.requests[0].reject(Error('old network failure'))
    else f.requests[0].resolve({ nickname: 'old' })
    await old
    assert.equal(f.store.profile, fresh)
    assert.equal(f.store.state, 'ready')
    assert.equal(f.store.error, '')
  })
}

test('login started during a profile write cannot later replace the saved result', async () => {
  const f = fixture(), writing = f.store.updateProfile({ nickname: 'new' })
  const reading = f.store.init(); await f.tick()
  const saved = { nickname: 'saved' }
  f.requests[0].resolve(saved); await writing
  f.requests[1].resolve({ nickname: 'stale' }); await reading
  assert.equal(f.store.profile, saved)
})

test('a failed profile write does not leave a valid pending refresh stuck connecting', async () => {
  const f = fixture(), reading = f.store.init()
  await f.tick()
  const writing = f.store.updateProfile({ nickname: 'not-saved' })
  const rejected = assert.rejects(writing, /synthetic failure/)
  f.requests[1].reject(Error('synthetic failure')); await rejected
  const confirmed = { nickname: 'server-confirmed' }
  f.requests[0].resolve(confirmed)
  assert.equal(await reading, confirmed)
  assert.equal(f.store.state, 'ready')
})
