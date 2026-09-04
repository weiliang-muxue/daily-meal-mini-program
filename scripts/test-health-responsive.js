'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const {
  borderSidePx,
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
const styles = read('miniprogram/pages/health/health.wxss')
const markup = read('miniprogram/pages/health/health.wxml')
const behavior = read('miniprogram/pages/health/health.js')
const rules = parseWxss(styles)
const narrowMedia = '(max-width: 400px)'
const narrowestMedia = '(max-width: 340px)'
const portraitViewports = [
  { width: 320, height: 568 },
  { width: 353, height: 745 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 400, height: 850 },
  { width: 414, height: 896 },
]

function assertDeclaration(selector, property, expected, viewport = portraitViewports[2]) {
  assert.strictEqual(computedStyle(rules, selector, viewport)[property], expected,
    `${selector} 必须实际应用 ${property}: ${expected}`)
}

function assertBoundToMedia(selector, property, expected, media = narrowMedia) {
  assert(rulesForSelector(rules, selector, { media }).some((rule) => rule.declarations
    .some((declaration) => declaration.property === property && declaration.value === expected)),
  `${media} 必须直接绑定 ${selector} 的 ${property}: ${expected}`)
}

for (const selector of ['.week-row', '.calendar-grid']) {
  assert.strictEqual(gridRepeatCount(computedStyle(rules, selector, portraitViewports[2])['grid-template-columns']), 7,
    `${selector} 必须使用七列弹性网格`)
  assert(!declarationValues(rules, selector, 'grid-template-columns')
    .some((value) => /minmax\((?:44px|88rpx),/.test(value)), `${selector} 不能使用固定最小列宽`)
}
assert(/<view class="calendar-scroll">/.test(markup),
  '月历必须使用完整可见的普通容器，不能依赖横向滚动发现被裁切日期')
assert(!/<scroll-view class="calendar-scroll"/.test(markup),
  '320px 月历不得继续使用横向滚动容器')
assertBoundToMedia('.calendar-scroll', 'max-width', '100%')
assertBoundToMedia('.calendar-scroll', 'overflow', 'visible')
assertBoundToMedia('.calendar-content', 'min-width', '0')
assertBoundToMedia('.calendar .day-cell', 'min-width', '0')
assertBoundToMedia('.calendar .day-cell', 'min-height', '48px')
assertBoundToMedia('.calendar .day-cell', 'min-height', '52px', narrowestMedia)
assertDeclaration('.calendar-scroll', 'max-width', '100%', portraitViewports[0])
assertDeclaration('.calendar-scroll', 'overflow', 'visible', portraitViewports[0])
assertDeclaration('.calendar-content', 'min-width', '0', portraitViewports[0])
assertDeclaration('.calendar .day-cell', 'min-height', '52px', portraitViewports[0])
assertDeclaration('.calendar .day-cell', 'min-height', '48px', portraitViewports[1])
assert.strictEqual(computedStyle(rules, '.calendar-content', { width: 401, height: 850 })['min-width'], '0',
  '月历内容不得设置会裁切七列的固定最小宽度')

const weightNumber = computedStyle(rules, '.weight-number', portraitViewports[0])
assert.strictEqual(weightNumber['overflow-wrap'], 'anywhere', '长体重值必须允许换行而不是裁切')
assert.strictEqual(weightNumber['white-space'], undefined, '体重值不得强制单行')
assert.strictEqual(weightNumber['text-overflow'], undefined, '体重值不得用省略号隐藏内容')

const narrowFontSelectors = [
  '.month-subtitle', '.field-hint', '.weight-number', '.exercise-mark', '.ring-unit', '.picker-field',
  '.metric-switch view', '.offline-strip', '.photo-privacy-error', '.field-error', '.form-error', '.state-detail',
]
for (const selector of narrowFontSelectors) {
  assertBoundToMedia(selector, 'font-size', '12px')
  assertDeclaration(selector, 'font-size', '12px', portraitViewports[0])
}

assertDeclaration('.day-cell.exercised', 'background', 'var(--exercise-calendar-surface)')
assert(computedStyle(rules, '.day-cell.exercised', portraitViewports[2])['box-shadow'],
  '运动日必须使用主题化的浅绿色整格背景和边界')
assertDeclaration('.exercise-mark', 'display', 'flex')
assertDeclaration('.exercise-mark', 'font-size', '12px', portraitViewports[0])
assertDeclaration('.exercise-card.saved', 'background', 'var(--exercise-saved-surface)')
assertDeclaration('.exercise-card.pending', 'background', 'var(--gold-soft)')
assertDeclaration('.exercise-card.cancel', 'background', 'var(--warm-soft)')
assertDeclaration('.activity-ring.saved', 'border-color', 'var(--exercise-saved-ring)')
assertDeclaration('.activity-ring.pending', 'border-style', 'dashed')
assertDeclaration('.activity-ring.cancel', 'border-style', 'dashed')
assertDeclaration('.activity-ring', 'width', '56px')
assertDeclaration('.activity-ring', 'height', '56px')
assertDeclaration('.activity-ring', 'border', '6px solid var(--exercise-idle-ring)')
assert(/<label class="exercise-row"[^>]*>[\s\S]*<switch /s.test(markup),
  '整条运动状态行必须通过原生 label 扩大开关触控区')
assert(markup.indexOf('class="exercise-card') < markup.indexOf('class="weight-row"'),
  '当天运动打卡必须排在体重与照片之前，避免首屏隐藏主任务')
assertDeclaration('.exercise-switch-target', 'width', '58px')
assertDeclaration('.exercise-switch-target', 'min-height', '48px')
assertBoundToMedia('.exercise-switch-target', 'width', '48px', narrowestMedia)
assert.strictEqual(gridRepeatCount(computedStyle(rules, '.exercise-summary', portraitViewports[2])['grid-template-columns']), 2,
  '周/月汇总必须使用两个稳定周期区')
assertDeclaration('.metric-ring', 'border', '5px solid var(--exercise-summary-idle-ring)')
assertDeclaration('.metric-ring.active', 'border-color', 'var(--exercise-summary-count-ring)')

assertBoundToMedia('.health-screen', 'padding-left', 'calc(12px + env(safe-area-inset-left))')
assertBoundToMedia('.health-screen', 'padding-right', 'calc(12px + env(safe-area-inset-right))')
const narrowHealth = computedStyle(rules, '.health-screen', portraitViewports[0])
assert.strictEqual(narrowHealth['padding-left'], 'calc(12px + env(safe-area-inset-left))',
  '窄屏记录卡必须保留 iPhone 左侧安全区与页面留白')
assert.strictEqual(narrowHealth['padding-right'], 'calc(12px + env(safe-area-inset-right))',
  '窄屏记录卡必须保留 iPhone 右侧安全区与页面留白')
for (const [property, expected] of [
  ['margin-left', '-12px'], ['margin-right', '-12px'], ['padding-left', '0'], ['padding-right', '0'],
  ['border-left', '0'], ['border-right', '0'], ['border-radius', '0'],
]) assertBoundToMedia('.calendar', property, expected)
for (const [property, expected] of [
  ['grid-template-columns', '48px minmax(0, 1fr) 48px'],
]) assertBoundToMedia('.month-nav', property, expected)
assertBoundToMedia('.month-button', 'width', '48px')
assertBoundToMedia('.month-button', 'height', '48px')
assertDeclaration('.month-nav', 'grid-template-columns', '48px minmax(0, 1fr) 48px', portraitViewports[0])
assertDeclaration('.month-button', 'width', '48px', portraitViewports[0])
assertDeclaration('.month-button', 'height', '48px', portraitViewports[0])
assert(markup.includes('class="month-chevron month-chevron-left"'),
  '上个月按钮必须使用统一的 CSS chevron 图形')
assert(markup.includes('class="month-chevron month-chevron-right"'),
  '下个月按钮必须使用统一的 CSS chevron 图形')
assert(!markup.includes('>‹</view>') && !markup.includes('>›</view>'),
  '月份导航不得依赖字体字符箭头，避免平台字形不一致')
assertDeclaration('.month-chevron', 'width', '14rpx')
assertDeclaration('.month-chevron', 'height', '14rpx')
assertDeclaration('.month-chevron', 'border-right', '2rpx solid currentColor')
assertDeclaration('.month-chevron', 'border-bottom', '2rpx solid currentColor')

for (const token of ['class="exercise-mark"', '<text>运动</text>', '{{exerciseStatus}}', '{{exerciseStatusSymbol}}']) {
  assert(markup.includes(token), `运动状态缺少非颜色标识：${token}`)
}
assert(/class="intensity-check \{\{exerciseIntensity === 'medium' \? 'visible' : ''\}\}"/.test(markup),
  '用户主动选择运动强度后必须显示对勾，不能只依赖颜色')
for (const token of [
  "exerciseTypeIndex: -1", "exerciseDuration: ''", "exerciseIntensity: ''",
  "exerciseTypeError: ''", "exerciseIntensityError: ''",
]) assert(behavior.includes(token), `新打卡不得预设运动字段：${token}`)
assert(markup.includes("exerciseTypeIndex < 0 ? '选择运动类型'"), '运动类型未选择时必须显示明确占位文案')
assert(markup.includes('placeholder="请输入"'), '运动时长不得预填分钟数')
for (const token of ['{{exerciseTypeError}}', '{{exerciseDurationError}}', '{{exerciseIntensityError}}']) {
  assert(markup.includes(token), `运动字段缺少就近错误提示：${token}`)
}
for (const id of ['exercise-type-error', 'exercise-duration-error', 'exercise-intensity-error']) {
  assert(markup.includes(`aria-describedby="${id}"`), `运动字段错误未与控件建立读屏关联：${id}`)
}
for (const selector of ['.intensity view.active', '.trend-switch view.active', '.metric-switch view.active']) {
  assertDeclaration(selector, 'background', 'var(--surface)')
  assertDeclaration(selector, 'color', 'var(--primary)')
}
for (const label of ['当天体重（千克）', '运动类型，当前', '运动时长（分钟）', '当天备注（可选）']) {
  assert(markup.includes(`aria-label="${label}`), `健康表单缺少读屏标签：${label}`)
}
for (const token of ['{{weightError}}', '{{exerciseTypeError}}', '{{exerciseDurationError}}', '{{exerciseIntensityError}}', '{{formError}}', '{{saveButtonText}}']) {
  assert(markup.includes(token), `健康表单缺少就地反馈：${token}`)
}
for (const status of ['已打卡', '未打卡', '待保存', '待更新', '待取消']) {
  assert(behavior.includes(`exerciseStatus: '${status}'`), `运动状态逻辑缺少：${status}`)
}
assert(markup.includes('color="{{exerciseSwitchColor}}"'), '原生运动开关颜色必须随亮暗主题切换')
assert(markup.includes('当天有记录'), '当天任意记录状态不得误写成运动已打卡')
assert(markup.includes('{{exerciseStatusHint}}'), '运动状态必须显示精确的辅助说明')
assert(markup.includes("hasWeekExercise ? 'active' : 'zero'"), '近 7 天零值环不得显示成达标绿环')
assert(markup.includes("hasMonthExercise ? 'active' : 'zero'"), '本月零值环不得显示成达标绿环')

for (const token of [
  '{{item.date}}',
  "selectedDate === item.date ? '已选中' : '未选中'",
  "item.weightText ? '已记录体重' : '未记录体重'",
  "item.exercised ? '已运动打卡' : '未运动打卡'",
  "item.hasPhoto ? '有体重照片' : '无体重照片'",
]) assert(markup.includes(token), `日期 aria-label 缺少状态：${token}`)

for (const viewport of portraitViewports) {
  const screenStyle = computedStyle(rules, '.health-screen', viewport)
  const screenHorizontalPadding = boxSidePx(screenStyle, 'padding', 'left', viewport.width)
    + boxSidePx(screenStyle, 'padding', 'right', viewport.width)
  const screenContentWidth = viewport.width - screenHorizontalPadding
  const calendarStyle = computedStyle(rules, '.calendar', viewport)
  const calendarOuterWidth = screenContentWidth
    - boxSidePx(calendarStyle, 'margin', 'left', viewport.width)
    - boxSidePx(calendarStyle, 'margin', 'right', viewport.width)
  const calendarInnerWidth = calendarOuterWidth
    - boxSidePx(calendarStyle, 'padding', 'left', viewport.width)
    - boxSidePx(calendarStyle, 'padding', 'right', viewport.width)
    - borderSidePx(calendarStyle, 'left', viewport.width)
    - borderSidePx(calendarStyle, 'right', viewport.width)
  const scrollStyle = computedStyle(rules, '.calendar-scroll', viewport)
  const scrollWidth = scrollStyle['max-width'] === '100%' ? calendarInnerWidth : calendarInnerWidth
  const contentStyle = computedStyle(rules, '.calendar-content', viewport)
  const contentMinWidth = lengthToPx(contentStyle['min-width'], viewport.width)
  const calendarContentWidth = Math.max(scrollWidth, contentMinWidth)
  const calendarGridStyle = computedStyle(rules, '.calendar-grid', viewport)
  const columns = gridRepeatCount(calendarGridStyle['grid-template-columns'])
  const columnWidth = calendarContentWidth / columns

  assert(calendarOuterWidth <= viewport.width + 0.01,
    `${viewport.width}px 月历外框不得横溢页面`)
  assert(scrollWidth > 0 && scrollWidth <= viewport.width,
    `${viewport.width}px 月历滚动视口不得横溢页面`)
  assert.strictEqual(columns, 7, `${viewport.width}px 月历必须实际保持七列`)
  if (viewport.width <= 400) {
    assert(calendarContentWidth <= scrollWidth + 0.01,
      `${viewport.width}px 下月历七列内容必须完整落在可视宽度内`)
    assert(columnWidth >= 44,
      `${viewport.width}px 下完整七列日期横向热区应至少达到 iOS 44pt`)
  }

  const dayCellStyle = computedStyle(rules, viewport.width <= 400 ? '.calendar .day-cell' : '.day-cell', viewport)
  assert(lengthToPx(dayCellStyle['min-height'], viewport.width) >= 48,
    `${viewport.width}px 下月历日期纵向热区应达到 Android 48dp`)

  const recordStyle = computedStyle(rules, '.record-card', viewport)
  const recordInnerWidth = screenContentWidth
    - boxSidePx(recordStyle, 'padding', 'left', viewport.width)
    - boxSidePx(recordStyle, 'padding', 'right', viewport.width)
    - borderSidePx(recordStyle, 'left', viewport.width)
    - borderSidePx(recordStyle, 'right', viewport.width)
  const rowStyle = computedStyle(rules, '.exercise-row', viewport)
  const ringWidth = lengthToPx(computedStyle(rules, '.activity-ring', viewport).width, viewport.width)
  const switchWidth = lengthToPx(computedStyle(rules, '.exercise-switch-target', viewport).width, viewport.width)
  const rowGap = lengthToPx(rowStyle.gap, viewport.width)
  assert(recordInnerWidth > ringWidth + switchWidth + (rowGap * 2),
    `${viewport.width}px 运动状态行必须给辅助文案保留弹性宽度`)

  const summaryStyle = computedStyle(rules, '.exercise-summary', viewport)
  const summaryGap = lengthToPx(summaryStyle.gap, viewport.width)
  const summaryPeriodWidth = (recordInnerWidth - summaryGap) / 2
  const ringsStyle = computedStyle(rules, '.summary-rings', viewport)
  const ringGap = lengthToPx(ringsStyle.gap, viewport.width)
  const metricRingWidth = lengthToPx(computedStyle(rules, '.metric-ring', viewport).width, viewport.width)
  assert(summaryPeriodWidth >= (metricRingWidth * 2) + ringGap,
    `${viewport.width}px 周/月双环不得横溢`)
}

assertBoundToMedia('.exercise-row', 'grid-template-columns', '48px minmax(0, 1fr) 48px', narrowestMedia)
assertBoundToMedia('.metric-ring', 'width', '53px', narrowestMedia)
assert.strictEqual(computedStyle(rules, '.exercise-row', portraitViewports[0])['grid-template-columns'],
  '48px minmax(0, 1fr) 48px', '320px 运动状态行必须实际应用窄屏列宽')
assert.strictEqual(computedStyle(rules, '.exercise-switch-target', portraitViewports[0]).width, '48px',
  '320px 运动开关容器不得超出窄屏网格列')
assert.strictEqual(computedStyle(rules, '.metric-ring', portraitViewports[0]).width, '53px',
  '320px 汇总环必须实际应用窄屏尺寸')
assert.strictEqual(computedStyle(rules, '.metric-ring', portraitViewports[1]).width, '56px',
  '341px 及以上汇总环不得继续套用最窄屏尺寸')

console.log('health responsive calendar tests passed')
