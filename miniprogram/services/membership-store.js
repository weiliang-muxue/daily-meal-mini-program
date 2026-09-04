const { callFunction, wxLogin } = require('../utils/cloud')
const { reconcilePrivateCaches } = require('./private-cache')

function normalizeCacheNamespace(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) ? value : ''
}

function deletionRecoveryState(member, expectedCacheNamespace) {
  const expected = normalizeCacheNamespace(expectedCacheNamespace)
  const current = normalizeCacheNamespace(member && member.cacheNamespace)
  if (!expected) return 'unknown'
  if (member && member.status === 'deleting' && current === expected) return 'pending'
  if (member && member.status === 'invite_required' && !current) return 'completed'
  if (member && member.status === 'active' && current && current !== expected) return 'completed'
  return 'unknown'
}

function staleIdentityError() {
  const error = new Error('微信身份验证结果已过期，请重试')
  error.code = 'STALE_IDENTITY_RESPONSE'
  return error
}

class MembershipStore {
  constructor() {
    this.member = null
    this.cacheNamespace = ''
    this.state = 'idle'
    this.error = ''
    this.initPromise = null
    this.verifiedInRuntime = false
    this.namespaceListeners = new Set()
    this.identityRequestRevision = 0
  }

  init(options = {}) {
    if (this.member && this.verifiedInRuntime && !options.force) return Promise.resolve(this.member)
    if (this.initPromise && !options.force) return this.initPromise
    this.state = 'connecting'
    const requestRevision = ++this.identityRequestRevision
    const request = wxLogin()
      .then(() => callFunction('membership', 'status'))
      .then((member) => {
        if (requestRevision !== this.identityRequestRevision) throw staleIdentityError()
        return this.save(member)
      })
      .catch((error) => {
        if (requestRevision !== this.identityRequestRevision) throw error
        this.state = 'offline'
        this.error = error.message || '访问验证失败'
        if (!this.member || !this.verifiedInRuntime) throw error
        return this.member
      })
      .finally(() => { if (this.initPromise === request) this.initPromise = null })
    this.initPromise = request
    return request
  }

  save(member) {
    const previousNamespace = this.cacheNamespace
    const nextNamespace = normalizeCacheNamespace(member && member.cacheNamespace)
    this.member = member
    this.cacheNamespace = nextNamespace
    this.verifiedInRuntime = true
    this.state = 'ready'
    this.error = ''
    // An online status response is the authority for this device. Remove
    // caches from older identity generations (and v0.1 global caches) while
    // retaining only the currently verified namespace.
    try { reconcilePrivateCaches(nextNamespace) } catch (_) {}
    if (previousNamespace !== nextNamespace) {
      this.namespaceListeners.forEach((listener) => {
        try { listener(nextNamespace, previousNamespace) } catch (_) {}
      })
    }
    return member
  }

  onCacheNamespaceChange(listener) {
    if (typeof listener !== 'function') return () => {}
    this.namespaceListeners.add(listener)
    return () => this.namespaceListeners.delete(listener)
  }

  reset() {
    const previousNamespace = this.cacheNamespace
    this.identityRequestRevision += 1
    this.member = null
    this.cacheNamespace = ''
    this.verifiedInRuntime = false
    this.state = 'idle'
    this.error = ''
    this.initPromise = null
    if (previousNamespace) {
      this.namespaceListeners.forEach((listener) => {
        try { listener('', previousNamespace) } catch (_) {}
      })
    }
  }

  runIdentityAction(action, payload) {
    const requestRevision = ++this.identityRequestRevision
    return callFunction('membership', action, payload).then((member) => {
      if (requestRevision !== this.identityRequestRevision) throw staleIdentityError()
      return this.save(member)
    })
  }

  acceptInvite(code) { return this.runIdentityAction('acceptInvite', { code }) }
  createInvite(label) { return callFunction('membership', 'createInvite', { label }) }
  listMembers() { return callFunction('membership', 'listMembers') }
  revokeInvite(inviteRef) { return callFunction('membership', 'revokeInvite', { inviteRef }) }
  transferOwner(memberRef, confirmed) { return this.runIdentityAction('transferOwner', { memberRef, confirmed }) }
}

module.exports = { MembershipStore, deletionRecoveryState, membershipStore: new MembershipStore() }
