'use strict'

const assert = require('assert')
const childProcess = require('child_process')
const path = require('path')
const fs = require('fs')

const root = path.resolve(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const EXPECTED_DATABASE_RULES = {
  meal_users: { read: false, write: false },
  meal_user_states: { read: false, write: false },
  meal_avatar_uploads: { read: false, write: false },
  meal_members: { read: false, write: false },
  meal_invites: { read: false, write: false },
  health_daily: { read: false, write: false },
  health_photo_uploads: { read: false, write: false },
  meal_ai_tasks: { read: false, write: false },
  meal_ai_shards: { read: false, write: false },
  meal_ai_controls: { read: false, write: false },
}

function validateDatabaseRules(rules) {
  assert.deepStrictEqual(rules, EXPECTED_DATABASE_RULES,
    '数据库安全规则必须恰好覆盖十个正式集合且全部拒绝客户端读写')
}

if (process.argv[2] === '--validate-database-rules-stdin') {
  try {
    validateDatabaseRules(JSON.parse(fs.readFileSync(0, 'utf8')))
    process.exit(0)
  } catch (_) {
    process.stderr.write('数据库安全规则验证失败\n')
    process.exit(1)
  }
}

const releaseManifest = JSON.parse(read('release-manifest.json'))
const { validateReleaseGate } = require(path.join(root, 'scripts/release-gate'))
const stateSchema = require(path.join(root, 'shared/user-state'))
const aiPlanner = require(path.join(root, 'cloudfunctions/aiPlanner/lib'))
const aiTaskCore = require(path.join(root, 'cloudfunctions/aiPlanner/task-core'))
const aiMaintenanceCore = require(path.join(root, 'cloudfunctions/mealAiMaintenance/core'))
const aiPlannerClient = require(path.join(root, 'miniprogram/services/ai-planner'))
const aiProviderConfig = require(path.join(root, 'cloudfunctions/aiPlanner/provider-config'))
const membershipCore = require(path.join(root, 'cloudfunctions/membership/core'))
const { calendarCells } = require(path.join(root, 'miniprogram/utils/date'))
const CLOUD_FUNCTIONS = [
  'aiPlanner', 'auth', 'health', 'mealAiMaintenance',
  'membership', 'ownerBootstrapOnce', 'privacy', 'userData',
]
const DEPLOYED_CLOUD_FUNCTIONS = CLOUD_FUNCTIONS.filter((name) => name !== 'ownerBootstrapOnce')
const WX_SERVER_SDK_VERSION = '4.0.2'
const OID_PATTERN = /^[a-f0-9]{40,64}$/
const RETIRED_PROVIDER_DIAGNOSTIC_FILES = [
  'cloudfunctions/aiPlanner/provider-diagnostic.js',
  'cloudfunctions/aiPlanner/provider-diagnostic.test.js',
  'cloudfunctions/aiPlanner/provider-capability.js',
  'cloudfunctions/aiPlanner/provider-capability.test.js',
  'cloudfunctions/aiPlanner/provider-stream-capability.js',
  'cloudfunctions/aiPlanner/provider-stream-capability.test.js',
  'scripts/wx-automator/provider-capability-probe.js',
  'scripts/wx-automator/provider-capability-probe.test.js',
  'scripts/wx-automator/provider-stream-capability-probe.js',
  'scripts/wx-automator/provider-stream-capability-probe.test.js',
  'cloudfunctions/aiPlanner/providerCapabilityV1.js',
  'cloudfunctions/aiPlanner/providerCapabilityV1.test.js',
  'cloudfunctions/aiPlanner/providerStreamCapabilityV1.js',
  'cloudfunctions/aiPlanner/providerStreamCapabilityV1.test.js',
  'scripts/wx-automator/ai-provider-capability-v1.js',
  'scripts/wx-automator/ai-provider-capability-v1.test.js',
  'scripts/wx-automator/ai-provider-stream-capability-v1.js',
  'scripts/wx-automator/ai-provider-stream-capability-v1.test.js',
]
const RETIRED_PROVIDER_DIAGNOSTIC_MARKERS = [
  'providerDiagnostic', 'PROVIDER_DIAGNOSTIC', 'diagnosticVersion', 'diagnosticRevision',
  'providerDiagnostics', 'safeProviderDiagnostic', 'projectProviderDiagnostic', 'providerHttpError',
  'providerCapabilityV1', 'providerStreamCapabilityV1',
  'PROVIDER_CAPABILITY', 'PROVIDER_STREAM_CAPABILITY',
  'probeProviderCapability', 'probeProviderStreamCapability',
  'AI_PROVIDER_CAPABILITY_PROBE', 'AI_PROVIDER_STREAM_CAPABILITY_PROBE',
]

function gitOutput(args, options = {}) {
  try {
    return childProcess.execFileSync('git', args, {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch (_) { return options.fallback === undefined ? '' : options.fallback }
}

function releaseRefName() {
  const supplied = String(process.env.RELEASE_GATE_REF || '').trim()
  if (supplied) return supplied
  return gitOutput(['symbolic-ref', '-q', 'HEAD'])
}

function versionTag(version) {
  const refName = `refs/tags/v${version}`
  const objectType = gitOutput(['cat-file', '-t', refName])
  if (!objectType) return null
  return {
    refName,
    objectType,
    objectOid: gitOutput(['rev-parse', '--verify', refName]),
    peeledCommitOid: gitOutput(['rev-parse', '--verify', `${refName}^{commit}`]),
  }
}

function candidateBranch(version, currentRefName) {
  const branchRef = `refs/heads/v${version}`
  if (currentRefName !== 'refs/heads/main') {
    return { refName: branchRef, commitOid: '', treeOid: '' }
  }

  const suppliedRef = String(process.env.RELEASE_GATE_CANDIDATE_REF || '').trim()
  const suppliedCommit = String(process.env.RELEASE_GATE_CANDIDATE_COMMIT || '').trim().toLowerCase()
  const remoteRef = `refs/remotes/origin/v${version}`
  const remoteCommit = gitOutput(['rev-parse', '--verify', `${remoteRef}^{commit}`]).toLowerCase()
  assert.strictEqual(suppliedRef, branchRef,
    'main 门禁必须显式绑定当前版本 Branch 的完整 ref')
  assert(OID_PATTERN.test(suppliedCommit), 'main 门禁必须显式提供当前版本 Branch commit')
  assert(OID_PATTERN.test(remoteCommit), 'main 门禁必须现场解析 origin 当前版本 Branch')
  assert.strictEqual(suppliedCommit, remoteCommit,
    'main 门禁提供的候选 commit 与 origin 当前版本 Branch 不一致')
  return {
    refName: branchRef,
    commitOid: remoteCommit,
    treeOid: gitOutput(['show', '-s', '--format=%T', remoteCommit]),
  }
}

function commitChangedEntries(commit, parentOids) {
  if (parentOids.length !== 1) return []
  const output = gitOutput([
    'diff-tree', '--no-commit-id', '--name-status', '-z', '-r', '--no-renames',
    parentOids[0], commit,
  ], { fallback: null })
  assert.notStrictEqual(output, null, '无法读取 released 元数据提交的文件差异')
  const fields = output.split('\0')
  if (fields[fields.length - 1] === '') fields.pop()
  assert.strictEqual(fields.length % 2, 0, 'released 元数据提交的文件差异格式无效')
  const entries = []
  for (let index = 0; index < fields.length; index += 2) {
    entries.push({ status: fields[index], path: fields[index + 1] })
  }
  return entries
}

function parentReleaseManifest(parentOids) {
  if (parentOids.length !== 1) return null
  const source = gitOutput(['show', `${parentOids[0]}:release-manifest.json`], { fallback: null })
  assert.notStrictEqual(source, null, '无法读取 released 元数据提交父版本清单')
  try {
    return JSON.parse(source)
  } catch (_) {
    assert.fail('released 元数据提交父版本清单不是有效 JSON')
  }
}

const requestedCommit = String(process.env.RELEASE_GATE_COMMIT || '').trim()
const currentCommit = gitOutput(['rev-parse', '--verify', requestedCommit || 'HEAD'])
const parentLine = gitOutput(['rev-list', '--parents', '-n', '1', currentCommit]).split(/\s+/).filter(Boolean)
const parentOids = parentLine[0] === currentCommit ? parentLine.slice(1) : []
const currentRefName = releaseRefName()
const candidate = candidateBranch(releaseManifest.workingVersion, currentRefName)
const releasedContext = releaseManifest.releaseStatus === 'released' ? {
  changedEntries: commitChangedEntries(currentCommit, parentOids),
  parentManifest: parentReleaseManifest(parentOids),
} : {}

validateReleaseGate({
  manifest: releaseManifest,
  changelog: read('CHANGELOG.md'),
  readme: read('README.md'),
  refContext: {
    refName: currentRefName,
    commitOid: currentCommit,
    parentOids,
    treeOid: gitOutput(['show', '-s', '--format=%T', currentCommit]),
    candidateBranchRef: candidate.refName,
    candidateCommitOid: candidate.commitOid,
    candidateTreeOid: candidate.treeOid,
    ...releasedContext,
  },
  versionTag: versionTag(releaseManifest.workingVersion),
})
assert.strictEqual(releaseManifest.stateSchemaVersion, 8, '当前发布清单必须使用 schema v8')
assert.strictEqual(stateSchema.CURRENT_SCHEMA, releaseManifest.stateSchemaVersion, '共享 schema 与版本清单不一致')
assert.strictEqual(aiPlanner.CONTRACT_VERSION, releaseManifest.aiContractVersion, 'AI 契约与版本清单不一致')
assert.strictEqual(aiPlanner.PLANNER_VERSION, releaseManifest.aiPlannerVersion, 'AI 生成器与版本清单不一致')
assert.strictEqual(aiPlannerClient.CONTRACT_VERSION, releaseManifest.aiContractVersion, '小程序 AI 契约与版本清单不一致')
assert.strictEqual(aiPlannerClient.PLANNER_VERSION, releaseManifest.aiPlannerVersion, '小程序 AI 生成器与版本清单不一致')
assert.strictEqual(aiMaintenanceCore.AI_CONTRACT_VERSION, releaseManifest.aiContractVersion,
  'AI 维护契约与版本清单不一致')
assert.strictEqual(aiMaintenanceCore.AI_PLANNER_VERSION, releaseManifest.aiPlannerVersion,
  'AI 维护生成器与版本清单不一致')
assert.strictEqual(aiTaskCore.TASK_SCHEMA_VERSION, releaseManifest.aiTaskSchemaVersion,
  'AI 任务 schema 与版本清单不一致')
assert.strictEqual(aiTaskCore.AI_DATA_CONSENT_VERSION, releaseManifest.aiDataConsentVersion,
  'AI 任务同意协议与版本清单不一致')
assert.strictEqual(aiMaintenanceCore.AI_DATA_CONSENT_VERSION, releaseManifest.aiDataConsentVersion,
  'AI 维护同意协议与版本清单不一致')
assert.strictEqual(aiPlannerClient.AI_DATA_CONSENT_VERSION, releaseManifest.aiDataConsentVersion,
  '小程序 AI 同意协议与版本清单不一致')
assert.strictEqual(aiProviderConfig.PROVIDER_CONTRACT_REVISION, releaseManifest.aiProviderContractRevision,
  '云函数 provider 契约版本与版本清单不一致')
assert.strictEqual(aiPlannerClient.PROVIDER_CONTRACT_REVISION, releaseManifest.aiProviderContractRevision,
  '小程序 provider 契约版本与版本清单不一致')
RETIRED_PROVIDER_DIAGNOSTIC_FILES.forEach((file) => {
  assert.strictEqual(fs.existsSync(path.join(root, file)), false, `正式部署树不得包含临时诊断文件 ${file}`)
})
const aiPlannerRuntimeFiles = fs.readdirSync(path.join(root, 'cloudfunctions/aiPlanner'))
  .filter((file) => file.endsWith('.js'))
  .map((file) => `cloudfunctions/aiPlanner/${file}`)
const providerAutomationFiles = fs.readdirSync(path.join(root, 'scripts/wx-automator'))
  .filter((file) => file.endsWith('.js'))
  .map((file) => `scripts/wx-automator/${file}`)
const providerReleaseSource = [...aiPlannerRuntimeFiles, ...providerAutomationFiles]
  .map((file) => read(file)).join('\n')
RETIRED_PROVIDER_DIAGNOSTIC_MARKERS.forEach((marker) => {
  assert.strictEqual(providerReleaseSource.includes(marker), false,
    `正式部署树不得包含已退役的 provider 临时诊断标识 ${marker}`)
})
const aiPlannerIndexSource = read('cloudfunctions/aiPlanner/index.js')
assert(/providerContractRevision:\s*PROVIDER_CONTRACT_REVISION/.test(aiPlannerIndexSource),
  '移除临时诊断后仍必须保留 providerContractRevision 服务握手')
assert(releaseManifest.minimumMigratableStateSchemaVersion <= releaseManifest.stateSchemaVersion, '最低可迁移 schema 不能高于当前版本')

const sharedSource = read('shared/user-state.js')
;[
  'miniprogram/services/user-state-core.js',
  'cloudfunctions/userData/user-state.js',
  'cloudfunctions/aiPlanner/user-state.js',
].forEach((file) => assert.strictEqual(read(file), sharedSource, `${file} 未与 shared/user-state.js 同步`))
assert.strictEqual(read('cloudfunctions/privacy/membership-core.js'), read('cloudfunctions/membership/core.js'), 'privacy 成员控制逻辑未同步')

const fresh = stateSchema.defaults()
assert.strictEqual(fresh.schemaVersion, 8)
assert.strictEqual(fresh.waterReminder.enabled, false, '新用户喝水提醒必须默认关闭')
assert.strictEqual(fresh.activePlan, null, '新用户不能自动获得静态计划')
assert.strictEqual(fresh.draftPlan, null, '新用户默认不应存在候选计划')
assert.deepStrictEqual(fresh.planHistory, [], '新用户历史计划必须为空')
assert.strictEqual(fresh.generationPreferences.durationDays, 1, '新用户计划周期必须默认 1 天')
assert.deepStrictEqual(fresh.generationPreferences.mealTypes, [], '餐次必须由用户主动选择')

const preferenceBase = {
  contractVersion: aiPlanner.CONTRACT_VERSION,
  startDate: '2026-08-26',
  mealTypes: ['breakfast', 'lunch', 'snack'],
  doubleDinner: false,
  goals: ['均衡饮食'], styles: [], customGoal: '', restrictions: '', healthNotes: '', exerciseIntent: 'none', exerciseNotes: '', exerciseByDay: [],
}
;[1, 10, 14].forEach((durationDays) => {
  assert.strictEqual(aiPlanner.normalizeRequest({ ...preferenceBase, durationDays }).durationDays, durationDays)
})
assert.deepStrictEqual(aiPlanner.expectedMealKeys(aiPlanner.normalizeRequest({ ...preferenceBase, durationDays: 10 })), [
  'breakfast:default', 'lunch:default', 'snack:default',
])
assert.deepStrictEqual(aiPlanner.expectedMealKeys(aiPlanner.normalizeRequest({
  ...preferenceBase, durationDays: 14, mealTypes: ['dinner'], doubleDinner: true,
})), ['dinner:rest', 'dinner:workout'])

const requiredPages = [
  'pages/plan/plan', 'pages/planner/planner', 'pages/plan-preview/plan-preview', 'pages/plan-history/plan-history',
  'pages/health/health', 'pages/shopping/shopping', 'pages/guide/guide', 'pages/profile/profile', 'pages/meal-edit/meal-edit',
  'pages/legal/user-agreement', 'pages/legal/privacy',
]
const appConfig = JSON.parse(read('miniprogram/app.json'))
requiredPages.forEach((page) => assert(appConfig.pages.includes(page), `app.json 缺少路由 ${page}`))
appConfig.pages.forEach((page) => ['js', 'json', 'wxml', 'wxss'].forEach((extension) => {
  assert(fs.existsSync(path.join(root, `miniprogram/${page}.${extension}`)), `页面缺少 miniprogram/${page}.${extension}`)
}))

const requiredFiles = [
  '.github/workflows/trusted-pr-security.yml',
  'project.config.example.json', 'project.private.config.example.json', 'miniprogram/config.example.js',
  'miniprogram/app.json', 'miniprogram/app.js',
  'miniprogram/services/user-state-core.js', 'miniprogram/services/plan-view.js',
  'cloudfunctions/membership/index.js', 'cloudfunctions/membership/core.js', 'cloudfunctions/membership/core.test.js',
  'cloudfunctions/auth/index.js', 'cloudfunctions/userData/index.js',
  'cloudfunctions/userData/index.test.js',
  'cloudfunctions/aiPlanner/index.js', 'cloudfunctions/aiPlanner/lib.js', 'cloudfunctions/aiPlanner/lib.test.js',
  'cloudfunctions/aiPlanner/task-core.js', 'cloudfunctions/aiPlanner/task-core.test.js',
  'cloudfunctions/aiPlanner/provider-config.js', 'cloudfunctions/aiPlanner/provider-config.test.js',
  'cloudfunctions/aiPlanner/provider-compat.js', 'cloudfunctions/aiPlanner/provider-compat.test.js',
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
  'miniprogram/utils/private-image.js', 'miniprogram/utils/privacy-auth.js',
  'database.rules.json', 'database.indexes.json', 'storage.rules.json',
  'cloudfunctions/membership/.env.example', 'cloudfunctions/aiPlanner/.env.example',
  'release-manifest.json', 'CHANGELOG.md', 'SUPPORT.md', 'SECURITY.md',
  'scripts/test-ai-provider-live.js', 'scripts/test-access-page.js', 'scripts/database-rules.test.js',
  'scripts/check-ai-storage-readiness.js',
  'scripts/check-ai-storage-readiness.test.js', 'scripts/check-staged-safety.test.js',
  'scripts/git-hooks.test.js',
  'scripts/wx-automator/automation-runtime.js', 'scripts/wx-automator/automation-runtime.test.js',
  'scripts/wx-automator/automator-client.js', 'scripts/wx-automator/smoke.js',
  'scripts/wx-automator/visual-regression.js', 'scripts/wx-automator/interactive-smoke.js',
  'scripts/wx-automator/run-mainline-smoke.js', 'scripts/wx-automator/ai-safe-release-core.js',
  'scripts/wx-automator/ai-safe-release-core.test.js', 'scripts/wx-automator/ai-safe-release-probe.js',
  'scripts/wx-automator/plan-preview-evidence.js', 'scripts/wx-automator/plan-preview-evidence.test.js',
  'scripts/wx-automator/entrypoints.test.js', 'scripts/wx-automator/package.json',
  'scripts/wx-automator/package-lock.json',
  '.github/workflows/validate.yml', '.github/PULL_REQUEST_TEMPLATE.md',
  'docs/DEPLOY.md', 'docs/DATABASE.md', 'docs/PRIVACY.md', 'docs/VERSIONING.md', 'docs/RELEASE_CHECKLIST.md',
  'source-assets/meal-plan-gpt-image-2.png', 'miniprogram/assets/meal-plan-cover.jpg',
]
requiredFiles.forEach((file) => assert(fs.existsSync(path.join(root, file)), `缺少 ${file}`))

const automatorPackage = JSON.parse(read('scripts/wx-automator/package.json'))
const automatorLock = JSON.parse(read('scripts/wx-automator/package-lock.json'))
assert.strictEqual(automatorPackage.private, true, '微信自动化工具包必须禁止发布到 npm')
assert.deepStrictEqual(automatorPackage.dependencies, {
  'miniprogram-automator': '0.12.1',
  pngjs: '3.4.0',
}, '微信自动化运行依赖必须精确固定')
assert.strictEqual(automatorLock.lockfileVersion, 3, '微信自动化 lockfile 必须使用 v3')
assert.deepStrictEqual(automatorLock.packages[''].dependencies, automatorPackage.dependencies,
  '微信自动化 lockfile 根依赖与 package.json 不一致')
assert.strictEqual(automatorLock.packages['node_modules/miniprogram-automator'].version, '0.12.1',
  '微信自动化未解析到 miniprogram-automator 0.12.1')
assert.strictEqual(automatorLock.packages['node_modules/pngjs'].version, '3.4.0',
  '微信自动化未解析到 pngjs 3.4.0')

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

DEPLOYED_CLOUD_FUNCTIONS.forEach((functionName) => {
  const runtimeConfig = JSON.parse(read(`cloudfunctions/${functionName}/config.json`))
  assert.strictEqual(runtimeConfig.timeout, 60,
    `${functionName} 必须显式配置 60 秒云端超时`)
  assert.strictEqual(runtimeConfig.memorySize, 256,
    `${functionName} 必须显式配置 256 MB 云端内存`)
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
  'AI_API_BASE_URL', 'AI_API_KEY', 'AI_MAX_TOKENS',
  'AI_PROVIDER_DISPLAY_NAME', 'AI_PROVIDER_REVISION', 'AI_TIMEOUT_MS',
])
assert.strictEqual(aiPlaceholders.AI_API_KEY, 'YOUR_AI_API_KEY')
assert.strictEqual(aiPlaceholders.AI_API_BASE_URL, '<YOUR_AI_API_BASE_URL>')
assert.strictEqual(aiPlaceholders.AI_PROVIDER_DISPLAY_NAME, '<YOUR_AI_PROVIDER_DISPLAY_NAME>')
assert.strictEqual(aiPlaceholders.AI_PROVIDER_REVISION, '<YOUR_AI_PROVIDER_REVISION>')
assert.strictEqual(aiPlaceholders.AI_TIMEOUT_MS, '45000')
assert.strictEqual(aiPlaceholders.AI_MAX_TOKENS, '16000')
assert.strictEqual(aiProviderConfig.DEFAULT_ENDPOINT, '')
assert.strictEqual(aiProviderConfig.DEFAULT_MODEL, 'gpt-5.6')
assert.strictEqual(aiProviderConfig.DEFAULT_API_STYLE, 'responses')
assert.strictEqual(aiProviderConfig.DEFAULT_REASONING_EFFORT, '')
assert.deepStrictEqual(aiProviderConfig.configuration({ AI_API_KEY: 'TEST_PLACEHOLDER_ONLY' }), {
  configured: false,
  providerDisplayName: '',
  providerContractRevision: 9,
  providerRevision: 0,
  providerConfigVersion: '',
  url: null,
  apiKey: 'TEST_PLACEHOLDER_ONLY',
  model: 'gpt-5.6',
  apiStyle: 'responses',
  temperature: undefined,
  reasoningEffort: '',
  timeoutMs: 45000,
  maxTokens: 16000,
})

const membershipEnvironmentGuide = read('cloudfunctions/membership/.env.example')
assert(!/^\s*(?:INVITE_SLOTS|INVITE_TTL_HOURS)\s*=/m.test(membershipEnvironmentGuide),
  '成员容量和邀请码有效期不得再由云端环境变量覆盖')
assert.deepStrictEqual(membershipCore.configuration({ INVITE_SLOTS: '19', INVITE_TTL_HOURS: '24' }), {
  inviteSlots: 3, inviteTtlHours: 168, maxMembers: 4, inviteTtlMs: 604800000,
}, '云端遗留配置不得改变当前邀请制规则')

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
validateDatabaseRules(databaseRules)

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
const profilePageSource = read('miniprogram/pages/profile/profile.wxml')
const authSource = read('cloudfunctions/auth/index.js')
const authProfileCoreSource = read('cloudfunctions/auth/profile-core.js')
assert(/open-type="chooseAvatar"/.test(profilePageSource), '头像必须使用微信 chooseAvatar 原生能力')
assert(/<input[^>]+type="nickname"[^>]+name="nickname"/.test(profilePageSource), '昵称必须使用微信 nickname 输入能力并随表单提交')
assert(/<form[^>]+bindsubmit="saveProfile"/.test(profilePageSource) && /form-type="submit"/.test(profilePageSource),
  '昵称资料必须通过表单提交')
assert(/open-type="getPhoneNumber"/.test(profilePageSource) && /bindgetphonenumber="onGetPhoneNumber"/.test(profilePageSource),
  '可选手机号必须由用户点击微信 getPhoneNumber 原生按钮')
assert(!/getUserInfo/.test(`${profilePageSource}\n${read('miniprogram/pages/profile/profile.js')}`),
  '资料页不能使用已废弃 getUserInfo 获取完整用户资料')
assert(/cloud\.openapi\.phonenumber\.getPhoneNumber\(\{ code, openid \}\)/.test(authSource),
  '手机号动态 code 必须由 auth 云函数携可信 OPENID 兑换')
assert.deepStrictEqual(JSON.parse(read('cloudfunctions/auth/config.json')).permissions.openapi,
  ['phonenumber.getPhoneNumber'], 'auth 云函数必须声明微信官方手机号云调用权限')
assert(!/console\.(?:log|info|warn|error)\([^\n]*(?:event\.code|rawCode|phoneInfo|phoneNumber|purePhoneNumber|maskedPhone)/.test(`${authSource}\n${authProfileCoreSource}`),
  '手机号动态 code、号码或掩码不得进入云函数日志')

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
assert(/@media \(max-width: 400px\)[\s\S]*button, input, textarea, picker \{ min-height: 48px !important; \}/.test(globalStyles),
  '窄屏原生交互控件和多行输入必须保持至少 48px 高度')
assert(/\.touch-target \{ min-width: 48px; min-height: 48px; \}/.test(globalStyles),
  '窄屏自定义点击区域必须保持至少 48px 热区')
assert(/\.screen\s*\{[\s\S]*?max-width:\s*680px;/.test(globalStyles), '全局 screen 必须使用 680px 内容上限')
assert(/constant\(safe-area-inset-left\)/.test(globalStyles) && /env\(safe-area-inset-left\)/.test(globalStyles)
  && /constant\(safe-area-inset-right\)/.test(globalStyles) && /env\(safe-area-inset-right\)/.test(globalStyles),
'全局 screen 必须兼容横屏左右安全区')
const healthStyles = read('miniprogram/pages/health/health.wxss')
const healthMarkup = read('miniprogram/pages/health/health.wxml')
assert(/repeat\(7, minmax\(0, 1fr\)\)/.test(healthStyles), '健康月历必须按可用宽度均分七列')
assert(!/repeat\(7,\s*minmax\((?:44px|88rpx),/.test(healthStyles), '健康月历不得使用会造成窄屏横溢的固定列宽')
assert(/<view class="calendar-scroll">/.test(healthMarkup)
  && !/<scroll-view class="calendar-scroll"/.test(healthMarkup)
  && !/\.calendar-content\s*\{[^}]*min-width:\s*336px;/.test(healthStyles),
  '健康月历必须在 320px 内完整显示七列，不得依赖横向滚动或 336px 裁切')

const testScripts = [
  'scripts/release-gate.test.js',
  'scripts/git-hooks.test.js',
  'scripts/deploy-production-function.test.js',
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
  'cloudfunctions/health/storage-delete.test.js',
  'cloudfunctions/health/index.test.js',
  'cloudfunctions/ownerBootstrapOnce/core.test.js',
  'cloudfunctions/ownerBootstrapOnce/index.test.js',
  'cloudfunctions/aiPlanner/lib.test.js',
  'cloudfunctions/aiPlanner/provider-config.test.js',
  'cloudfunctions/aiPlanner/provider-compat.test.js',
  'cloudfunctions/aiPlanner/not-found.test.js',
  'cloudfunctions/aiPlanner/transport.test.js',
  'cloudfunctions/aiPlanner/task-core.test.js',
  'cloudfunctions/aiPlanner/index.test.js',
  'cloudfunctions/mealAiMaintenance/core.test.js',
  'cloudfunctions/mealAiMaintenance/index.test.js',
  'cloudfunctions/late-write-guard.test.js',
  'scripts/test-ai-provider-live.test.js',
  'scripts/test-access-page.js',
  'scripts/test-plan-view.js',
  'scripts/test-shopping-scope.js',
  'scripts/test-cache-namespace.js',
  'scripts/test-water-reminder.js',
  'scripts/test-private-cache.js',
  'scripts/test-private-image.js',
  'scripts/test-cloud-errors.js',
  'scripts/test-ai-planner-client.js',
  'scripts/test-planner-contract-pipeline.js',
  'scripts/test-planner-page.js',
  'scripts/test-plan-history-page.js',
  'scripts/test-health-guide-pages.js',
  'scripts/test-health-responsive.js',
  'scripts/test-color-contrast.js',
  'scripts/test-page-responsive.js',
  'scripts/test-profile-transfer.js',
  'scripts/test-profile-native.js',
  'scripts/test-tabbar-ui.js',
  'scripts/test-privacy-auth.js',
  'scripts/database-rules.test.js',
  'scripts/check-ai-storage-readiness.test.js',
  'scripts/check-staged-safety.test.js',
  'cloudfunctions/privacy/core.test.js',
  'cloudfunctions/privacy/storage-delete.test.js',
  'cloudfunctions/privacy/index.test.js',
]
testScripts.forEach((script) => {
  const result = childProcess.spawnSync(process.execPath, [path.join(root, script)], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) process.stderr.write(result.stderr || result.stdout || '')
  assert.strictEqual(result.status, 0, `${script} 未通过`)
})

console.log(`验证通过：schema v${stateSchema.CURRENT_SCHEMA}、AI 契约 v${aiPlanner.CONTRACT_VERSION}、任意 1–14 天动态餐次（默认 1 天）、${appConfig.pages.length} 个路由、${jsFiles.length} 个 JS 文件、${wxmlFiles.length} 个 WXML 文件及 ${testScripts.length} 组测试正常。`)
