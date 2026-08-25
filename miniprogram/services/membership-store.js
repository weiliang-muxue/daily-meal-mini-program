const { callFunction, wxLogin } = require('../utils/cloud')

const CACHE_KEY = 'meal_membership_v1'

class MembershipStore {
  constructor() {
    this.member = null
    this.state = 'idle'
    this.error = ''
    this.initPromise = null
  }

  init(options = {}) {
    if (!this.member) this.member = wx.getStorageSync(CACHE_KEY) || null
    if (this.initPromise && !options.force) return this.initPromise
    this.state = 'connecting'
    const request = wxLogin()
      .then(() => callFunction('membership', 'status'))
      .then((member) => this.save(member))
      .catch((error) => {
        this.state = 'offline'
        this.error = error.message || '访问验证失败'
        if (!this.member) throw error
        return this.member
      })
      .finally(() => { if (this.initPromise === request) this.initPromise = null })
    this.initPromise = request
    return request
  }

  save(member) {
    this.member = member
    this.state = 'ready'
    this.error = ''
    wx.setStorageSync(CACHE_KEY, member)
    return member
  }

  acceptInvite(code) { return callFunction('membership', 'acceptInvite', { code }).then((member) => this.save(member)) }
  activateOwner(code) { return callFunction('membership', 'activateOwner', { code }).then((member) => this.save(member)) }
  createInvite(label) { return callFunction('membership', 'createInvite', { label }) }
  listMembers() { return callFunction('membership', 'listMembers') }
}

module.exports = { membershipStore: new MembershipStore() }
