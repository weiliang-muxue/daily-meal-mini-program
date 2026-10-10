'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { LEGAL_CONSENT_VERSION } = require('../miniprogram/utils/legal-consent')

const root = path.resolve(__dirname, '..')
const privacyPath = path.join(root, 'miniprogram', 'utils', 'privacy-auth.js')
const accessPath = path.join(root, 'miniprogram', 'pages', 'access', 'access.js')
const profilePath = path.join(root, 'miniprogram', 'pages', 'profile', 'profile.js')
const healthPath = path.join(root, 'miniprogram', 'pages', 'health', 'health.js')
const membershipPath = path.join(root, 'miniprogram', 'services', 'membership-store.js')
const authStorePath = path.join(root, 'miniprogram', 'services', 'auth-store.js')
const userStorePath = path.join(root, 'miniprogram', 'services', 'user-store.js')
const healthStorePath = path.join(root, 'miniprogram', 'services', 'health-store.js')
const privateImagePath = path.join(root, 'miniprogram', 'utils', 'private-image.js')

const privacyAuth = require(privacyPath)

function callbackApi(implementations) {
  return Object.keys(implementations).reduce((api, name) => {
    api[name] = (options) => implementations[name](options || {})
    return api
  }, {})
}

async function testAuthorizationNotNeeded() {
  let requireCalls = 0
  const wxApi = callbackApi({
    getPrivacySetting: ({ success }) => success({ needAuthorization: false, privacyContractName: '平台指引' }),
    requirePrivacyAuthorize: ({ success }) => { requireCalls += 1; success({}) },
  })
  const result = await privacyAuth.ensurePrivacyAuthorized(wxApi)
  assert.strictEqual(result.authorized, true)
  assert.strictEqual(result.needAuthorization, false)
  assert.strictEqual(requireCalls, 0, '无需授权时不能重复请求')
}

async function testAuthorizationSuccess() {
  let requireCalls = 0
  const wxApi = callbackApi({
    getPrivacySetting: ({ success }) => success({ needAuthorization: true }),
    requirePrivacyAuthorize: ({ success }) => { requireCalls += 1; success({}) },
  })
  const result = await privacyAuth.ensurePrivacyAuthorized(wxApi)
  assert.strictEqual(result.authorized, true)
  assert.strictEqual(result.needAuthorization, false)
  assert.strictEqual(requireCalls, 1)
}

async function testAuthorizationRejected() {
  const wxApi = callbackApi({
    getPrivacySetting: ({ success }) => success({ needAuthorization: true }),
    requirePrivacyAuthorize: ({ fail }) => fail({ errMsg: 'requirePrivacyAuthorize:fail user deny' }),
  })
  const result = await privacyAuth.ensurePrivacyAuthorized(wxApi)
  assert.strictEqual(result.authorized, false)
  assert.strictEqual(result.code, 'PRIVACY_AUTHORIZATION_REJECTED')
  assert(result.message.includes('重试'))
  assert(result.message.includes('隐私保护指引'))
}

async function testMissingApiUsesLegacyNativeFlow() {
  const result = await privacyAuth.ensurePrivacyAuthorized({})
  assert.strictEqual(result.supported, false)
  assert.strictEqual(result.authorized, true)
  assert.strictEqual(result.legacy, true)
}

async function testPrivacyContractFallback() {
  let fallbackCalls = 0
  const failedApi = callbackApi({
    openPrivacyContract: ({ fail }) => fail({ errMsg: 'openPrivacyContract:fail' }),
  })
  const result = await privacyAuth.openPrivacyContractOrLocal(failedApi, {
    onFallback: async () => { fallbackCalls += 1 },
  })
  assert.deepStrictEqual(result, { openedPlatformContract: false, usedLocalFallback: true })
  assert.strictEqual(fallbackCalls, 1)

  const navigations = []
  const missingApi = callbackApi({
    navigateTo: ({ url, success }) => { navigations.push(url); success({}) },
  })
  await privacyAuth.openPrivacyContractOrLocal(missingApi)
  assert.deepStrictEqual(navigations, ['/pages/legal/privacy'])

  let successFallbackCalls = 0
  const success = await privacyAuth.openPrivacyContractOrLocal(callbackApi({
    openPrivacyContract: ({ success: done }) => done({}),
  }), { onFallback: () => { successFallbackCalls += 1 } })
  assert.deepStrictEqual(success, { openedPlatformContract: true, usedLocalFallback: false })
  assert.strictEqual(successFallbackCalls, 0, '平台合同可打开时必须优先使用平台合同')
}

