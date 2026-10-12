'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/profile/profile.js'), 'utf8')
const copy = value => JSON.parse(JSON.stringify(value))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture() {
  let definition, deadUpdates = 0
  const namespaceListeners = new Set(), memberListeners = new Set(), writes = [], toasts = []
  const member = { cacheNamespace: 'a'.repeat(32), member: { status: 'active', role: 'member' },
    init: async () => member.member,
    onMembershipChange(fn) { memberListeners.add(fn); return () => memberListeners.delete(fn) },
    onCacheNamespaceChange(fn) { namespaceListeners.add(fn); return () => namespaceListeners.delete(fn) } }
  const auth = { profile: { nickname: '虚构旧昵称', avatarUrl: 'saved-avatar' }, state: 'ready',
    init: async () => auth.profile,
    updateProfile: async payload => { writes.push(copy(payload)); return { nickname: payload.nickname, avatarUrl: 'saved-new-avatar' } },
    bindPhoneNumber: async () => ({ nickname: '虚构旧昵称', maskedPhone: '****0000' }) }
  const image = { prepare: async () => ({ synthetic: true }) }
  const privacy = { query: async () => ({ supported: true, authorized: true }) }
  const store = { data: { settings: {}, updatedAt: '' }, init: async () => store.data }
  const modules = { '../../services/auth-store': { authStore: auth }, '../../services/user-store': { userStore: store },
    '../../services/membership-store': { membershipStore: member }, '../../utils/date': { formatUpdatedAt: () => '' },
    '../../utils/cloud': {}, '../../services/private-cache': {},
    '../../utils/private-image': { MAX_AVATAR_BYTES: 1024 * 1024, privateImagePayload: (...args) => image.prepare(...args) },
    '../../utils/privacy-auth': { getPrivacyAuthorizationState: () => privacy.query() } }
  vm.runInNewContext(source, { Page: value => { definition = value }, require(name) {
    if (!Object.hasOwn(modules, name)) throw Error('Unexpected import ' + name)
    return modules[name]
  }, wx: { showLoading() {}, hideLoading() {}, showToast: value => toasts.push(value), reLaunch() {} } })
  const page = { ...definition, data: copy(definition.data), setData(patch) {
    if (this.memberManagementUnloaded) deadUpdates++
    Object.assign(this.data, patch)
  } }
  page.data.profileLoading = false
  page.watchMemberManagement()
  page.render()
  return { page, auth, member, image, privacy, store, writes, toasts, deadUpdates: () => deadUpdates,
    switchIdentity(namespace = 'b'.repeat(32)) {
      const previous = member.cacheNamespace
      member.cacheNamespace = namespace; auth.profile = null
      namespaceListeners.forEach(fn => fn(namespace, previous))
      memberListeners.forEach(fn => fn(member.member))
    } }
}

test('identity change during avatar preparation cannot submit the old draft for the new member', async () => {
  const f = fixture(), imageRead = deferred()
  f.image.prepare = () => imageRead.promise
  f.page.onChooseAvatar({ detail: { avatarUrl: 'synthetic-local-avatar' } })
  f.page.onNicknameInput({ detail: { value: '虚构旧身份草稿' } })
  const pending = f.page.saveProfile()
  f.switchIdentity()
  imageRead.resolve({ synthetic: true }); await pending
  assert.equal(f.writes.length, 0)
  assert.equal(f.page.data.avatarLocalPath, '')
  assert.equal(f.page.data.nickname, '')
  assert.equal(f.toasts.length, 0)
})

test('returning to the same namespace does not revive an invalidated avatar save', async () => {
  const f = fixture(), read = deferred()
  f.image.prepare = () => read.promise
  f.page.onChooseAvatar({ detail: { avatarUrl: 'synthetic-local-avatar' } })
  const pending = f.page.saveProfile()
  f.switchIdentity(); f.switchIdentity('a'.repeat(32))
  read.resolve({ synthetic: true }); await pending
  assert.equal(f.writes.length, 0)
})

for (const failure of [false, true]) {
  test('late profile ' + (failure ? 'failure' : 'success') + ' cannot update an unloaded page', async () => {
    const f = fixture(), save = deferred()
    f.auth.updateProfile = () => save.promise
    const pending = f.page.saveProfile()
    f.page.onUnload()
    if (failure) save.reject(Error('synthetic failure'))
    else save.resolve({ nickname: 'late', avatarUrl: 'late' })
    await pending
    assert.equal(f.deadUpdates(), 0)
    assert.equal(f.toasts.length, 0)
  })
}

test('late phone binding does not display the previous member after an identity change', async () => {
  const f = fixture(), phone = deferred()
  f.auth.bindPhoneNumber = () => phone.promise
  const pending = f.page.onGetPhoneNumber({ detail: { code: 'synthetic-once-code' } })
  f.switchIdentity(); phone.resolve({ nickname: 'old', maskedPhone: '****0000' }); await pending
  assert.deepEqual(copy(f.page.data.profile), {})
  assert.equal(f.page.data.bindingPhone, false)
  assert.equal(f.toasts.length, 0)
})

test('same-member redraw preserves drafts and successful save clears them', async () => {
  const f = fixture()
  f.page.onNicknameInput({ detail: { value: '虚构草稿' } })
  f.page.onChooseAvatar({ detail: { avatarUrl: 'synthetic-local-avatar' } })
  f.page.onHide(); f.page.onShow()
  assert.equal(f.page.data.nickname, '虚构草稿')
  assert.equal(f.page.data.avatarLocalPath, 'synthetic-local-avatar')
  await f.page.saveProfile()
  assert.equal(f.writes.length, 1)
  assert.equal(f.page.data.avatarLocalPath, '')
  assert.equal(f.page.data.saving, false)
})

test('late profile connection failure cannot replace the result of a newer retry', async () => {
  const f = fixture(), first = deferred()
  f.auth.init = () => first.promise
  const pending = f.page.connect()
  await new Promise(resolve => setImmediate(resolve))
  f.auth.init = async () => f.auth.profile
  await f.page.connect(true)
  first.reject(Error('old request failure')); await pending
  assert.equal(f.page.data.authState, 'ready')
  assert.equal(f.toasts.length, 0)
})

test('late privacy query cannot update an unloaded profile', async () => {
  const f = fixture(), privacy = deferred()
  f.privacy.query = () => privacy.promise
  const pending = f.page.checkAvatarPrivacy()
  f.page.onUnload(); privacy.resolve({ supported: true, authorized: true }); await pending
  assert.equal(f.deadUpdates(), 0)
})

test('phone visibility recovery refresh works even when login itself is ready', async () => {
  const f = fixture(), calls = []
  f.page.connect = async force => { calls.push(force) }
  f.page.data.authState = 'ready'
  f.page.data.phoneVisibilityError = '设置暂未确认，请刷新资料核对后重试'
  await f.page.retryLogin()
  assert.deepEqual(calls, [true])
  f.page.data.profileLoading = true
  await f.page.retryLogin()
  assert.equal(calls.length, 1)
})
