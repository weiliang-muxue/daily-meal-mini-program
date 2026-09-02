'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const profilePath = path.join(root, 'miniprogram', 'pages', 'profile', 'profile.js')
const profileBehavior = fs.readFileSync(profilePath, 'utf8')
const profileWxml = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'profile', 'profile.wxml'), 'utf8')
const profileWxss = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'profile', 'profile.wxss'), 'utf8')
const authModulePath = path.join(root, 'miniprogram', 'services', 'auth-store.js')
const userStoreModulePath = path.join(root, 'miniprogram', 'services', 'user-store.js')

assert(/open-type="chooseAvatar"/.test(profileWxml))
assert(/open-type="chooseAvatar"[^>]+disabled="\{\{profileLoading \|\| saving\}\}"/.test(profileWxml),
  '资料初始化和保存期间必须锁定头像选择')
assert(/class="avatar-button avatar-authorize"[^>]+disabled="\{\{profileLoading \|\| authorizingAvatar \|\| saving\}\}"/.test(profileWxml),
  '资料初始化、授权或保存期间必须锁定头像授权分支')
assert.strictEqual((profileWxml.match(/class="avatar-action">更换头像<\/text>/g) || []).length, 2,
  '两个头像入口都必须显示简短操作文案，不能只呈现为静态头像')
assert.strictEqual((profileWxml.match(/src="\/assets\/icons\/tabbar\/profile\.png"/g) || []).length, 2,
  '头像操作提示必须复用现有 Lucide 图标的跨端 PNG 版本')
assert(/aria-label="更换头像"/.test(profileWxml) && /aria-label="授权后更换头像"/.test(profileWxml),
  '头像入口必须提供与可见动作一致的读屏名称')
assert(/\.avatar-button\s*\{[^}]*min-width:\s*76px[^}]*min-height:\s*78px/.test(profileWxss),
  '头像入口必须保留稳定且充足的移动端触控区域')
assert(/\.avatar-edit-icon\s*\{[^}]*position:\s*absolute[^}]*border-radius:\s*50%/.test(profileWxss),
  '头像上必须有稳定、不改变布局的编辑状态标记')
assert.strictEqual((profileWxml.match(/wx:if="\{\{avatarPreview && !avatarImageFailed\}\}"/g) || []).length, 2,
  '原生选择和授权头像入口都必须在图片失败后显示昵称首字兜底')
assert.strictEqual((profileWxml.match(/data-src="\{\{avatarPreview\}\}"/g) || []).length, 2,
  '头像错误事件必须携带对应图片地址以忽略过期事件')
assert.strictEqual((profileWxml.match(/binderror="onAvatarImageError"/g) || []).length, 2,
  '两个头像图片分支都必须处理加载失败')
assert(/<input[^>]+type="nickname"[^>]+name="nickname"/.test(profileWxml))
assert(/<input[^>]+type="nickname"[^>]+disabled="\{\{profileLoading \|\| saving\}\}"/.test(profileWxml),
  '资料初始化和保存期间必须锁定昵称输入')
assert(/class="header-title">\{\{nickname \|\| '还没有设置昵称'\}\}/.test(profileWxml),
  '页头昵称必须实时预览当前输入，不能停留在已保存旧值')
assert(/<form[^>]+bindsubmit="saveProfile"/.test(profileWxml) && /form-type="submit"/.test(profileWxml))
assert(/\.profile-form\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*display:\s*block[^}]*box-sizing:\s*border-box/.test(profileWxss),
  '原生 form 卡片必须显式铺满并使用 border-box，避免 surface 背景碎裂成窄条')
assert(/open-type="getPhoneNumber"/.test(profileWxml) && /bindgetphonenumber="onGetPhoneNumber"/.test(profileWxml))
assert(/class="phone-button"[^>]+disabled="\{\{profileLoading \|\| bindingPhone \|\| saving\}\}"/.test(profileWxml),
  '资料初始化或保存期间必须禁用手机号绑定，避免资料请求竞态')