async function testPrivacyContractAndLocalFallbackBothFail() {
  const wxApi = callbackApi({
    openPrivacyContract: ({ fail }) => fail({ errMsg: 'openPrivacyContract:fail' }),
    navigateTo: ({ fail }) => fail({ errMsg: 'navigateTo:fail' }),
  })
  const result = await privacyAuth.openPrivacyContractOrLocal(wxApi)
  assert.strictEqual(result.openedPlatformContract, false)
  assert.strictEqual(result.usedLocalFallback, false)
  assert(result.error.includes('均暂时无法打开'))
}

async function testReadProofRequiresRenderedPageAndNavigationSuccess() {
  const reads = []
  let navigation
  const api = callbackApi({ navigateTo: (options) => { navigation = options; options.success({}) } })
  await privacyAuth.navigateToUserAgreement(api, { onRead: (detail) => reads.push(detail) })
  assert.deepStrictEqual(reads, [], 'navigateTo 成功不能单独证明本地正文已显示')
  navigation.events.legalDocumentReady({ document: 'privacy', version: LEGAL_CONSENT_VERSION })
  navigation.events.legalDocumentReady({ document: 'agreement', version: 0 })
  assert.deepStrictEqual(reads, [], '错误文档或旧版本不能解锁')
  privacyAuth.reportLegalDocumentReady({
    getOpenerEventChannel: () => ({ emit: (event, detail) => navigation.events[event](detail) }),
  }, 'agreement')
  navigation.events.legalDocumentReady({ document: 'agreement', version: LEGAL_CONSENT_VERSION })
  assert.deepStrictEqual(reads, [{ document: 'agreement', version: LEGAL_CONSENT_VERSION }], '重复回调只计一次')

  const failedReads = []
  const failed = callbackApi({
    navigateTo: ({ events, fail }) => {
      events.legalDocumentReady({ document: 'agreement', version: LEGAL_CONSENT_VERSION })
      fail({ errMsg: 'navigateTo:fail' })
    },
  })
  const result = await privacyAuth.navigateToUserAgreement(failed, { onRead: (detail) => failedReads.push(detail) })
  assert.strictEqual(result.navigated, false)
  assert.deepStrictEqual(failedReads, [], '失败导航即使有迟到或提前回调也不得解锁')
}

async function testPlatformAndLocalPrivacyReadProofStaySeparateFromAuthorization() {
  let authorizationCalls = 0
  let readCount = 0
  let localNavigation
  const api = callbackApi({
    requirePrivacyAuthorize: () => { authorizationCalls += 1 },
    openPrivacyContract: ({ fail }) => fail({ errMsg: 'cannot open native contract' }),
    navigateTo: (options) => { localNavigation = options; options.success({}) },
  })
  const fallback = await privacyAuth.openPrivacyContractOrLocal(api, { onRead: () => { readCount += 1 } })
  assert.strictEqual(fallback.usedLocalFallback, true)
  assert.strictEqual(readCount, 0, '本地回退导航发起后仍需等待正文页回调')
  localNavigation.events.legalDocumentReady({ document: 'privacy', version: LEGAL_CONSENT_VERSION })
  assert.strictEqual(readCount, 1)
  assert.strictEqual(authorizationCalls, 0, '打开协议不是申请微信原生敏感权限')

  await privacyAuth.openPrivacyContractOrLocal(callbackApi({
    openPrivacyContract: ({ success }) => success({}),
  }), { onRead: () => { readCount += 1 } })
  assert.strictEqual(readCount, 2, '平台协议仅在成功打开后记录')
  await privacyAuth.openPrivacyContractOrLocal(callbackApi({
    openPrivacyContract: ({ fail }) => fail({}),
    navigateTo: ({ fail }) => fail({}),
  }), { onRead: () => { readCount += 1 } })
  assert.strictEqual(readCount, 2, '平台和本地均失败不得计为阅读')
  await privacyAuth.openPrivacyContractOrLocal(api, {
    onFallback() {}, onRead: () => { readCount += 1 },
  })
  assert.strictEqual(readCount, 2, '任意 fallback 返回不能充当正文已显示证明')
}

