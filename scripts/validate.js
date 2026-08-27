'use strict'

const assert = require('assert')
const childProcess = require('child_process')
const path = require('path')
const fs = require('fs')

const root = path.resolve(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const releaseManifest = JSON.parse(read('release-manifest.json'))
const stateSchema = require(path.join(root, 'shared/user-state'))
const aiPlanner = require(path.join(root, 'cloudfunctions/aiPlanner/lib'))
const membershipCore = require(path.join(root, 'cloudfunctions/membership/core'))
const { calendarCells } = require(path.join(root, 'miniprogram/utils/date'))
const CLOUD_FUNCTIONS = [
  'aiPlanner', 'auth', 'health', 'mealAiMaintenance',
  'membership', 'ownerBootstrapOnce', 'privacy', 'userData',
]
const WX_SERVER_SDK_VERSION = '4.0.2'

const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
assert(semverPattern.test(releaseManifest.lastReleasedVersion), '最后发布版本必须是 SemVer')
assert(semverPattern.test(releaseManifest.workingVersion), '工作版本必须是 SemVer')
assert(['unreleased', 'released'].includes(releaseManifest.releaseStatus), '发布状态无效')
assert.strictEqual(releaseManifest.stateSchemaVersion, 6, '当前发布清单必须使用 schema v6')
assert.strictEqual(stateSchema.CURRENT_SCHEMA, releaseManifest.stateSchemaVersion, '共享 schema 与版本清单不一致')
assert.strictEqual(aiPlanner.CONTRACT_VERSION, releaseManifest.aiContractVersion, 'AI 契约与版本清单不一致')
assert.strictEqual(aiPlanner.PLANNER_VERSION, releaseManifest.aiPlannerVersion, 'AI 生成器与版本清单不一致')
assert(releaseManifest.minimumMigratableStateSchemaVersion <= releaseManifest.stateSchemaVersion, '最低可迁移 schema 不能高于当前版本')

const sharedSource = read('shared/user-state.js')
;[
  'miniprogram/services/user-state-core.js',
  'cloudfunctions/userData/user-state.js',
  'cloudfunctions/aiPlanner/user-state.js',
].forEach((file) => assert.strictEqual(read(file), sharedSource, `${file} 未与 shared/user-state.js 同步`))
assert.strictEqual(read('cloudfunctions/privacy/membership-core.js'), read('cloudfunctions/membership/core.js'), 'privacy 成员控制逻辑未同步')

const fresh = stateSchema.defaults()
assert.strictEqual(fresh.schemaVersion, 6)
assert.strictEqual(fresh.activePlan, null, '新用户不能自动获得静态计划')
assert.strictEqual(fresh.draftPlan, null, '新用户默认不应存在候选计划')
assert.deepStrictEqual(fresh.planHistory, [], '新用户历史计划必须为空')
assert.strictEqual(fresh.generationPreferences.durationDays, 7)
assert.deepStrictEqual(fresh.generationPreferences.mealTypes, [], '餐次必须由用户主动选择')

const preferenceBase = {
  contractVersion: aiPlanner.CONTRACT_VERSION,
  startDate: '2026-08-26',
  mealTypes: ['breakfast', 'lunch', 'snack'],
  doubleDinner: false,
  goals: [], styles: [], customGoal: '', restrictions: '', healthNotes: '', exerciseNotes: '', exerciseByDay: [],
}
assert.strictEqual(aiPlanner.normalizeRequest({ ...preferenceBase, durationDays: 7 }).durationDays, 7)
assert.strictEqual(aiPlanner.normalizeRequest({ ...preferenceBase, durationDays: 14 }).durationDays, 14)
assert.deepStrictEqual(aiPlanner.expectedMealKeys(aiPlanner.normalizeRequest({ ...preferenceBase, durationDays: 7 })), [
  'breakfast:default', 'lunch:default', 'snack:default',
])
assert.deepStrictEqual(aiPlanner.expectedMealKeys(aiPlanner.normalizeRequest({
  ...preferenceBase, durationDays: 14, mealTypes: ['dinner'], doubleDinner: true,
})), ['dinner:rest', 'dinner:workout'])

const requiredPages = [
  'pages/plan/plan', 'pages/planner/planner', 'pages/plan-preview/plan-preview', 'pages/plan-history/plan-history',
  'pages/health/health', 'pages/shopping/shopping', 'pages/guide/guide', 'pages/profile/profile', 'pages/meal-edit/meal-edit',
]
const appConfig = JSON.parse(read('miniprogram/app.json'))
requiredPages.forEach((page) => assert(appConfig.pages.includes(page), `app.json 缺少路由 ${page}`))
appConfig.pages.forEach((page) => ['js', 'json', 'wxml', 'wxss'].forEach((extension) => {
  assert(fs.existsSync(path.join(root, `miniprogram/${page}.${extension}`)), `页面缺少 miniprogram/${page}.${extension}`)
}))

const requiredFiles = [
  'project.config.example.json', 'project.private.config.example.json', 'miniprogram/config.example.js',
  'miniprogram/app.json', 'miniprogram/app.js',
  'miniprogram/services/user-state-core.js', 'miniprogram/services/plan-view.js',
  'cloudfunctions/membership/index.js', 'cloudfunctions/membership/core.js', 'cloudfunctions/membership/core.test.js',
  'cloudfunctions/auth/index.js', 'cloudfunctions/userData/index.js',
  'cloudfunctions/userData/index.test.js',
  'cloudfunctions/aiPlanner/index.js', 'cloudfunctions/aiPlanner/lib.js', 'cloudfunctions/aiPlanner/lib.test.js',
  'cloudfunctions/aiPlanner/task-core.js', 'cloudfunctions/aiPlanner/task-core.test.js',
  'cloudfunctions/aiPlanner/provider-config.js', 'cloudfunctions/aiPlanner/provider-config.test.js',
  'cloudfunctions/aiPlanner/transport.js', 'cloudfunctions/aiPlanner/transport.test.js',
  'cloudfunctions/aiPlanner/index.test.js', 'cloudfunctions/late-write-guard.test.js',
  'cloudfunctions/mealAiMaintenance/index.js', 'cloudfunctions/mealAiMaintenance/core.js',
  'cloudfunctions/mealAiMaintenance/core.test.js', 'cloudfunctions/mealAiMaintenance/index.test.js',
  'cloudfunctions/mealAiMaintenance/config.json', 'cloudfunctions/mealAiMaintenance/package.json',
  'cloudfunctions/health/index.js', 'cloudfunctions/privacy/index.js', 'cloudfunctions/privacy/membership-core.js',
  'cloudfunctions/privacy/core.js', 'cloudfunctions/privacy/core.test.js',
  'cloudfunctions/auth/image-file.js', 'cloudfunctions/health/image-file.js',
  'cloudfunctions/auth/image-source.js', 'cloudfunctions/health/image-source.js',
  'cloudfunctions/auth/upload-ticket.js', 'cloudfunctions/health/upload-ticket.js',
  'cloudfunctions/privacy/upload-ticket.js',
  'shared/upload-ticket.js', 'shared/upload-ticket.test.js',
  'miniprogram/utils/private-image.js',
  'database.rules.json', 'database.indexes.json', 'storage.rules.json',
  'cloudfunctions/membership/.env.example', 'cloudfunctions/aiPlanner/.env.example',
  'release-manifest.json', 'CHANGELOG.md', 'SUPPORT.md', 'SECURITY.md',
  'scripts/test-ai-provider-live.js', 'scripts/check-staged-safety.test.js',
  '.github/workflows/validate.yml', '.github/PULL_REQUEST_TEMPLATE.md',
  'docs/DEPLOY.md', 'docs/DATABASE.md', 'docs/PRIVACY.md', 'docs/VERSIONING.md', 'docs/RELEASE_CHECKLIST.md',
  'source-assets/meal-plan-gpt-image-2.png', 'miniprogram/assets/meal-plan-cover.jpg',
]
requiredFiles.forEach((file) => assert(fs.existsSync(path.join(root, file)), `缺少 ${file}`))

CLOUD_FUNCTIONS.forEach((functionName) => {
  const directory = `cloudfunctions/${functionName}`
  const packageManifest = JSON.parse(read(`${directory}/package.json`))
  const lock = JSON.parse(read(`${directory}/package-lock.json`))
  assert.strictEqual(packageManifest.dependencies['wx-server-sdk'], WX_SERVER_SDK_VERSION,
    `${functionName} 必须精确固定 wx-server-sdk ${WX_SERVER_SDK_VERSION}`)
  assert.strictEqual(lock.lockfileVersion, 3, `${functionName} package-lock 必须使用 lockfile v3`)
  assert.strictEqual(lock.packages[''].dependencies['wx-server-sdk'], WX_SERVER_SDK_VERSION,
    `${functionName} lockfile 根依赖与 package.json 不一致`)
  assert.strictEqual(lock.packages['node_modules/wx-server-sdk'].version, WX_SERVER_SDK_VERSION,
    `${functionName} lockfile 未解析到 wx-server-sdk ${WX_SERVER_SDK_VERSION}`)
})

const ownerBootstrapSource = read('cloudfunctions/ownerBootstrapOnce/index.js')
const ownerBootstrapCore = read('cloudfunctions/ownerBootstrapOnce/core.js')
assert(!/wx_devtools|assertDevtoolsSource/.test(`${ownerBootstrapSource}\n${ownerBootstrapCore}`),
  '首次管理员初始化不能把开发者工具来源当作授权')
assert(/BOOTSTRAP_CLIENT_DENIED/.test(ownerBootstrapSource), '管理员激活必须拒绝带终端身份的调用')
assert(/approvedTargetDigest/.test(ownerBootstrapCore) && /requestReference\.remove\(\)/.test(ownerBootstrapSource),
  '管理员初始化必须原子消费云端批准记录')

const aiPlaceholderLines = read('cloudfunctions/aiPlanner/.env.example').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
const aiPlaceholders = Object.fromEntries(aiPlaceholderLines.map((line) => {
  const separator = line.indexOf('=')
  assert(separator > 0, 'AI 环境变量占位文件格式无效')
  return [line.slice(0, separator), line.slice(separator + 1)]
}))
assert.deepStrictEqual(Object.keys(aiPlaceholders).sort(), [
  'AI_API_KEY', 'AI_MAX_TOKENS', 'AI_TIMEOUT_MS',
])
assert.strictEqual(aiPlaceholders.AI_API_KEY, 'YOUR_AI_API_KEY')
const aiProviderConfig = require(path.join(root, 'cloudfunctions/aiPlanner/provider-config'))
assert.strictEqual(aiProviderConfig.DEFAULT_ENDPOINT, 'https://gptpro.live/v1/responses')
assert.strictEqual(aiProviderConfig.DEFAULT_MODEL, 'gpt-5.6')
assert.strictEqual(aiProviderConfig.DEFAULT_API_STYLE, 'responses')
assert.strictEqual(aiProviderConfig.DEFAULT_REASONING_EFFORT, 'xhigh')
assert.deepStrictEqual(aiProviderConfig.configuration({ AI_API_KEY: 'TEST_PLACEHOLDER_ONLY' }), {
  configured: true,
  url: new URL('https://gptpro.live/v1/responses'),
  apiKey: 'TEST_PLACEHOLDER_ONLY',
  model: 'gpt-5.6',
  apiStyle: 'responses',
  extraHeaders: { 'x-openai-actor-authorization': 'local-image-extension' },
  temperature: undefined,
  reasoningEffort: 'xhigh',
  timeoutMs: 45000,
  maxTokens: 16000,
})

const membershipPlaceholderLines = read('cloudfunctions/membership/.env.example').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
const membershipPlaceholders = Object.fromEntries(membershipPlaceholderLines.map((line) => {
  const separator = line.indexOf('=')
  assert(separator > 0, '成员环境变量占位文件格式无效')
  return [line.slice(0, separator), line.slice(separator + 1)]
}))
assert.deepStrictEqual(Object.keys(membershipPlaceholders).sort(), [
  'INVITE_SLOTS', 'INVITE_TTL_HOURS',
])
assert.strictEqual(membershipPlaceholders.INVITE_SLOTS, '6')
assert.strictEqual(membershipPlaceholders.INVITE_TTL_HOURS, '24')
assert.deepStrictEqual(membershipCore.configuration(membershipPlaceholders), {
  inviteSlots: 6, inviteTtlHours: 24, maxMembers: 7, inviteTtlMs: 86400000,
})

const membershipFiles = [
  'cloudfunctions/membership/core.js', 'cloudfunctions/membership/index.js', 'cloudfunctions/membership/.env.example',
  'cloudfunctions/privacy/index.js', 'cloudfunctions/privacy/membership-core.js',
]
membershipFiles.forEach((file) => {
  const source = read(file)
  assert(!/\bMAX_MEMBERS\b/.test(source), `${file} 仍包含旧成员总数配置`)
  assert(!/\bINVITE_TTL_DAYS\b/.test(source), `${file} 仍包含旧按天邀请有效期配置`)
})

const databaseIndexes = JSON.parse(read('database.indexes.json')).indexes
assert.strictEqual(databaseIndexes.length, 8, '部署清单必须包含八个复合索引')
const hasIndex = (collectionName, fields) => databaseIndexes.some((index) => (
  index.collectionName === collectionName
  && JSON.stringify(index.fields.map((field) => field.fieldPath)) === JSON.stringify(fields)
))
const hasOrderedIndex = (collectionName, fields) => databaseIndexes.some((index) => (
  index.collectionName === collectionName
  && JSON.stringify(index.fields) === JSON.stringify(fields)
))
assert(hasIndex('meal_invites', ['codeHash', 'active']), '缺少邀请码验证索引')
assert(hasIndex('meal_members', ['memberRef', 'status']), '缺少管理员转移成员查询索引')
assert(hasOrderedIndex('meal_ai_tasks', [
  { fieldPath: 'owner', order: 'ASCENDING' },
  { fieldPath: 'status', order: 'ASCENDING' },
  { fieldPath: 'createdAt', order: 'DESCENDING' },
]), '缺少当前用户最近 AI 任务索引')
assert(hasOrderedIndex('meal_ai_tasks', [
  { fieldPath: 'status', order: 'ASCENDING' },
  { fieldPath: 'expiresAt', order: 'ASCENDING' },
]), '缺少 AI 过期任务清理索引')
assert(hasOrderedIndex('meal_ai_shards', [
  { fieldPath: 'owner', order: 'ASCENDING' },
  { fieldPath: 'taskId', order: 'ASCENDING' },
]), '缺少 AI 任务分片索引')
assert(hasOrderedIndex('meal_ai_tasks', [
  { fieldPath: 'shardCleanupPending', order: 'ASCENDING' },
  { fieldPath: 'shardCleanupUpdatedAtMs', order: 'ASCENDING' },
]), '缺少 AI 遗留分片轮转清理索引')

const maintenanceConfig = JSON.parse(read('cloudfunctions/mealAiMaintenance/config.json'))
assert.deepStrictEqual(maintenanceConfig.triggers, [{
  name: 'mealAiRetentionSweep', type: 'timer', config: '0 */30 * * * * *',
}], 'AI 维护函数必须配置 UTC+8 每 30 分钟定时触发器')
const maintenanceSource = read('cloudfunctions/mealAiMaintenance/index.js')
assert(/getWXContext\(\)/.test(maintenanceSource) && /SOURCE/.test(maintenanceSource) && /wx_trigger/.test(maintenanceSource), 'AI 维护函数必须只接受可信定时触发')
assert(!/OPENID|event\.expiresAt|event\.now/.test(maintenanceSource), 'AI 维护函数不能依赖用户身份或事件传入时间')
assert(!/meal_user_states/.test(maintenanceSource), 'AI 维护函数不能访问候选、当前或历史计划集合')

const databaseRules = JSON.parse(read('database.rules.json'))
;['meal_ai_tasks', 'meal_ai_shards', 'meal_ai_controls'].forEach((collectionName) => {
  assert.deepStrictEqual(databaseRules[collectionName], { read: false, write: false }, `${collectionName} 必须拒绝客户端读写`)
})

const storageRules = JSON.parse(read('storage.rules.json'))
assert.deepStrictEqual(storageRules, { read: false, write: false }, '云存储必须拒绝全部客户端读写')
const clientSources = [
  'miniprogram/pages/profile/profile.js', 'miniprogram/pages/health/health.js',
  'miniprogram/services/auth-store.js', 'miniprogram/services/health-store.js',
].map(read).join('\n')
assert(!/wx\.cloud\.uploadFile|prepareAvatar|preparePhoto|avatar-inbox|health-inbox/.test(clientSources),
  '客户端不能直接写云存储或请求 inbox 上传票据')
assert(/wxApi\.cloud\.CDN/.test(read('miniprogram/utils/private-image.js')),
  '私有图片必须通过微信临时 CDN 交给成员校验后的云函数')

const runtimeFiles = [
  'miniprogram/pages/plan/plan.js', 'miniprogram/pages/planner/planner.js', 'miniprogram/pages/shopping/shopping.js',
  'miniprogram/services/user-store.js', 'miniprogram/services/plan-view.js', 'cloudfunctions/aiPlanner/index.js',
]
runtimeFiles.forEach((file) => assert(!/data[\\/]meal-plan|legacy-plan|defaultPlanId/.test(read(file)), `${file} 不能使用静态计划兜底`))
assert(/legacyPlanFor/.test(read('cloudfunctions/userData/index.js')), '旧静态计划必须保留为 v1-v4 迁移输入')

const calendar = calendarCells('2026-08', [
  { date: '2026-08-24', weight: 62.1, exercise: null },
  { date: '2026-08-25', weight: 61.8, exercise: { completed: true }, hasPhoto: true },
])
const day24 = calendar.find((cell) => cell.date === '2026-08-24')
const day25 = calendar.find((cell) => cell.date === '2026-08-25')
assert.strictEqual(calendar.length, 42, '月历必须保持固定 6 行')
assert.strictEqual(day24.weightText, '62.1')
assert.strictEqual(day25.exercised, true)
assert.strictEqual(day25.hasPhoto, true)

const jsFiles = []
const wxmlFiles = []
function walk(directory) {
  fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    if (['node_modules', '.git', '.local'].includes(entry.name)) return
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(fullPath)
    else if (entry.name.endsWith('.js')) jsFiles.push(fullPath)
    else if (entry.name.endsWith('.wxml')) wxmlFiles.push(fullPath)
  })
}
walk(path.join(root, 'miniprogram'))
walk(path.join(root, 'cloudfunctions'))
walk(path.join(root, 'shared'))
jsFiles.forEach((file) => new Function(fs.readFileSync(file, 'utf8')))
wxmlFiles.forEach((file) => {
  const source = fs.readFileSync(file, 'utf8')
  assert(!/\bwx:else-if\b/.test(source), `${path.relative(root, file)} 使用了无效的 wx:else-if，请改用 wx:elif`)
  source.split(/\r?\n/).forEach((line, index) => {
    if (/<view\b[^>]*\bbindtap=/.test(line)) {
      assert(/\btouch-target\b/.test(line), `${path.relative(root, file)}:${index + 1} 自定义点击区域缺少 touch-target`)
    }
  })
})
const globalStyles = read('miniprogram/app.wxss')
assert(/@media \(max-width: 400px\)[\s\S]*button, input, picker \{ min-height: 48px !important; \}/.test(globalStyles),
  '窄屏原生交互控件必须保持至少 48px 高度')