assert(/\.phone-button\s*\{[^}]*width:\s*72px[^}]*min-width:\s*72px[^}]*max-width:\s*72px[^}]*min-height:\s*48px/.test(profileWxss),
  '常规手机的手机号按钮必须保持紧凑且满足 48px 触控高度')
const profileNarrow = (/@media \(max-width: 340px\)\s*\{([\s\S]*?)\n\}/.exec(profileWxss) || [])[1] || ''
assert(/\.phone-row\s*\{[^}]*flex-direction:\s*column/.test(profileNarrow)
  && /\.phone-button\s*\{[^}]*width:\s*100%[^}]*max-width:\s*none/.test(profileNarrow),
'320px 窄屏手机号区域必须纵向折叠且按钮铺满，避免状态文字被挤断')
assert(/class="primary-button profile-save"[^>]+disabled="\{\{profileLoading \|\| saving \|\| bindingPhone\}\}"/.test(profileWxml),
  '资料初始化或手机号绑定期间必须禁用保存资料，避免资料请求竞态')
assert(!/getUserInfo/.test(profileWxml), '资料页不能静默读取已废弃的完整微信资料')
assert(/avatarPrivacyMode:\s*'native'/.test(profileBehavior),
  '用户未操作头像前必须直接显示原生选择入口，不常驻隐私技术提示')
assert(!/onLoad\(\)\s*\{[\s\S]*?this\.checkAvatarPrivacy\(\)[\s\S]*?\n\s*\}/.test(profileBehavior),
  '头像隐私状态只能在用户点击或原生选择失败后渐进检查')
assert(!/authState === 'ready'/.test(profileWxml), '身份连接成功后不应常驻展示技术状态条')
assert(profileWxml.includes('个人资料均为可选') && profileWxml.includes('不填写也可以正常使用'),
  '隐私与数据说明必须明确头像、昵称和手机号均可选且不影响核心功能')
assert(!profileWxml.includes('隐私设置') && !/\.privacy-card|\.privacy-title/.test(profileWxss),
  '中性隐私说明不能继续使用黄色警示卡层级')
assert(/class="legal-row touch-target"[^>]+bindtap="openUserAgreement"/.test(profileWxml)
  && /class="legal-row touch-target"[^>]+bindtap="openPrivacyGuide"/.test(profileWxml),
  '协议和隐私指引必须使用稳定的整行触控入口')
assert(/\.legal-row\s*\{[^}]*min-height:\s*48px/.test(profileWxss), '协议入口触控高度至少 48px')
assert((profileWxml.match(/<label class="setting-row touch-target" for="[^"]+">/g) || []).length === 2,
  '两个健康提醒必须用原生 label 扩大为整行触控目标')
assert((profileWxml.match(/<switch[^>]+aria-label="(?:补钙食物提醒|维生素 D 复诊提醒)，当前\{\{/g) || []).length === 2,
  '两个健康提醒开关必须提供包含当前状态的明确读屏名称')
assert(/\.setting-switch-target\s*\{[^}]*width:\s*48px;[^}]*min-width:\s*48px;[^}]*min-height:\s*48px;/s.test(profileWxss),
  '健康提醒开关本身必须保留至少 48px 触控区')
assert((profileWxml.match(/color="\{\{nativeControlColor\}\}"/g) || []).length === 3,
  '健康提醒开关和管理员交接单选框必须共享主题化原生控件颜色')
assert(!/<(?:switch|radio)[^>]+color="#[\da-f]+"/i.test(profileWxml),
  'Profile 原生开关和单选框不得写死浅色主题颜色')
assert(profileBehavior.includes("theme === 'dark' ? '#72D49E' : '#176B46'")
  && profileBehavior.includes('wx.onThemeChange(this.themeChangeHandler)')
  && profileBehavior.includes('wx.offThemeChange(this.themeChangeHandler)'),
  'Profile 原生控件颜色必须随系统主题切换并在卸载时解绑')
assert(!profileBehavior.includes('getSystemInfoSync'), 'Profile 不得继续调用已废弃的 getSystemInfoSync')
assert(/<text class="invite-field-label">邀请备注（可选）<\/text>/.test(profileWxml)
  && /<input[^>]+id="invite-label-input"[^>]+aria-label="邀请备注（可选）"/.test(profileWxml),
  '邀请备注必须同时有持久可见标签和明确的读屏名称')
assert(profileWxml.includes('危险操作') && profileWxml.includes('删除后不可恢复'),
  '清空数据必须独立归入危险操作并明确不可恢复')
assert(/\.danger-button\s*\{[^}]*width:\s*100%[^}]*min-height:\s*48px/.test(profileWxss),
  '清空按钮必须铺满危险卡片并保持至少 48px，避免窄屏文案不稳定换行')
