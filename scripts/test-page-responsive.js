'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const {
  boxSidePx,
  computedStyle,
  declarationValues,
  gridRepeatCount,
  lengthToPx,
  parseWxss,
  rulesForSelector,
} = require('./wxss-test-utils')

const root = path.resolve(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const globalStyles = read('miniprogram/app.wxss')
const pageSources = {
  plan: read('miniprogram/pages/plan/plan.wxss'),
  preview: read('miniprogram/pages/plan-preview/plan-preview.wxss'),
  history: read('miniprogram/pages/plan-history/plan-history.wxss'),
  shopping: read('miniprogram/pages/shopping/shopping.wxss'),
  mealEdit: read('miniprogram/pages/meal-edit/meal-edit.wxss'),
  access: read('miniprogram/pages/access/access.wxss'),
  planner: read('miniprogram/pages/planner/planner.wxss'),
  profile: read('miniprogram/pages/profile/profile.wxss'),
}
const pageRules = Object.fromEntries(Object.entries(pageSources).map(([name, source]) => [name, parseWxss(source)]))
const globalRules = parseWxss(globalStyles)
const mealCardRules = parseWxss(read('miniprogram/components/meal-card/meal-card.wxss'))
const mealEditSource = read('miniprogram/pages/meal-edit/meal-edit.js')
const mealEditMarkup = read('miniprogram/pages/meal-edit/meal-edit.wxml')
const secondaryNavigationPages = [
  ['planner', 'miniprogram/pages/planner/planner.js', 'miniprogram/pages/planner/planner.wxml', 'miniprogram/pages/planner/planner.wxss'],
  ['preview', 'miniprogram/pages/plan-preview/plan-preview.js', 'miniprogram/pages/plan-preview/plan-preview.wxml', 'miniprogram/pages/plan-preview/plan-preview.wxss'],
  ['history', 'miniprogram/pages/plan-history/plan-history.js', 'miniprogram/pages/plan-history/plan-history.wxml', 'miniprogram/pages/plan-history/plan-history.wxss'],
  ['mealEdit', 'miniprogram/pages/meal-edit/meal-edit.js', 'miniprogram/pages/meal-edit/meal-edit.wxml', 'miniprogram/pages/meal-edit/meal-edit.wxss'],
  ['guide', 'miniprogram/pages/guide/guide.js', 'miniprogram/pages/guide/guide.wxml', 'miniprogram/pages/guide/guide.wxss'],
  ['agreement', 'miniprogram/pages/legal/user-agreement.js', 'miniprogram/pages/legal/user-agreement.wxml', 'miniprogram/pages/legal/legal.wxss'],
  ['privacy', 'miniprogram/pages/legal/privacy.js', 'miniprogram/pages/legal/privacy.wxml', 'miniprogram/pages/legal/legal.wxss'],
].map(([name, js, wxml, wxss]) => ({ name, js: read(js), wxml: read(wxml), wxss: read(wxss) }))
const portraitViewports = [
  { width: 320, height: 568 },
  { width: 353, height: 745 },
  { width: 375, height: 812 },
  { width: 384, height: 824 },
  { width: 390, height: 844 },
  { width: 414, height: 896 },
]
const landscapeViewport = { width: 812, height: 375 }

function valuesFor(rules, selector, property) {
  return declarationValues(rules, selector, property)
}

function assertSafeAreaPair(rules, selector, inset) {
  const property = `padding-${inset}`
  const values = valuesFor(rules, selector, property)
  assert(values.some((value) => value.includes(`constant(safe-area-inset-${inset})`))
    && values.some((value) => value.includes(`env(safe-area-inset-${inset})`)),
  `${selector} 必须在自身 ${property} 声明中兼容 constant/env 安全区`)
}

function numericFontSizes(rules) {
  return rules.flatMap((rule) => rule.declarations
    .filter((declaration) => declaration.property === 'font-size')
    .map((declaration) => declaration.value))
}

for (const page of secondaryNavigationPages) {
  assert(page.wxml.includes('class="page-navigation"')
    && page.wxml.includes('bindtap="navigateFromPage"')
    && page.wxml.includes('aria-label="{{pageNavigationLabel}}"'),
  `${page.name} 二级页必须提供图标导航及动态可访问名称`)
  assert(page.wxml.includes("canNavigateBack ? 'back' : 'home'"),
    `${page.name} 必须区分返回与直达首页图标`)
  assert(page.wxss.includes('width: 48px') && page.wxss.includes('height: 48px')
    && page.wxss.includes('background: var(--surface)') && page.wxss.includes('color: var(--primary)')
    && page.wxss.includes('.page-navigation-pressed'),
  `${page.name} 导航必须保留 48px 热区、主题 token 和按压反馈`)
  assert(page.js.includes("getCurrentPages().length > 1")
    && page.js.includes("wx.navigateBack({ delta: 1, fail: goHome })")
    && page.js.includes("wx.switchTab({ url: PLAN_URL })"),
  `${page.name} 必须按页面栈返回，并在直达或返回失败时回餐单首页`)
}

assert(mealEditMarkup.includes('AI 生成') && !mealEditMarkup.includes('AI生成'),
  '餐食编辑页的 AI 来源标识必须保留中英文空格')
assert(!mealEditMarkup.includes('稳定餐食 ID') && !mealEditMarkup.includes('结构化食材'),
  '餐食编辑页不能向用户暴露内部数据结构术语')

const screenStyle = computedStyle(globalRules, '.screen', landscapeViewport)
assert.strictEqual(screenStyle['max-width'], '680px', '全局 screen 必须使用有效 px 内容上限')
assertSafeAreaPair(globalRules, '.screen', 'left')
assertSafeAreaPair(globalRules, '.screen', 'right')
for (const selector of ['button', 'input', 'textarea', 'picker']) {
  assert.strictEqual(computedStyle(globalRules, selector, { width: 400, height: 800 })['min-height'], '48px',
    `400px 及以下 ${selector} 必须保持至少 48px 高度`)
  assert.strictEqual(computedStyle(globalRules, selector, { width: 401, height: 800 })['min-height'], undefined,
    `${selector} 的全局窄屏覆盖不得泄漏到 401px`)
}

const pageRoots = {
  plan: '.plan-page',
  preview: '.preview-page',
  history: '.history-page',
  shopping: '.shopping-screen',
  mealEdit: '.screen',
}
for (const [name, selector] of Object.entries(pageRoots)) {
  const style = computedStyle(pageRules[name], selector, landscapeViewport)
  assert.strictEqual(style['max-width'], '680px', `${name} 页面根容器必须使用 680px 内容上限`)
  assert(!valuesFor(pageRules[name], selector, 'max-width').includes('920rpx'),
    `${name} 页面根容器不能继续使用会随视口扩大的 920rpx 上限`)
}

for (const [name, selector] of [['plan', '.plan-page'], ['preview', '.preview-page'], ['history', '.history-page']]) {
  assertSafeAreaPair(pageRules[name], selector, 'left')
  assertSafeAreaPair(pageRules[name], selector, 'right')
}

for (const [name, selector] of [['shopping', '.shopping-screen'], ['mealEdit', '.screen']]) {
  const rootDeclarations = rulesForSelector(pageRules[name], selector).flatMap((rule) => rule.declarations)
  assert(!rootDeclarations.some((declaration) => /safe-area-inset-(?:left|right)/.test(declaration.value)),
    `${name} 已使用全局 screen，同一根节点不能重复叠加左右安全区`)
}

const landscapeQuery = '(orientation: landscape) and (max-height: 500px)'
for (const [name, selector, property, expected] of [
  ['access', '.access-content', 'justify-content', 'flex-start'],
  ['planner', '.planner-screen', 'max-width', 'none'],
]) {
  assert(rulesForSelector(pageRules[name], selector, { media: landscapeQuery }).length > 0,
    `${name} 的横屏媒体查询必须直接绑定 ${selector}`)
  assert.strictEqual(computedStyle(pageRules[name], selector, landscapeViewport)[property], expected,
    `${name} 必须在 812x375 横屏实际应用 ${property}: ${expected}`)
  assertSafeAreaPair(pageRules[name], selector, 'left')
  assertSafeAreaPair(pageRules[name], selector, 'right')
}

for (const selector of [
  '.bottom-actions .back-button',
  '.bottom-actions .next-button',
  '.bottom-actions .task-action',
  '.bottom-actions .danger-button',
]) {
  const style = computedStyle(pageRules.planner, selector, landscapeViewport)
  assert.strictEqual(style['min-height'], '48px', `${selector} 横屏触控区必须至少 48px`)
  assert.strictEqual(style.height, '48px', `${selector} 横屏底栏必须保持稳定 48px 高度`)
}
assert(rulesForSelector(pageRules.profile, '.screen', { media: landscapeQuery }).length > 0,
  'Profile 横屏媒体查询必须直接绑定页面根容器')
assert.strictEqual(computedStyle(pageRules.profile, '.screen', landscapeViewport)['max-width'], 'none',
  'Profile 必须在 812x375 横屏解除窄内容上限')
assert.strictEqual(computedStyle(pageRules.profile, '.profile-save', landscapeViewport)['min-height'], '48px',
  'Profile 横屏主操作必须保留 48px 触控区')
const plannerStepHead = computedStyle(pageRules.planner, '.step-head', portraitViewports[2])
assert.strictEqual(plannerStepHead.position, 'sticky', 'Planner 步骤头必须在长确认页滚动时保持上下文')
assert.strictEqual(plannerStepHead.top, '0', 'Planner 步骤头必须吸附到页面顶端')
assert(Number(plannerStepHead['z-index']) >= 4, 'Planner 步骤头必须高于滚动内容且低于固定操作栏')
assert.strictEqual(plannerStepHead.background, 'var(--background)', '吸顶步骤头必须使用不透明页面背景')
const durationButton = computedStyle(pageRules.planner, '.duration-button', portraitViewports[2])
assert.strictEqual(durationButton.width, '48px', '天数步进按钮宽度必须匹配 48px 网格列')
assert.strictEqual(durationButton['min-width'], '0', '天数步进按钮必须覆盖微信原生最小宽度')
assert.strictEqual(durationButton['max-width'], '48px', '天数步进按钮不得扩张到网格列之外')
assert.strictEqual(durationButton['box-sizing'], 'border-box', '天数步进按钮边框必须计入稳定宽度')

for (const [name, rules] of [['Planner', pageRules.planner], ['Profile', pageRules.profile]]) {
  assert(!numericFontSizes(rules).some((value) => /^\d+(?:\.\d+)?rpx$/.test(value)),
    `${name} 不能使用随横屏宽度变化的 rpx 字号`)
}
for (const [name, rules] of [['Plan', pageRules.plan], ['MealCard', mealCardRules]]) {
  const fontSizes = numericFontSizes(rules)
  assert(!fontSizes.some((value) => /^\d+(?:\.\d+)?rpx$/.test(value)),
    `${name} 不能使用在 320px 设备继续缩小的 rpx 字号`)
  const pixelSizes = fontSizes.filter((value) => /^\d+(?:\.\d+)?px$/.test(value)).map(Number.parseFloat)
  assert(pixelSizes.length > 0, `${name} 必须显式声明稳定 px 字号`)
  assert(pixelSizes.every((size) => size >= 12), `${name} 的辅助文字不得小于 12px`)
}

assert(/errorAction:\s*'retry'/.test(mealEditSource)
  && /errorAction:\s*'back'/.test(mealEditSource),
'餐食编辑页必须区分可重试加载错误和无效路由参数')
assert(/backToPlan\(\)\s*\{\s*wx\.switchTab\(\{\s*url:\s*['"]\/pages\/plan\/plan['"]\s*\}\)\s*\}/.test(mealEditSource),
  '无效餐食参数必须通过 switchTab 返回餐单')
assert(/wx:if="\{\{errorAction === 'back'\}\}"[^>]+bindtap="backToPlan"[^>]*>返回餐单<\/button>/.test(mealEditMarkup),
  '无效餐食参数错误态必须显示“返回餐单”')
assert(/wx:else[^>]+bindtap="retry"[^>]*>重新读取<\/button>/.test(mealEditMarkup),
  '云端或数据加载错误必须继续提供“重新读取”')

const narrowPlan = { width: 599, height: 900 }
const widePlan = { width: 600, height: 900 }
const narrowDayList = computedStyle(pageRules.plan, '.day-list', narrowPlan)
const wideDayList = computedStyle(pageRules.plan, '.day-list', widePlan)
assert.strictEqual(gridRepeatCount(narrowDayList['grid-template-columns']), 4,
  '599px 及以下餐单日期必须使用 4+3 网格')
assert.strictEqual(gridRepeatCount(wideDayList['grid-template-columns']), 7,
  '600px 起餐单日期才允许恢复单行七列')
assert.strictEqual(narrowDayList.gap, '8px', '手机日期网格必须保持 8px 防误触间距')
assert(rulesForSelector(pageRules.plan, '.day-list', { media: '(min-width: 600px)' })
  .some((rule) => rule.declarations.some((declaration) => declaration.property === 'grid-template-columns'
    && gridRepeatCount(declaration.value) === 7)),
'600px 媒体查询必须直接绑定 .day-list 的七列声明')

for (const viewport of portraitViewports) {
  const pageStyle = computedStyle(pageRules.plan, '.plan-page', viewport)
  const listStyle = computedStyle(pageRules.plan, '.day-list', viewport)
  const columns = gridRepeatCount(listStyle['grid-template-columns'])
  const horizontalPadding = boxSidePx(pageStyle, 'padding', 'left', viewport.width)
    + boxSidePx(pageStyle, 'padding', 'right', viewport.width)
  const availableWidth = viewport.width - horizontalPadding
  const gap = lengthToPx(listStyle.gap, viewport.width)
  const columnWidth = (availableWidth - (gap * (columns - 1))) / columns
  const buttonStyle = computedStyle(pageRules.plan, '.day-button', viewport)
  const buttonHeight = lengthToPx(buttonStyle['min-height'], viewport.width)

  assert.strictEqual(columns, 4, `${viewport.width}px 手机必须实际应用 4+3 日期网格`)
  assert(columnWidth >= 48, `${viewport.width}px 下餐单日期横向热区必须达到 Android 48px`)
  assert(buttonHeight >= 48, `${viewport.width}px 下餐单日期纵向热区必须达到 Android 48px`)
}

for (const [selector, expected] of [
  ['.day-button.active', { background: 'var(--primary-fill)', color: 'var(--on-primary)' }],
  ['.week-button.active', { background: 'var(--primary-fill)', color: 'var(--on-primary)' }],
  ['.segment-button.active', { background: 'var(--primary-fill)', color: 'var(--on-primary)' }],
]) {
  const style = computedStyle(pageRules.plan, selector, portraitViewports[2])
  for (const [property, value] of Object.entries(expected)) {
    assert.strictEqual(style[property], value, `${selector} 必须使用 ${property}: ${value}`)
  }
}
const planMarkup = read('miniprogram/pages/plan/plan.wxml')
assert.strictEqual((planMarkup.match(/class="selection-mark"/g) || []).length, 4,
  '周、日期和两种晚餐选中态必须统一显示对勾，不能只依赖颜色')

const historyMealRowMedia = '(max-width: 340px), (orientation: landscape) and (max-height: 500px)'
assert(rulesForSelector(pageRules.history, '.meal-row', { media: historyMealRowMedia })
  .some((rule) => rule.declarations.some((declaration) => declaration.property === 'grid-template-columns'
    && declaration.value === 'minmax(0, 1fr)')),
'历史餐单窄屏/低矮横屏媒体查询必须直接绑定餐次行单列布局')
assert.strictEqual(computedStyle(pageRules.history, '.meal-row', { width: 375, height: 812 })['grid-template-columns'],
  'minmax(120rpx, 170rpx) minmax(0, 1fr)', '常规手机历史餐次应保留标签/标题双列扫描结构')
for (const viewport of [{ width: 320, height: 568 }, landscapeViewport]) {
  const mealRow = computedStyle(pageRules.history, '.meal-row', viewport)
  assert.strictEqual(mealRow['grid-template-columns'], 'minmax(0, 1fr)',
    `${viewport.width}x${viewport.height} 历史餐次必须实际折叠为单列`)

  const pageStyle = computedStyle(pageRules.history, '.history-page', viewport)
  const buttonStyle = computedStyle(pageRules.history, '.restore-action', viewport)
  const pageContentWidth = Math.min(viewport.width, lengthToPx(pageStyle['max-width'], viewport.width))
    - boxSidePx(pageStyle, 'padding', 'left', viewport.width)
    - boxSidePx(pageStyle, 'padding', 'right', viewport.width)
  const buttonWidth = lengthToPx(buttonStyle.width, viewport.width, { percentBase: pageContentWidth })
  const outerWidth = buttonWidth
    + boxSidePx(buttonStyle, 'margin', 'left', viewport.width)
    + boxSidePx(buttonStyle, 'margin', 'right', viewport.width)
  assert(outerWidth <= pageContentWidth + 0.01,
    `${viewport.width}x${viewport.height} 历史餐单操作按钮不得横溢卡片`)
}
const historyTitle = computedStyle(pageRules.history, '.plan-title', portraitViewports[0])
const sourceBadge = computedStyle(pageRules.history, '.source-badge', portraitViewports[0])
assert.strictEqual(historyTitle['min-width'], '0', '历史餐单长标题必须允许在弹性行内收缩')
assert.strictEqual(historyTitle['overflow-wrap'], 'anywhere', '历史餐单长标题必须允许安全换行')
assert.strictEqual(sourceBadge['max-width'], '100%', '历史餐单来源徽标不得撑宽卡片')
assert.strictEqual(sourceBadge['overflow-wrap'], 'anywhere', '历史餐单来源徽标必须允许安全换行')

console.log('page responsive container tests passed')
