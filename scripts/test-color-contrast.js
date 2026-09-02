'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const normalizeNewlines = (source) => String(source).replace(/\r\n?/g, '\n')
const styles = normalizeNewlines(fs.readFileSync(path.join(root, 'miniprogram/app.wxss'), 'utf8'))
const healthBehavior = fs.readFileSync(path.join(root, 'miniprogram/pages/health/health.js'), 'utf8')
const darkTheme = styles.match(/@media \(prefers-color-scheme: dark\) \{\s*page \{([\s\S]*?)\n  \}\n\}/)

assert.strictEqual(normalizeNewlines('light\r\ndark\rlegacy'), 'light\ndark\nlegacy',
  '颜色令牌测试必须同时兼容 LF、CRLF 与旧 CR 换行')
assert(darkTheme, '必须保留暗色主题令牌')

function tokensFrom(source) {
  return Object.fromEntries([...source.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/gi)]
    .map((match) => [match[1], match[2].toLowerCase()]))
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/../g).map((channel) => parseInt(channel, 16) / 255)
  const linear = channels.map((channel) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4)
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2])
}

function contrast(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground)
  const backgroundLuminance = relativeLuminance(background)
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
}

function expectContrast(theme, tokens, foreground, background, minimum) {
  const ratio = contrast(tokens[foreground], tokens[background])
  assert(ratio >= minimum,
    `${theme} ${foreground} 对 ${background} 的对比度 ${ratio.toFixed(2)}:1 低于 ${minimum}:1`)
}

const lightTokens = tokensFrom(styles.slice(0, styles.indexOf('@media (prefers-color-scheme: dark)')))
const darkTokens = tokensFrom(darkTheme[1])
const controlSurfaces = ['surface', 'input-surface', 'primary-soft', 'surface-muted', 'background']

expectContrast('浅色', lightTokens, 'checked-text', 'surface', 4.5)
expectContrast('暗色', darkTokens, 'checked-text', 'surface', 4.5)

for (const [theme, tokens] of [['浅色', lightTokens], ['暗色', darkTokens]]) {
  controlSurfaces.forEach((surface) => expectContrast(theme, tokens, 'line-strong', surface, 3))
  expectContrast(theme, tokens, 'exercise-calendar-ink', 'exercise-calendar-surface', 4.5)
  expectContrast(theme, tokens, 'exercise-saved-ink', 'exercise-saved-surface', 4.5)
  expectContrast(theme, tokens, 'exercise-saved-ink', 'exercise-saved-chip', 4.5)
}

const chartPalettes = healthBehavior.match(/this\.currentTheme === 'dark'[\s\S]*?\?\s*\{\s*surface:\s*'(#[\da-f]{6})',\s*line:\s*'(#[\da-f]{6})'[\s\S]*?:\s*\{\s*surface:\s*'(#[\da-f]{6})',\s*line:\s*'(#[\da-f]{6})'/i)
assert(chartPalettes, '健康页必须保留可审查的亮暗 Canvas 调色板')
for (const [theme, surface, line] of [
  ['暗色', chartPalettes[1], chartPalettes[2]],
  ['浅色', chartPalettes[3], chartPalettes[4]],
]) {
  const ratio = contrast(line, surface)
  assert(ratio >= 3, `健康页${theme} Canvas 轴线对背景的对比度 ${ratio.toFixed(2)}:1 低于 3:1`)
}

console.log('color contrast token tests passed')