function installPageDependencies(privacyMock) {
  const membershipStore = { init: async () => ({ status: 'active' }), member: {} }
  const authStore = { profile: {}, state: 'ready', error: '', init: async () => {}, updateProfile: async () => ({}) }
  const userStore = {
    data: { updatedAt: '', settings: { calciumAnchorReminder: false, vitaminDReminder: false } },
    init: async () => {}, patch: async () => {},
  }
  const healthStore = {
    state: 'ready', error: '', hasCachedMonth: () => false, getMonth: async () => [],
    getRange: async () => [], saveDaily: async () => {},
  }
  const dependencies = {
    [privacyPath]: privacyMock,
    [membershipPath]: { membershipStore },
    [authStorePath]: { authStore },
    [userStorePath]: { userStore },
    [healthStorePath]: { healthStore, isRecordRevisionConflict: () => false },
    [privateImagePath]: {
      MAX_AVATAR_BYTES: 1024,
      MAX_HEALTH_PHOTO_BYTES: 2048,
      privateImagePayload: async () => null,
    },
  }
  Object.entries(dependencies).forEach(([file, exports]) => {
    require.cache[file] = { id: file, filename: file, loaded: true, exports }
  })
}

function loadPage(file) {
  let definition
  global.Page = (value) => { definition = value }
  delete require.cache[file]
  require(file)
  assert(definition, `${file} 必须注册 Page`)
  return definition
}

function makePage(definition) {
  const page = Object.create(definition)
  page.data = JSON.parse(JSON.stringify(definition.data))
  page.setData = (partial) => Object.assign(page.data, partial)
  return page
}

async function testHealthActionIsBlocked() {
  let chooseMediaCalls = 0
  installPageDependencies({
    ensurePrivacyAuthorized: async () => ({
      authorized: false,
      message: '你尚未完成微信隐私授权，请重试或查看《隐私保护指引》。',
    }),
    openPrivacyContractOrLocal: async () => ({}),
  })
  global.wx = { chooseMedia: () => { chooseMediaCalls += 1 } }
  const page = makePage(loadPage(healthPath))
  await page.choosePhoto()
  assert.strictEqual(chooseMediaCalls, 0, '隐私授权被拒绝时不得调用 chooseMedia')
  assert.strictEqual(page.data.choosingPhoto, false)
  assert(page.data.photoPrivacyError.includes('重试'))
}

async function testHealthMissingChooseMediaRecoversForRetry() {
  installPageDependencies({
    ensurePrivacyAuthorized: async () => ({ authorized: true }),
    openPrivacyContractOrLocal: async () => ({ openedPlatformContract: true, usedLocalFallback: false }),
  })
  global.wx = {}
  const page = makePage(loadPage(healthPath))
  await page.choosePhoto()
  assert.strictEqual(page.data.choosingPhoto, false, 'chooseMedia 缺失时必须恢复按钮状态')
  assert(page.data.photoPrivacyError.includes('更新微信'))

  global.wx.chooseMedia = ({ success }) => success({
    tempFiles: [{ size: 100, tempFilePath: 'wxfile://retry-photo' }],
  })
  await page.retryChoosePhoto()
  assert.strictEqual(page.data.choosingPhoto, false)
  assert.strictEqual(page.data.photoPreview, 'wxfile://retry-photo', '能力恢复后重试必须可以继续选择')
  assert.strictEqual(page.data.photoPrivacyError, '')
}

