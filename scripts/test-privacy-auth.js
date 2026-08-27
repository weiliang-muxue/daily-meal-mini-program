'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

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
  assert(accessWxml.includes('bindtap="openUserAgreement"') && accessWxml.includes('bindtap="openPrivacyGuide"'))
  assert(profileWxml.includes('bindtap="openUserAgreement"') && profileWxml.includes('bindtap="openPrivacyGuide"'))
  assert(profileWxml.includes('open-type="chooseAvatar"'), '头像恢复路径必须保留微信原生 chooseAvatar 控件')
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
  installPageDependencies({
    getPrivacyAuthorizationState: async () => ({ supported: true, authorized: false, needAuthorization: true }),
    ensurePrivacyAuthorized: async () => { authorized = true; return { authorized: true } },
    navigateToUserAgreement: async () => {},
    openPrivacyContractOrLocal: async () => ({}),
  })
  global.wx = { showModal() {}, showToast() {}, showLoading() {}, hideLoading() {} }
  const profile = makePage(loadPage(profilePath))
  await profile.checkAvatarPrivacy()
  assert.strictEqual(profile.data.avatarPrivacyMode, 'authorize')
  assert.strictEqual(profile.data.avatarPrivacyTone, 'hint')
  await profile.authorizeAvatarPrivacy()
  assert.strictEqual(authorized, true)
  assert.strictEqual(profile.data.avatarPrivacyMode, 'native')
  assert.strictEqual(profile.data.avatarPrivacyTone, 'success')
  assert(profile.data.avatarPrivacyError.includes('再次点击头像'))
}

async function main() {
  await testAuthorizationNotNeeded()
  await testAuthorizationSuccess()
  await testAuthorizationRejected()
  await testMissingApiUsesLegacyNativeFlow()
  await testPrivacyContractFallback()
  await testPrivacyContractAndLocalFallbackBothFail()
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
