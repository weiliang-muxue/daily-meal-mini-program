'use strict'

// Public planner page with a fictional memory store. No cloud, login or AI transport.
const fs = require('node:fs')
const path = require('node:path')
const { safeDirectory, writeIfSameOrMissing, sha256, canonical } = require('./recipe-catalog-import')
const ROOT = path.resolve(__dirname, '..')
const KIND = 'planner-ui-fixture-v1'
const SOURCES = Object.freeze(['app.wxss', 'theme.json', 'services/meal-editor.js', 'services/meal-shopping.js',
  'services/meal-conditions.js', 'services/plan-view.js', 'services/meal-replacement.js',
  'services/meal-replacement-view.js', 'utils/cooking-form.js',
  ...['js', 'json', 'wxml', 'wxss'].map(ext => 'pages/planner/planner.' + ext)])

function memoryServices() {
  const clone = value => JSON.parse(JSON.stringify(value))
  const initial = { stateRevision: 1, generationPreferences: null, activePlan: { id: 'fictional-retained-plan' } }
  let writes = 0, starts = 0
  const userStore = { namespace: 'a'.repeat(32), state: 'ready', data: clone(initial),
    async init() { return userStore.data },
    async patch(partial) {
      if (Object.keys(partial).some(key => key !== 'generationPreferences')) throw Error('FIXTURE_WRITE_REJECTED')
      userStore.data = { ...userStore.data, ...clone(partial), stateRevision: userStore.data.stateRevision + 1 }
      writes++; return userStore.data
    },
    async flush() { return userStore.data },
  }
  const aiPlanner = {
    async status() { return { configured: true, storageReady: true, contractVersion: 4, plannerVersion: '10',
      aiDataConsentVersion: 4, providerContractRevision: 10, providerRevision: 1, providerDisplayName: '虚构服务（无网络）' } },
    loadCachedTask: () => null, clearCachedTask: () => false,
    currentTask: async () => null, recentFailure: async () => null,
    async start() { starts++; throw Object.assign(Error('隔离测试不发送生成请求'), { code: 'UI_FIXTURE_GENERATION_DISABLED' }) },
  }
  return { userStore, aiPlanner, controls: {
    reset() { userStore.data = clone(initial); writes = 0; starts = 0 },
    snapshot() { return { data: clone(userStore.data), writes, starts } },
  } }
}

function contents(root = ROOT) {
  const files = {}, sourceHashes = {}
  for (const relative of SOURCES) {
    let filename = fs.realpathSync(root)
    for (const segment of ['miniprogram', ...relative.split('/')]) {
      filename = path.join(filename, segment)
      if (fs.lstatSync(filename).isSymbolicLink()) throw Error('FIXTURE_SOURCE_INVALID')
    }
    if (!fs.lstatSync(filename).isFile()) throw Error('FIXTURE_SOURCE_INVALID')
    const text = fs.readFileSync(filename, 'utf8')
    files['miniprogram/' + relative] = text
    sourceHashes['miniprogram/' + relative] = sha256(Buffer.from(text))
  }
  const sourceHash = sha256(Buffer.from(canonical(sourceHashes)))
  files['project.config.json'] = JSON.stringify({ appid: 'touristappid', compileType: 'miniprogram',
    projectname: '定制餐单隔离测试-不可发布', miniprogramRoot: 'miniprogram/',
    setting: { es6: true, enhance: true, postcss: true, minified: false, urlCheck: true }, condition: {} })
  files['miniprogram/app.json'] = JSON.stringify({ pages: ['pages/plan/plan', 'pages/planner/planner', 'pages/access/access'],
    window: { navigationBarTitleText: '仅虚构数据测试', navigationBarBackgroundColor: '@navigationBarBackgroundColor',
      navigationBarTextStyle: '@navigationBarTextStyle', backgroundColor: '@backgroundColor' },
    darkmode: true, themeLocation: 'theme.json', style: 'v2',
    tabBar: { list: [{ pagePath: 'pages/plan/plan', text: '测试首页' }, { pagePath: 'pages/access/access', text: '测试入口' }] } })
  files['miniprogram/services/fixture.js'] = `module.exports = (${memoryServices.toString()})()\n`
  files['miniprogram/services/user-store.js'] = "module.exports = { userStore: require('./fixture').userStore }\n"
  files['miniprogram/services/membership-store.js'] = "module.exports = { membershipStore: { init: async () => ({ status: 'active' }) } }\n"
  files['miniprogram/services/ai-planner.js'] = "module.exports = { aiPlanner: require('./fixture').aiPlanner, CONTRACT_VERSION: 4, PLANNER_VERSION: '10', AI_DATA_CONSENT_VERSION: 4, PROVIDER_CONTRACT_REVISION: 10, createClientRequestId: async () => 'fixture-request-not-sent', isActiveTask: () => false, taskPresentation: () => ({}), failurePolicy: () => ({ retryable: false, detail: '隔离测试不发送请求' }) }\n"
  files['miniprogram/app.js'] = `App({ globalData: { plannerUiFixture: '${KIND}', plannerUiSourceHash: '${sourceHash}' }, plannerUiTest: require('./services/fixture').controls })\n`
  for (const route of ['plan', 'access']) {
    files[`miniprogram/pages/${route}/${route}.js`] = "Page({ openPlanner() { wx.navigateTo({ url: '/pages/planner/planner' }) } })\n"
    files[`miniprogram/pages/${route}/${route}.json`] = '{}\n'
    files[`miniprogram/pages/${route}/${route}.wxml`] = '<view class="screen"><text>仅虚构数据、无云端、无 AI 请求，不可发布。</text><button class="primary-button fixture-open" bindtap="openPlanner">测试定制餐单</button></view>\n'
    files[`miniprogram/pages/${route}/${route}.wxss`] = ''
  }
  const fixtureHash = sha256(Buffer.from(canonical(files)))
  const manifest = { kind: KIND, sourceHash, sourceHashes, fixtureHash, deployable: false,
    productionConfigurationRead: false, cloudEnabled: false, personalDataIncluded: false, files: Object.keys(files).sort() }
  files['fixture-manifest.json'] = JSON.stringify(manifest, null, 2) + '\n'
  return { files, manifest }
}
function buildFixture(root = ROOT) {
  const result = contents(root)
  const project = safeDirectory(root, ['.local', 'planner-ui', result.manifest.fixtureHash.slice(0, 16), 'project'])
  for (const [relative, text] of Object.entries(result.files)) {
    const directory = path.dirname(relative)
    if (directory !== '.') safeDirectory(project, directory.split('/'))
    writeIfSameOrMissing(path.join(project, relative), text)
  }
  return { project, manifest: result.manifest }
}
if (require.main === module) {
  try {
    if (process.argv.length !== 2) throw Error('FIXTURE_ARGUMENTS_REJECTED')
    const result = buildFixture()
    console.log(JSON.stringify({ project: result.project, fixtureHash: result.manifest.fixtureHash, deployable: false }))
  } catch (_) { console.error('PLANNER_UI_FIXTURE_BUILD_FAILED'); process.exitCode = 1 }
}
module.exports = { KIND, SOURCES, memoryServices, contents, buildFixture }