async function testHealthSynchronousChooseMediaThrowRecovers() {
  installPageDependencies({
    ensurePrivacyAuthorized: async () => ({ authorized: true }),
    openPrivacyContractOrLocal: async () => ({ openedPlatformContract: true, usedLocalFallback: false }),
  })
  global.wx = { chooseMedia: () => { throw new Error('sync chooseMedia failure') } }
  const page = makePage(loadPage(healthPath))
  await page.choosePhoto()
  assert.strictEqual(page.data.choosingPhoto, false, 'chooseMedia 同步抛错时必须执行 finally')
  assert(page.data.photoPrivacyError.includes('稍后重试'))
}

async function testAccessAndProfileLegalRoutes() {
  const calls = []
  installPageDependencies({
    ensurePrivacyAuthorized: async () => ({ authorized: true }),
    getPrivacyAuthorizationState: async () => ({ supported: true, authorized: true }),
    navigateToUserAgreement: async () => { calls.push('agreement') },
    openPrivacyContractOrLocal: async () => {
      calls.push('privacy')
      return { openedPlatformContract: true, usedLocalFallback: false }
    },
  })
  global.wx = { showModal() {}, showToast() {}, showLoading() {}, hideLoading() {} }
  const access = makePage(loadPage(accessPath))
  await access.openUserAgreement()
  await access.openPrivacyGuide()
  const profile = makePage(loadPage(profilePath))
  await profile.openUserAgreement()
  await profile.openPrivacyGuide()
  assert.deepStrictEqual(calls, ['agreement', 'privacy', 'agreement', 'privacy'])

  const accessWxml = fs.readFileSync(path.join(root, 'miniprogram/pages/access/access.wxml'), 'utf8')
  const profileWxml = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/profile.wxml'), 'utf8')
  const agreementWxml = fs.readFileSync(path.join(root, 'miniprogram/pages/legal/user-agreement.wxml'), 'utf8')
  const privacyWxml = fs.readFileSync(path.join(root, 'miniprogram/pages/legal/privacy.wxml'), 'utf8')
  for (const internalTerm of ['openid', 'unionid', 'session_key', 'auth 云函数', '门禁审计', '真源', '命名空间']) {
    assert(!privacyWxml.includes(internalTerm), `隐私说明不能向用户暴露内部术语：${internalTerm}`)
  }
  assert(privacyWxml.includes('AI 生成') && !privacyWxml.includes('AI生成'),
    '隐私说明中的 AI 来源标识必须与业务页面一致')
  for (const markup of [agreementWxml, privacyWxml]) {
    assert(markup.includes('微信平台《隐私保护指引》'), '法律页面必须统一使用微信平台正式名称')
    assert(markup.includes('成员确认本版说明或另行允许后'), '两份说明必须明确成员授权后才展示尾号')
    assert(markup.includes('旧成员不自动开放后四位'), '两份说明必须保留历史成员不自动披露规则')
    assert(markup.includes('停止展示手机尾号'), '两份说明必须说明撤回方式')
    assert(markup.includes('不保存完整号码') && markup.includes('不发送给 AI'), '两份说明须保留最小保存和不向 AI 发送的边界')
    assert(markup.includes('拒绝或暂时无法绑定不会影响其他功能'), '绑定手机号仍是可选操作')
    assert(!markup.includes('不能因此查看其他成员的手机号、'), '不能保留与尾号权限冲突的旧表述')
  }
  assert(!accessWxml.includes('本次说明更新') && !accessWxml.includes('后四位'),
    '入口不重复展开手机号说明，详情应放入两份协议')
  assert(agreementWxml.includes('2026年10月10日更新（协议版本2）'), '用户协议必须标明本次说明版本')
  assert(agreementWxml.includes('手机号为可选操作') && agreementWxml.includes('主动点击并经微信授权后处理'),
    '协议阅读不代替微信原生手机号授权')
  assert(accessWxml.includes('请分别点开阅读以下协议') && accessWxml.includes('查看协议不会自动同意'),
    '精简入口不能移除阅读与主动同意提示')
  for (const internalTerm of ['公开、可审计', '自绘弹窗', '平台合同', '随代码发布', '不冒充']) {
    assert(!agreementWxml.includes(internalTerm) && !privacyWxml.includes(internalTerm),
      `法律页面不能向普通用户暴露工程化说明：${internalTerm}`)
  }
  assert(accessWxml.includes('bindtap="openUserAgreement"') && accessWxml.includes('bindtap="openPrivacyGuide"'))
  assert(profileWxml.includes('bindtap="openUserAgreement"') && profileWxml.includes('bindtap="openPrivacyGuide"'))
  assert(profileWxml.includes('open-type="chooseAvatar"'), '头像恢复路径必须保留微信原生 chooseAvatar 控件')
  for (const [name, markup] of [
    ['个人页', profileWxml],
    ['用户协议', agreementWxml],
    ['隐私说明', privacyWxml],
  ]) {
    assert(markup.includes('清空我的私人数据'), `${name} 必须使用与实际按钮一致的清空操作名称`)
    assert(!markup.includes('清空我的全部私人数据'), `${name} 不能保留旧清空操作名称`)
    assert(!markup.includes('删除我的全部数据和成员身份'), `${name} 不能保留更早的删除操作名称`)
  }
}

