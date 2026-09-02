'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const pagePath = path.join(root, 'miniprogram/pages/access/access.js')
const membershipPath = path.join(root, 'miniprogram/services/membership-store.js')
const authPath = path.join(root, 'miniprogram/services/auth-store.js')
const userPath = path.join(root, 'miniprogram/services/user-store.js')
const privateCachePath = path.join(root, 'miniprogram/services/private-cache.js')
const cloudPath = path.join(root, 'miniprogram/utils/cloud.js')
const privacyPath = path.join(root, 'miniprogram/utils/privacy-auth.js')

function installDependencies(overrides = {}) {
  const membershipStore = {
    init: async () => null,
    acceptInvite: async () => ({}),
    ...(overrides.membershipStore || {}),
  }
  const authStore = { init: async () => {}, ...(overrides.authStore || {}) }
  const userStore = { init: async () => {}, ...(overrides.userStore || {}) }
  const deletionRecoveryState = (member, expected) => {
    const current = member && member.cacheNamespace || ''
    if (member && member.status === 'deleting' && current === expected) return 'pending'
    if (member && member.status === 'invite_required' && !current) return 'completed'
    if (member && member.status === 'active' && current && current !== expected) return 'completed'
    return 'unknown'
  }
  const clearPrivateCache = overrides.clearPrivateCache || (() => [])
  const callFunction = overrides.callFunction || (async () => ({}))
  const privacy = {
    navigateToUserAgreement: async () => ({}),
    openPrivacyContractOrLocal: async () => ({ openedPlatformContract: true, usedLocalFallback: false }),
  }
  ;[
    [membershipPath, { membershipStore, deletionRecoveryState }],
    [authPath, { authStore }],
    [userPath, { userStore }],
    [privateCachePath, { clearPrivateCache }],
    [cloudPath, { callFunction }],
    [privacyPath, privacy],
  ].forEach(([file, exports]) => {
    require.cache[file] = { id: file, filename: file, loaded: true, exports }
  })
  return { membershipStore, authStore, userStore }
}

function loadPage() {
  let definition
  global.Page = (value) => { definition = value }
  delete require.cache[pagePath]
  require(pagePath)
  assert(definition, 'access.js 必须注册 Page')
  const page = Object.create(definition)
  page.data = JSON.parse(JSON.stringify(definition.data))
  page.setData = (partial) => Object.assign(page.data, partial)
  return page
}

async function testIdentityFailureCanRecoverWithoutInvite() {
  const initCalls = []
  let active = false
  installDependencies({
    membershipStore: {
      async init(options) {
        initCalls.push(options)
        if (!active) throw new Error('云端暂时不可用')
        return { status: 'active' }
      },
    },
  })
  const switches = []
  global.wx = { switchTab: ({ url }) => switches.push(url) }
  const page = loadPage()

  await page.check()
  assert.strictEqual(page.data.loading, false)
  assert.strictEqual(page.data.showInviteForm, false)
  assert.strictEqual(page.data.checkError, '云端暂时不可用')
  assert.strictEqual(page.data.inviteError, '')

  active = true
  await page.retryCheck()
  assert.deepStrictEqual(initCalls, [{ force: false }, { force: true }])
  assert.deepStrictEqual(switches, ['/pages/plan/plan'])
  assert.strictEqual(page.data.checkError, '')
}

async function testUnregisteredIdentityOpensInviteForm() {
  installDependencies({ membershipStore: { init: async () => null } })
  global.wx = { switchTab() {} }
  const page = loadPage()
  await page.check()
  assert.strictEqual(page.data.loading, false)
  assert.strictEqual(page.data.showInviteForm, true)
  assert.strictEqual(page.data.checkError, '')
}

