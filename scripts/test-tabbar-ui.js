'use strict'

const assert = require('assert')
const childProcess = require('child_process')
const fs = require('fs')
const path = require('path')
const { ASSET_ALLOWLIST, blobReason } = require('./check-staged-safety')

const root = path.resolve(__dirname, '..')
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
const app = readJson('miniprogram/app.json')
const expected = [
  ['pages/plan/plan', '餐单', 'plan'],
  ['pages/health/health', '记录', 'record'],
  ['pages/shopping/shopping', '采购', 'shopping'],
  ['pages/profile/profile', '我的', 'profile'],
]

assert.strictEqual(app.tabBar.list.length, expected.length, '主导航必须保持四项')
for (const [index, [pagePath, text, iconName]] of expected.entries()) {
  const item = app.tabBar.list[index]
  assert.deepStrictEqual(
    { pagePath: item.pagePath, text: item.text },
    { pagePath, text },
    `第 ${index + 1} 个 Tab 的页面或文案不一致`,
  )
  assert.strictEqual(item.iconPath, `assets/icons/tabbar/${iconName}.png`)
  assert.strictEqual(item.selectedIconPath, `assets/icons/tabbar/${iconName}-selected.png`)

  for (const assetPath of [item.iconPath, item.selectedIconPath]) {
    const absolute = path.join(root, 'miniprogram', assetPath)
    assert(fs.existsSync(absolute), `TabBar 图标缺失：${assetPath}`)
    const buffer = fs.readFileSync(absolute)
    const repositoryPath = `miniprogram/${assetPath}`
    assert.doesNotThrow(() => childProcess.execFileSync(
      'git', ['ls-files', '--error-unmatch', repositoryPath],
      { cwd: root, stdio: 'ignore' },
    ), `TabBar 图标未被 Git 跟踪：${assetPath}`)
    assert(Object.prototype.hasOwnProperty.call(ASSET_ALLOWLIST, repositoryPath),
      `TabBar 图标未进入公开素材白名单：${assetPath}`)
    assert.strictEqual(blobReason(repositoryPath, buffer), '',
      `TabBar 图标未通过公开素材检查：${assetPath}`)
    assert(buffer.subarray(1, 4).equals(Buffer.from('PNG')), `${assetPath} 必须是 PNG`)
    assert.strictEqual(buffer.readUInt32BE(16), 81, `${assetPath} 宽度必须是 81px`)
    assert.strictEqual(buffer.readUInt32BE(20), 81, `${assetPath} 高度必须是 81px`)
  }

  const pageConfig = readJson(`miniprogram/${pagePath}.json`)
  assert.strictEqual(pageConfig.navigationBarTitleText, text,
    `${pagePath} 的页面标题必须与 Tab 文案一致`)
}

console.log('tabbar UI contract tests passed')