async function testAccessAndProfileShowPrivacyOpenFailure() {
  const failure = {
    openedPlatformContract: false,
    usedLocalFallback: false,
    error: '微信平台《隐私保护指引》和本地隐私说明均暂时无法打开，请稍后重试。',
  }
  installPageDependencies({
    ensurePrivacyAuthorized: async () => ({ authorized: true }),
    getPrivacyAuthorizationState: async () => ({ supported: true, authorized: true }),
    navigateToUserAgreement: async () => ({ navigated: true }),
    openPrivacyContractOrLocal: async () => failure,
  })
  global.wx = { showModal() {}, showToast() {}, showLoading() {}, hideLoading() {} }
  const access = makePage(loadPage(accessPath))
  const profile = makePage(loadPage(profilePath))
  await access.openPrivacyGuide()
  await profile.openPrivacyGuide()
  assert.strictEqual(access.data.privacyError, failure.error)
  assert.strictEqual(profile.data.legalPrivacyError, failure.error)
}

async function testAvatarTwoStepAuthorizationRecovery() {
  let authorized = false
  const toastCalls = []
  installPageDependencies({
    getPrivacyAuthorizationState: async () => ({ supported: true, authorized: false, needAuthorization: true }),
    ensurePrivacyAuthorized: async () => { authorized = true; return { authorized: true } },
    navigateToUserAgreement: async () => {},
    openPrivacyContractOrLocal: async () => ({}),
  })
  global.wx = { showModal() {}, showToast(options) { toastCalls.push(options) }, showLoading() {}, hideLoading() {} }
  const profile = makePage(loadPage(profilePath))
  profile.data.profileLoading = false
  await profile.checkAvatarPrivacy()
  assert.strictEqual(profile.data.avatarPrivacyMode, 'authorize')
  assert.strictEqual(profile.data.avatarPrivacyTone, 'hint')
  await profile.authorizeAvatarPrivacy()
  assert.strictEqual(authorized, true)
  assert.strictEqual(profile.data.avatarPrivacyMode, 'native')
  assert.strictEqual(profile.data.avatarPrivacyTone, 'hint')
  assert.strictEqual(profile.data.avatarPrivacyError, '', '授权成功后不应保留常驻提示卡')
  assert(toastCalls.some((item) => item.title === '已授权，请点头像选择' && item.icon === 'none'),
    '授权成功后应用短提示告知下一步')
}

async function main() {
  await testAuthorizationNotNeeded()
  await testAuthorizationSuccess()
  await testAuthorizationRejected()
  await testMissingApiUsesLegacyNativeFlow()
  await testPrivacyContractFallback()
  await testPrivacyContractAndLocalFallbackBothFail()
  await testReadProofRequiresRenderedPageAndNavigationSuccess()
  await testPlatformAndLocalPrivacyReadProofStaySeparateFromAuthorization()
  await testHealthActionIsBlocked()
  await testHealthMissingChooseMediaRecoversForRetry()
  await testHealthSynchronousChooseMediaThrowRecovers()
  await testAccessAndProfileLegalRoutes()
  await testAccessAndProfileShowPrivacyOpenFailure()
  await testAvatarTwoStepAuthorizationRecovery()
  console.log('privacy authorization and legal route tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