async function testIdentityAndInviteErrorsStaySeparate() {
  installDependencies({
    membershipStore: {
      init: async () => { throw new Error('身份检查失败') },
      acceptInvite: async () => { throw new Error('邀请码已失效') },
    },
  })
  global.wx = { switchTab() {} }
  const page = loadPage()
  await page.check()
  page.useInviteInstead()
  assert.strictEqual(page.data.showInviteForm, true)
  assert.strictEqual(page.data.checkError, '身份检查失败')

  await page.submit()
  assert.strictEqual(page.data.inviteError, '请输入邀请码')
  assert.strictEqual(page.data.checkError, '身份检查失败')

  page.inputCode({ detail: { value: ' ab cd ' } })
  assert.strictEqual(page.data.code, 'ABCD')
  assert.strictEqual(page.data.inviteError, '')
  await page.submit()
  assert.strictEqual(page.data.inviteError, '邀请码已失效')
  assert.strictEqual(page.data.checkError, '身份检查失败')
  assert.strictEqual(page.data.submitting, false)
}

async function testDeletingIdentityResumesWithoutInviteBypass() {
  const namespace = 'd'.repeat(32)
  const events = []
  let acceptCalls = 0
  const membershipStore = {
    member: null,
    cacheNamespace: '',
    state: 'idle',
    async init() {
      this.member = { status: 'deleting', cacheNamespace: namespace }
      this.cacheNamespace = namespace
      this.state = 'ready'
      return this.member
    },
    async acceptInvite() { acceptCalls += 1 },
    reset() {
      events.push('identity-reset')
      this.member = null
      this.cacheNamespace = ''
      this.state = 'idle'
    },
  }
  installDependencies({
    membershipStore,
    clearPrivateCache(actualNamespace) {
      assert.strictEqual(actualNamespace, namespace)
      events.push('cache-cleared')
      return []
    },
    async callFunction(name, action, payload) {
      events.push('cloud-called')
      assert.deepStrictEqual([name, action, payload], [
        'privacy', 'clearMyData', { expectedCacheNamespace: namespace },
      ])
      return { cleared: true }
    },
  })
  const toasts = []
  global.wx = {
    getStorageInfoSync: () => ({ keys: [] }),
    showToast: (options) => toasts.push(options),
    reLaunch: () => {},
    switchTab: () => {},
  }
  const page = loadPage()
  await page.check()
  assert.strictEqual(page.data.deletionRecovery, true)
  assert.strictEqual(page.data.showInviteForm, false)
  page.useInviteInstead()
  page.inputCode({ detail: { value: 'BYPASS-CODE' } })
  await page.submit()
  assert.strictEqual(page.data.showInviteForm, false)
  assert.strictEqual(acceptCalls, 0, '清理中的身份不能尝试邀请码绕过')

  await page.continueDeletion()
  assert.deepStrictEqual(events, ['cache-cleared', 'identity-reset', 'cloud-called'])
  assert(toasts.some((item) => item.title === '私人数据已清空'))
  assert.strictEqual(page.data.continuingDeletion, false)
}

async function testLostDeletionResponseUsesFreshMembershipState() {
  const namespace = 'e'.repeat(32)
  const events = []
  let statusChecks = 0
  const membershipStore = {
    member: { status: 'deleting', cacheNamespace: namespace },
    cacheNamespace: namespace,
    state: 'ready',
    async init(options) {
      statusChecks += 1
      assert.deepStrictEqual(options, { force: true })
      this.member = { status: 'invite_required', cacheNamespace: '' }
      this.cacheNamespace = ''
      this.state = 'ready'
      return this.member
    },
    reset() {
      events.push('identity-reset')
      this.member = null
      this.cacheNamespace = ''
      this.state = 'idle'
    },
  }
  installDependencies({
    membershipStore,
    clearPrivateCache() { events.push('cache-cleared') },
    async callFunction() { events.push('cloud-timeout'); throw new Error('云服务响应超时') },
  })
  const toasts = []
  global.wx = {
    getStorageInfoSync: () => ({ keys: [] }),
    showToast: (options) => toasts.push(options),
    reLaunch: () => {},
  }
  const page = loadPage()
  page.setData({ loading: false, deletionRecovery: true })
  await page.continueDeletion()
  assert.deepStrictEqual(events, ['cache-cleared', 'identity-reset', 'cloud-timeout'])
  assert.strictEqual(statusChecks, 1)
  assert(toasts.some((item) => item.title === '私人数据已清空' && item.icon === 'success'),
    '响应丢失但云端身份已删除时必须按新鲜状态收敛为成功')
  assert.strictEqual(page.data.deletionError, '')
}