assert(/\.touch-target \{ min-width: 48px; min-height: 48px; \}/.test(globalStyles),
  '窄屏自定义点击区域必须保持至少 48px 热区')
const healthStyles = read('miniprogram/pages/health/health.wxss')
assert(/repeat\(7, minmax\(44px, 1fr\)\)/.test(healthStyles), '窄屏健康月历必须保持七列 44px 点击热区')

const testScripts = [
  'shared/user-state.test.js',
  'cloudfunctions/userData/index.test.js',
  'shared/image-file.test.js',
  'shared/image-source.test.js',
  'shared/upload-ticket.test.js',
  'cloudfunctions/membership/core.test.js',
  'cloudfunctions/membership/index.test.js',
  'cloudfunctions/membership-control-guard.test.js',
  'cloudfunctions/auth/profile-core.test.js',
  'cloudfunctions/auth/index.test.js',
  'cloudfunctions/health/daily-core.test.js',
  'cloudfunctions/health/index.test.js',
  'cloudfunctions/ownerBootstrapOnce/core.test.js',
  'cloudfunctions/ownerBootstrapOnce/index.test.js',
  'cloudfunctions/aiPlanner/lib.test.js',
  'cloudfunctions/aiPlanner/provider-config.test.js',
  'cloudfunctions/aiPlanner/not-found.test.js',
  'cloudfunctions/aiPlanner/transport.test.js',
  'cloudfunctions/aiPlanner/task-core.test.js',
  'cloudfunctions/aiPlanner/index.test.js',
  'cloudfunctions/mealAiMaintenance/core.test.js',
  'cloudfunctions/mealAiMaintenance/index.test.js',
  'cloudfunctions/late-write-guard.test.js',
  'scripts/test-plan-view.js',
  'scripts/test-shopping-scope.js',
  'scripts/test-cache-namespace.js',
  'scripts/test-private-cache.js',
  'scripts/test-private-image.js',
  'scripts/test-cloud-errors.js',
  'scripts/test-ai-planner-client.js',
  'scripts/test-planner-page.js',
  'scripts/test-plan-history-page.js',
  'scripts/test-health-guide-pages.js',
  'scripts/test-profile-transfer.js',
  'scripts/check-staged-safety.test.js',
  'cloudfunctions/privacy/core.test.js',
  'cloudfunctions/privacy/index.test.js',
]
testScripts.forEach((script) => {
  const result = childProcess.spawnSync(process.execPath, [path.join(root, script)], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) process.stderr.write(result.stderr || result.stdout || '')
  assert.strictEqual(result.status, 0, `${script} 未通过`)
})

console.log(`验证通过：schema v${stateSchema.CURRENT_SCHEMA}、AI 契约 v${aiPlanner.CONTRACT_VERSION}、7/14 天动态餐次、${appConfig.pages.length} 个路由、${jsFiles.length} 个 JS 文件、${wxmlFiles.length} 个 WXML 文件及 ${testScripts.length} 组测试正常。`)
