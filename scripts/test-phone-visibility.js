'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '..')
const profilePath = path.join(root, 'miniprogram/pages/profile/profile.js')
let definition
global.Page = value => { definition = value }
global.wx = { getStorageSync() {}, showToast() {} }
require(profilePath)
const { membershipStore } = require('../miniprogram/services/membership-store')
const originalSet = membershipStore.setPhoneVisibility
const namespace = 'a'.repeat(32)
const flush = () => new Promise(resolve => setImmediate(resolve))

function setup(enabled = false) {
  const page = Object.create(definition)
  page.data = JSON.parse(JSON.stringify(definition.data))
  Object.assign(page.data, { profileLoading: false, authState: 'ready' })
  page.setData = patch => Object.assign(page.data, patch)
  page.resetMemberManagement = () => {}
  membershipStore.member = { status: 'active', role: 'member', legalConsentVersion: 2,
    serviceConsentAccepted: true, phoneVisibilitySupported: true, phoneVisibilityEnabled: enabled, phoneVisibilityRevision: 0 }
  membershipStore.cacheNamespace = namespace
  membershipStore.membershipRevision = 1
  membershipStore.state = 'ready'
  page.data.member = { ...membershipStore.member }
  return page
}

async function run() {
  let writes = 0
  let modal
  let result
  global.wx.showModal = options => { modal = options }
  membershipStore.setPhoneVisibility = async allowed => { writes += 1; result = { ...membershipStore.member, phoneVisibilityEnabled: allowed }; return result }
  let page = setup()
  const cancelled = page.changePhoneVisibility()
  assert.strictEqual(writes, 0, '仅打开说明不能授权')
  assert(modal.content.includes('后四位') && modal.content.includes('不保存完整号码') && modal.content.includes('不允许也能正常使用'))
  await page.changePhoneVisibility()
  modal.success({ confirm: false })
  await cancelled
  assert.strictEqual(writes, 0)
  assert.strictEqual(page.data.savingPhoneVisibility, false)
  for (const enabled of [false, true]) {
    page = setup(enabled)
    const pending = page.changePhoneVisibility()
    modal.success({ confirm: true })
    await pending
    assert.strictEqual(page.data.member.phoneVisibilityEnabled, !enabled)
    assert.strictEqual(page.data.savingPhoneVisibility, false)
  }
  const afterConfirmation = writes
  for (const change of ['hide', 'unload', 'identity', 'role', 'choice-revision', 'choice-value', 'capability', 'offline']) {
    page = setup()
    const pending = page.changePhoneVisibility()
    if (change === 'hide') page.onHide()
    if (change === 'unload') page.onUnload()
    if (change === 'identity') membershipStore.cacheNamespace = 'b'.repeat(32)
    if (change === 'role') membershipStore.membershipRevision += 1
    if (change === 'choice-revision') membershipStore.member.phoneVisibilityRevision += 1
    if (change === 'choice-value') membershipStore.member.phoneVisibilityEnabled = true
    if (change === 'capability') membershipStore.member.phoneVisibilitySupported = false
    if (change === 'offline') membershipStore.state = 'offline'
    modal.success({ confirm: true })
    await pending
    assert.strictEqual(writes, afterConfirmation, `确认前 ${change} 不得继续保存`)
  }
  page = setup()
  const oldPrompt = page.changePhoneVisibility()
  const oldModal = modal
  page.onHide()
  page.memberManagementSuspended = false
  const newPrompt = page.changePhoneVisibility()
  oldModal.success({ confirm: true })
  await oldPrompt
  assert.strictEqual(page.data.savingPhoneVisibility, true, '旧弹窗结束不能解锁新操作')
  assert.strictEqual(writes, afterConfirmation)
  modal.success({ confirm: false })
  await newPrompt

  page = setup()
  let resolveWrite
  membershipStore.setPhoneVisibility = () => new Promise(resolve => { resolveWrite = resolve })
  const pendingWrite = page.changePhoneVisibility()
  modal.success({ confirm: true })
  await flush()
  page.onUnload()
  page.setData = () => { throw new Error('已卸载页面不能回写') }
  resolveWrite({ ...membershipStore.member, phoneVisibilityEnabled: true })
  await pendingWrite

  page = setup()
  membershipStore.setPhoneVisibility = async () => { throw new Error('synthetic failure') }
  let pending = page.changePhoneVisibility()
  modal.success({ confirm: true })
  await pending
  assert.strictEqual(page.data.member.phoneVisibilityEnabled, false, '失败不能乐观显示已开启')
  assert(page.data.phoneVisibilityError.includes('刷新资料'))
  assert.strictEqual(page.data.savingPhoneVisibility, false)
  membershipStore.setPhoneVisibility = async () => ({ ...membershipStore.member, phoneVisibilityEnabled: true })
  pending = page.changePhoneVisibility()
  modal.success({ confirm: true })
  await pending
  assert.strictEqual(page.data.phoneVisibilityError, '')

  page = setup()
  global.wx.showModal = () => { throw new Error('native modal unavailable') }
  await page.changePhoneVisibility()
  assert.strictEqual(page.data.savingPhoneVisibility, false)
  assert(page.data.phoneVisibilityError)

  const markup = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/profile.wxml'), 'utf8')
  const styles = fs.readFileSync(path.join(root, 'miniprogram/pages/profile/profile.wxss'), 'utf8')
  assert(markup.includes('member.phoneVisibilitySupported') && markup.includes('bindtap="changePhoneVisibility"'))
  assert(markup.includes('停止展示尾号') && markup.includes('刷新资料'))
  assert(/\.phone-visibility-button\s*\{[^}]*min-height:\s*48px[^}]*font-size:\s*14px[^}]*overflow-wrap:\s*anywhere/.test(styles))
  membershipStore.setPhoneVisibility = originalSet
  console.log('phone visibility consent, cancellation, identity and recovery tests passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