async function testStorageFailureDoesNotBlockDeletionRetry() {
  const namespace = 'f'.repeat(32)
  const events = []
  const membershipStore = {
    member: { status: 'deleting', cacheNamespace: namespace },
    cacheNamespace: namespace,
    state: 'ready',
    reset() {
      events.push('identity-reset')
      this.member = null
      this.cacheNamespace = ''
      this.state = 'idle'
    },
  }
  installDependencies({
    membershipStore,
    clearPrivateCache() { events.push('cache-attempt'); throw new Error('storage unavailable') },
    async callFunction(name, action, payload) {
      events.push('cloud-called')
      assert.deepStrictEqual([name, action, payload], [
        'privacy', 'clearMyData', { expectedCacheNamespace: namespace },
      ])
      return { cleared: true }
    },
  })
  global.wx = { showToast() {}, reLaunch() {} }
  const page = loadPage()
  page.setData({ loading: false, deletionRecovery: true })
  await page.continueDeletion()
  assert.deepStrictEqual(events, ['cache-attempt', 'identity-reset', 'cloud-called'],
    '本地缓存 API 异常不得阻断云端幂等续删')
}

function testMarkupKeepsRecoveryPrimary() {
  const markup = fs.readFileSync(path.join(root, 'miniprogram/pages/access/access.wxml'), 'utf8')
  const styles = fs.readFileSync(path.join(root, 'miniprogram/pages/access/access.wxss'), 'utf8')
  assert(markup.includes('{{checkError && !showInviteForm}}'), '身份检查失败必须使用独立恢复状态')
  assert(markup.includes('bindtap="retryCheck"') && markup.includes('重新验证微信身份'), '已有身份必须有明确重试操作')
  assert(markup.includes('bindtap="useInviteInstead"') && markup.includes('使用邀请码加入'), '邀请码加入必须保留为次级入口')
  assert(markup.includes('{{inviteError}}') && !markup.includes('{{error}}'), '邀请码错误不能复用身份检查错误')
  assert(/<input[^>]+bindconfirm="submit"[^>]+confirm-type="done"[^>]+aria-label="成员邀请码"/.test(markup),
    '邀请码输入必须支持键盘完成提交并提供明确读屏名称')
  assert(markup.includes('wx:elif="{{deletionRecovery}}"')
    && markup.includes('bindtap="continueDeletion"')
    && markup.includes('继续完成私人数据清理'), '跨重启删除必须提供明确的继续清理主操作')
  const deletionBlock = (/<view wx:elif="\{\{deletionRecovery\}\}"([\s\S]*?)<view wx:else/.exec(markup) || [])[1] || ''
  assert(!/bindinput="inputCode"|bindtap="submit"|邀请码加入/.test(deletionBlock),
    '删除恢复态不得暴露邀请码绕过入口')
  assert(/\.alternate-action[^}]*border:/s.test(styles), '次级邀请码入口必须与主按钮有视觉层级')
  for (const inset of ['left', 'right']) {
    assert(styles.includes(`constant(safe-area-inset-${inset})`), `Access 必须兼容 ${inset} constant 安全区`)
    assert(styles.includes(`env(safe-area-inset-${inset})`), `Access 必须兼容 ${inset} env 安全区`)
  }
  assert(!/font-size:\s*\d+rpx/.test(styles), 'Access 正文必须使用稳定 px 字号，避免 320px 过小或 812×375 过大')
  const landscape = (/@media \(orientation: landscape\) and \(max-height: 500px\)\s*\{([\s\S]*?)\n\}/.exec(styles) || [])[1] || ''
  assert(/\.access-content/.test(landscape), '812×375 横屏必须保留 Access 内容覆盖')
}

async function run() {
  await testIdentityFailureCanRecoverWithoutInvite()
  await testUnregisteredIdentityOpensInviteForm()
  await testIdentityAndInviteErrorsStaySeparate()
  await testDeletingIdentityResumesWithoutInviteBypass()
  await testLostDeletionResponseUsesFreshMembershipState()
  await testStorageFailureDoesNotBlockDeletionRetry()
  testMarkupKeepsRecoveryPrimary()
  console.log('access page recovery tests passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
