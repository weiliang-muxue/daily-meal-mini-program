'use strict'

const assert = require('assert')
const path = require('path')
const root = path.resolve(__dirname, '..')
const storage = new Map()
const clone = value => JSON.parse(JSON.stringify(value))
global.wx = { getStorageSync: key => clone(storage.get(key) || null),
  setStorageSync: (key, value) => storage.set(key, clone(value)) }
let handler
const cloudPath = path.join(root, 'miniprogram/utils/cloud.js')
require.cache[cloudPath] = { id: cloudPath, filename: cloudPath, loaded: true,
  exports: { callFunction: (...args) => handler(...args) } }
const { UserStore, defaults, hasPending } = require('../miniprogram/services/user-store')
const namespace = 'a'.repeat(32)
const pendingKey = `meal_user_pending_v1_${namespace}`
function create() {
  storage.clear()
  const member = { cacheNamespace: namespace, onCacheNamespaceChange: () => () => {} }
  const store = new UserStore(member)
  store.bindNamespace()
  return store
}
const reminders = text => [{ id: 'synthetic-reminder', text, done: false }]
const oldState = () => ({ ...defaults(), schemaVersion: 8, stateRevision: 3, customReminders: reminders('虚构旧提醒') })

async function run() {
  let store = create()
  let writes = 0
  handler = async (_name, action) => {
    if (action !== 'bootstrap') writes += 1
    return oldState()
  }
  await store.init()
  assert.deepStrictEqual(store.data.customReminders, reminders('虚构旧提醒'), 'old data remains readable')
  assert.notStrictEqual(store.state, 'ready', 'local migration must not advertise server compatibility')
  await assert.rejects(store.patch({ customReminders: reminders('虚构待保存提醒') }, { immediate: true }),
    error => error.code === 'STATE_SERVICE_UPGRADE_REQUIRED')
  assert.strictEqual(writes, 0, 'known old service must not receive new-schema writes')
  assert(hasPending(store.pending))
  assert.deepStrictEqual(storage.get(pendingKey).fields.customReminders, reminders('虚构待保存提醒'))
  for (const action of [() => store.confirmDraft('draft'), () => store.discardDraft('draft'),
    () => store.restoreHistory('history'), () => store.confirmMealReplacement('draft', 3),
    () => store.changeFavorite('addFavorite', { mealId: 'meal' }, 3)]) {
    await assert.rejects(action(), error => error.code === 'STATE_SERVICE_UPGRADE_REQUIRED')
  }
  assert.strictEqual(writes, 0)
  const restarted = new UserStore({ cacheNamespace: namespace, onCacheNamespaceChange: () => () => {} })
  await restarted.init()
  assert.strictEqual(writes, 0, 'reentry against old service must not flush the persisted queue')
  assert.deepStrictEqual(restarted.data.customReminders, reminders('虚构待保存提醒'))
  handler = async (_name, action, payload) => {
    if (action === 'bootstrap') return { ...defaults(), stateRevision: 3 }
    assert.strictEqual(action, 'saveState')
    writes += 1
    return { ...defaults(), ...payload.state, stateRevision: 4 }
  }
  await store.init({ force: true })
  assert.strictEqual(store.state, 'ready')
  assert.strictEqual(writes, 1)
  assert(!hasPending(store.pending))
  assert.deepStrictEqual(store.data.customReminders, reminders('虚构待保存提醒'))

  // An old response after a previously compatible read must not acknowledge
  // and erase local operations merely because the response can be migrated.
  store = create()
  store.replaceFromCloud({ ...defaults(), stateRevision: 3 })
  handler = async () => oldState()
  await assert.rejects(store.patch({ customReminders: reminders('虚构保留操作') }, { immediate: true }),
    error => error.code === 'STATE_SERVICE_UPGRADE_REQUIRED')
  assert.strictEqual(store.confirmedLocalRevision, 0)
  assert.deepStrictEqual(store.data.customReminders, reminders('虚构保留操作'))
  assert.deepStrictEqual(storage.get(pendingKey).fields.customReminders, reminders('虚构保留操作'))

  store = create()
  store.replaceFromCloud({ ...defaults(), stateRevision: 3 })
  let calls = 0
  handler = async (_name, action) => {
    if (action === 'bootstrap') return oldState()
    calls += 1
    const error = new Error('synthetic revision conflict')
    error.code = 'STATE_REVISION_CONFLICT'
    throw error
  }
  await assert.rejects(store.patch({ customReminders: reminders('虚构冲突操作') }, { immediate: true }),
    error => error.code === 'STATE_SERVICE_UPGRADE_REQUIRED')
  assert.strictEqual(calls, 1, 'old bootstrap during conflict must stop the second write')
  assert(hasPending(store.pending))

  for (const invoke of [store => store.confirmDraft('draft'), store => store.discardDraft('draft'),
    store => store.restoreHistory('history'), store => store.confirmMealReplacement('draft', 3),
    store => store.changeFavorite('addFavorite', { mealId: 'meal' }, 3)]) {
    store = create()
    store.replaceFromCloud({ ...defaults(), stateRevision: 3 })
    const before = clone(store.data)
    handler = async () => oldState()
    await assert.rejects(invoke(store), error => error.code === 'STATE_SERVICE_UPGRADE_REQUIRED')
    assert.deepStrictEqual(store.data, before, 'incompatible mutation response cannot replace displayed data')
    assert.strictEqual(store.state, 'offline')
  }

  // The observed server capability is per identity and never persisted as a
  // claimed capability for a different account or a new runtime.
  store.applyNamespace('b'.repeat(32))
  assert.strictEqual(store.cloudSchemaVersion, null)
  console.log('cloud schema transition: old reads, blocked writes, pending preservation and recovery passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
