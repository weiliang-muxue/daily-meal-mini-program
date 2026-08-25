const { cloudEnvId } = require('./config')
const { authStore } = require('./services/auth-store')
const { userStore } = require('./services/user-store')
const { membershipStore } = require('./services/membership-store')

App({
  globalData: { cloudReady: false },

  onLaunch() {
    if (!wx.cloud) {
      console.error('当前基础库不支持云开发')
      return
    }
    const env = cloudEnvId && !cloudEnvId.startsWith('YOUR_') ? cloudEnvId : undefined
    wx.cloud.init({ env, traceUser: true })
    this.globalData.cloudReady = true
    membershipStore.init().then((member) => {
      if (!member || member.status !== 'active') return null
      return authStore.init().then(() => userStore.init())
    }).catch(() => {})
  },
})