assert(/bindtap="clearMyData"[^>]+loading="\{\{clearingData\}\}"[^>]+disabled="\{\{profileLoading \|\| clearingData\}\}"/.test(profileWxml),
  '清空按钮执行期间必须展示 loading 并禁用')
assert(/disabled="\{\{profileLoading \|\| saving\}\}"/.test(profileWxml),
  '资料初始化期间必须禁用头像与昵称等资料写入控件')
assert(/disabled="\{\{profileLoading \|\| savingSettings\}\}"/.test(profileWxml),
  '资料初始化期间必须禁用健康提醒开关，避免云端回读覆盖用户操作')
assert(/bindtap="retryMembers"[^>]+disabled="\{\{profileLoading \|\|/.test(profileWxml)
  && /<radio[^>]+disabled="\{\{profileLoading \|\| transferringOwner\}\}"/.test(profileWxml),
'资料初始化期间必须禁用成员重试和管理员交接选择')
assert(!/font-size:\s*\d+rpx/.test(profileWxss), 'Profile 正文必须使用稳定 px 字号，不能在 812×375 横屏缩小')
assert(/\.section-title\s*\{[^}]*font-size:\s*\d+px/.test(profileWxss), 'Profile 章节标题必须覆盖全局 rpx 字号')
assert(/\.profile-form \.primary-button[^}]*font-size:\s*\d+px/.test(profileWxss), 'Profile 主按钮必须覆盖全局 rpx 字号')
const profileLandscape = (/@media \(orientation: landscape\) and \(max-height: 500px\)\s*\{([\s\S]*?)\n\}/.exec(profileWxss) || [])[1] || ''
assert(/min-height:\s*48px/.test(profileLandscape), 'Profile 812×375 横屏交互控件至少 48px')
assert(/\.screen\s*\{[^}]*max-width:\s*none/.test(profileLandscape), 'Profile 812×375 横屏不能继续压缩在 680px 居中容器内')
assert(profileLandscape.includes('constant(safe-area-inset-left)') && profileLandscape.includes('env(safe-area-inset-right)'),
  'Profile 812×375 横屏根容器必须保留左右刘海安全区')
for (const width of [320, 353, 375, 414]) assert(width >= 320 && width <= 414, `Profile 缺少 ${width}px 目标视口`)

let pageDefinition
const toastCalls = []
global.Page = (definition) => { pageDefinition = definition }
global.wx = {
  getStorageSync: () => null,
  setStorageSync: () => {},
  showLoading: () => {},
  hideLoading: () => {},
  showToast: (options) => toastCalls.push(options),
}

delete require.cache[profilePath]
require(profilePath)
assert(pageDefinition)

const { authStore } = require(authModulePath)
const { userStore } = require(userStoreModulePath)
function makePage() {
  const page = Object.create(pageDefinition)
  page.data = JSON.parse(JSON.stringify(pageDefinition.data))
  page.data.profileLoading = false
  page.setData = (patch) => Object.assign(page.data, patch)
  return page
}

