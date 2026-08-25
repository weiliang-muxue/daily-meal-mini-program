const assert = require('assert')
const path = require('path')
const fs = require('fs')

const root = path.resolve(__dirname, '..')
const { catalog, plans, shoppingGroups } = require(path.join(root, 'miniprogram/data/meal-plan'))
const { normalize } = require(path.join(root, 'miniprogram/services/user-store'))
const { calendarCells } = require(path.join(root, 'miniprogram/utils/date'))

assert.strictEqual(catalog.defaultPlanId, plans[0].id)
assert.strictEqual(plans[0].days.length, 7, '第一周期必须有 7 天')
assert.strictEqual(new Set(plans.map((plan) => plan.id)).size, plans.length, 'planId 必须唯一')

const dayIds = plans.flatMap((plan) => plan.days.map((day) => day.id))
assert.strictEqual(new Set(dayIds).size, dayIds.length, 'dayId 必须全局唯一')

const dinners = plans[0].days.flatMap((day) => [day.restDinner.title, day.workoutDinner.title])
assert.strictEqual(dinners.length, 14)
assert.strictEqual(new Set(dinners).size, 14, '14 套晚餐标题必须不同')
plans[0].days.forEach((day) => {
  assert(day.breakfast && day.restDinner && day.workoutDinner, `${day.id} 三餐数据不完整`)
  assert.notStrictEqual(day.restDinner.ingredients, day.workoutDinner.ingredients, `${day.id} 两种晚餐食材不能相同`)
})

const shoppingIds = shoppingGroups.flatMap((group) => group.items.map((item) => item.id))
assert.strictEqual(new Set(shoppingIds).size, shoppingIds.length, '采购 ID 必须唯一')

const migrated = normalize({
  schemaVersion: 1,
  selectedDay: 3,
  dinnerMode: 'workout',
  checkedShoppingIds: ['milk', 'tofu'],
  customReminders: [{ id: 'old-reminder', text: '带补充剂瓶身复诊', done: false }],
  futureClientField: 'keep-me',
})
assert.strictEqual(migrated.schemaVersion, 4)
assert.strictEqual(migrated.selectedDay, 3)
assert.strictEqual(migrated.defaultDinnerMode, 'workout')
assert.deepStrictEqual(migrated.checkedShoppingIds, ['milk', 'tofu'])
assert.strictEqual(migrated.customReminders[0].id, 'old-reminder')
assert.strictEqual(migrated.futureClientField, 'keep-me', '本地迁移不应删除未知字段')
assert.deepStrictEqual(migrated.mealOverrides, {}, '旧数据迁移需补齐个人餐食覆盖')

const calendar = calendarCells('2026-08', [
  { date: '2026-08-24', weight: 62.1, exercise: null },
  { date: '2026-08-25', weight: 61.8, exercise: { completed: true }, hasPhoto: true },
])
const day24 = calendar.find((cell) => cell.date === '2026-08-24')
const day25 = calendar.find((cell) => cell.date === '2026-08-25')
assert.strictEqual(calendar.length, 42, '月历必须保持固定 6 行')
assert.strictEqual(day24.weightText, '62.1')
assert.strictEqual(day25.weightText, '61.8')
assert.strictEqual(day25.exercised, true)
assert.strictEqual(day25.hasPhoto, true)

const requiredFiles = [
  'project.config.json', 'miniprogram/app.json', 'miniprogram/app.js',
  'cloudfunctions/membership/index.js', 'cloudfunctions/auth/index.js', 'cloudfunctions/userData/index.js', 'cloudfunctions/health/index.js', 'cloudfunctions/privacy/index.js',
  'database.rules.json', 'docs/DEPLOY.md', 'docs/PRIVACY.md',
  'database.indexes.json', 'cloudfunctions/membership/.env.example',
  'source-assets/meal-plan-gpt-image-2.png', 'miniprogram/assets/meal-plan-cover.jpg',
]
requiredFiles.forEach((file) => assert(fs.existsSync(path.join(root, file)), `缺少 ${file}`))

const appConfig = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'))
appConfig.pages.forEach((page) => ['js', 'json', 'wxml', 'wxss'].forEach((extension) => {
  assert(fs.existsSync(path.join(root, `miniprogram/${page}.${extension}`)), `页面缺少 ${page}.${extension}`)
}))

const jsFiles = []
const wxmlFiles = []
function walk(directory) {
  fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    if (entry.name === 'node_modules') return
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(fullPath)
    else if (entry.name.endsWith('.js')) jsFiles.push(fullPath)
    else if (entry.name.endsWith('.wxml')) wxmlFiles.push(fullPath)
  })
}
walk(root)
jsFiles.forEach((file) => new Function(fs.readFileSync(file, 'utf8')))
wxmlFiles.forEach((file) => {
  const source = fs.readFileSync(file, 'utf8')
  assert(!/\bwx:else-if\b/.test(source), `${path.relative(root, file)} 使用了无效的 wx:else-if，请改用 wx:elif`)
})

console.log(`验证通过：${plans.length} 个周期，${dayIds.length} 天，${dinners.length} 套差异化晚餐，${shoppingIds.length} 个采购项，${jsFiles.length} 个 JS 文件及 ${wxmlFiles.length} 个 WXML 文件检查正常。`)