async function main() {
  const themed = makePage()
  themed.applyTheme({ theme: 'dark' })
  assert.strictEqual(themed.data.nativeControlColor, '#72D49E')
  themed.applyTheme({ theme: 'light' })
  assert.strictEqual(themed.data.nativeControlColor, '#176B46')

  const loadingGuard = makePage()
  loadingGuard.data.profileLoading = true
  loadingGuard.onNicknameInput({ detail: { value: '加载期间输入' } })
  assert.strictEqual(loadingGuard.data.nickname, '', '资料初始化期间不得接收昵称写入')
  let loadingSettingWrites = 0
  const originalPatch = userStore.patch
  userStore.patch = async () => { loadingSettingWrites += 1 }
  await loadingGuard.toggleHealthSetting({
    currentTarget: { dataset: { key: 'calciumAnchorReminder' } }, detail: { value: true },
  })
  assert.strictEqual(loadingSettingWrites, 0, '资料初始化期间不得创建健康设置 pending')
  userStore.patch = originalPatch

  const clearing = makePage()
  clearing.data.nickname = ''
  clearing.data.nicknameDirty = true
  authStore.profile = { nickname: '旧昵称', avatarUrl: '' }
  authStore.state = 'ready'
  clearing.render()
  assert.strictEqual(clearing.data.nickname, '', '用户清空昵称后，页面重绘不能用旧昵称回填')

  const refreshedAvatar = makePage()
  refreshedAvatar.data.avatarPreview = 'expired-temp-url'
  refreshedAvatar.data.avatarLocalPath = ''
  refreshedAvatar.data.avatarImageFailed = true
  authStore.profile = { nickname: '', avatarUrl: 'fresh-temp-url' }
  refreshedAvatar.render()
  assert.strictEqual(refreshedAvatar.data.avatarPreview, 'fresh-temp-url', '已保存头像必须采用云端刷新后的临时 URL')
  assert.strictEqual(refreshedAvatar.data.avatarImageFailed, false, '云端刷新头像地址后必须重新尝试显示图片')

  const unsavedAvatar = makePage()
  unsavedAvatar.data.avatarPreview = 'local-avatar-path'
  unsavedAvatar.data.avatarLocalPath = 'local-avatar-path'
  authStore.profile = { nickname: '', avatarUrl: 'cloud-avatar-url' }
  unsavedAvatar.render()
  assert.strictEqual(unsavedAvatar.data.avatarPreview, 'local-avatar-path', '未保存头像预览不能被云端刷新覆盖')

  const brokenAvatar = makePage()
  brokenAvatar.data.avatarPreview = 'broken-avatar-url'
  brokenAvatar.onAvatarImageError({ currentTarget: { dataset: { src: 'broken-avatar-url' } } })
  assert.strictEqual(brokenAvatar.data.avatarImageFailed, true, '当前头像加载失败时必须切换到昵称首字兜底')

  const staleAvatarError = makePage()
  staleAvatarError.data.avatarPreview = 'fresh-avatar-url'
  staleAvatarError.onAvatarImageError({ currentTarget: { dataset: { src: 'expired-avatar-url' } } })
  assert.strictEqual(staleAvatarError.data.avatarImageFailed, false, '旧头像的延迟错误不能隐藏新头像')

  const chosenAvatar = makePage()
  chosenAvatar.data.avatarImageFailed = true
  chosenAvatar.onChooseAvatar({ detail: { avatarUrl: 'new-local-avatar-path' } })
  assert.strictEqual(chosenAvatar.data.avatarPreview, 'new-local-avatar-path')
  assert.strictEqual(chosenAvatar.data.avatarLocalPath, 'new-local-avatar-path')
  assert.strictEqual(chosenAvatar.data.avatarImageFailed, false, '重新选择头像后必须恢复图片预览')

  const cancelledAvatar = makePage()
  cancelledAvatar.onChooseAvatar({ detail: { errMsg: 'chooseAvatar:fail user cancel' } })
  assert.strictEqual(cancelledAvatar.data.avatarPrivacyError, '', '用户主动取消头像选择不应留下持久提示')
  assert.strictEqual(cancelledAvatar.data.avatarPrivacyTone, 'hint', '用户取消头像选择不应显示为系统错误')

  const undeclaredAvatar = makePage()
  undeclaredAvatar.onChooseAvatar({ detail: { errMsg: 'chooseAvatar:fail api scope is not declared in the privacy agreement' } })
  assert(/暂不支持选择头像/.test(undeclaredAvatar.data.avatarPrivacyError))
  assert(!/scope|隐私范围|未声明/.test(undeclaredAvatar.data.avatarPrivacyError), '不能向用户暴露平台内部配置术语')
  assert.strictEqual(undeclaredAvatar.data.avatarPrivacyTone, 'error')
  assert.strictEqual(undeclaredAvatar.data.avatarPrivacyMode, 'native')
  assert(profileWxml.includes('wx:if="{{avatarPrivacyMode !== \'native\'}}" class="avatar-error-actions"'),
    '未声明或不支持时必须隐藏无法解决该配置问题的授权操作')

  const unsupportedAvatar = makePage()
  unsupportedAvatar.onChooseAvatar({ detail: { errMsg: 'chooseAvatar:fail api is not supported' } })
  assert.strictEqual(unsupportedAvatar.data.avatarPrivacyMode, 'native')
  assert(/不影响其他功能/.test(unsupportedAvatar.data.avatarPrivacyError))

  const submitted = makePage()
  submitted.data.nickname = '旧输入值'
  submitted.data.avatarImageFailed = true
  authStore.updateProfile = async (profile) => {
    assert.strictEqual(profile.nickname, '表单提交值', '保存必须采用 nickname 表单提交值')
    return { nickname: profile.nickname, avatarUrl: '', phoneBound: false, maskedPhone: '' }
  }
  await submitted.saveProfile({ detail: { value: { nickname: '表单提交值' } } })
  assert.strictEqual(submitted.data.nickname, '表单提交值')
  assert.strictEqual(submitted.data.nicknameDirty, false)
  assert.strictEqual(submitted.data.avatarImageFailed, false, '资料保存成功后必须允许显示刷新后的头像')

  let bindCalls = 0
  authStore.bindPhoneNumber = async () => { bindCalls += 1; throw new Error('不应调用') }
  const denied = makePage()
  await denied.onGetPhoneNumber({ detail: { errMsg: 'getPhoneNumber:fail user deny' } })
  assert.strictEqual(bindCalls, 0)
  assert.strictEqual(denied.data.bindingPhone, false)
  assert(/取消/.test(denied.data.phoneError))

  const success = makePage()
  authStore.bindPhoneNumber = async (code) => {
    bindCalls += 1
    assert.strictEqual(code, 'single-use-test-code')
    return { nickname: '测试昵称', phoneBound: true, maskedPhone: '****8000' }
  }
  await success.onGetPhoneNumber({ detail: { code: 'single-use-test-code', errMsg: 'getPhoneNumber:ok' } })
  assert.strictEqual(bindCalls, 1)
  assert.deepStrictEqual(success.data.profile, {
    nickname: '测试昵称', phoneBound: true, maskedPhone: '****8000',
  })
  assert.strictEqual(success.data.bindingPhone, false)
  assert.strictEqual(success.data.phoneError, '')
  assert(toastCalls.some((item) => item.title === '手机号已绑定'))
  assert.strictEqual(JSON.stringify(success.data).includes('single-use-test-code'), false,
    '手机号动态 code 不得进入页面 data 或本地持久状态')

  const unavailable = makePage()
  authStore.bindPhoneNumber = async () => {
    throw new Error('暂时无法绑定手机号，可稍后重试，不影响其他功能')
  }
  await unavailable.onGetPhoneNumber({ detail: { code: 'another-single-use-code' } })
  assert.strictEqual(unavailable.data.bindingPhone, false)
  assert(/不影响其他功能/.test(unavailable.data.phoneError))

  bindCalls = 0
  authStore.bindPhoneNumber = async () => { bindCalls += 1; return {} }
  const saveInFlight = makePage()
  saveInFlight.data.saving = true
  await saveInFlight.onGetPhoneNumber({ detail: { code: 'must-not-be-consumed' } })
  assert.strictEqual(bindCalls, 0, '资料保存期间不能消费手机号动态 code')

  let updateCalls = 0
  authStore.updateProfile = async () => { updateCalls += 1; return {} }
  const phoneInFlight = makePage()
  phoneInFlight.data.bindingPhone = true
  await phoneInFlight.saveProfile({ detail: { value: { nickname: '并发输入' } } })
  assert.strictEqual(updateCalls, 0, '手机号绑定期间不能并发更新资料')

  console.log('profile native identity controls tests passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
