'use strict'

// Original native favorites UI with fictional memory only. Never deploy.
const fs = require('node:fs')
const path = require('node:path')
const { safeDirectory, writeIfSameOrMissing, sha256, canonical } = require('./recipe-catalog-import')
const { memoryStore: mealMemory } = require('./build-meal-edit-ui-fixture')
const ROOT = path.resolve(__dirname, '..')
const KIND = 'recipe-library-ui-fixture-v1'
const SOURCES = Object.freeze(['app.wxss', 'theme.json',
  ...['recipe-library', 'meal-replacement', 'meal-editor', 'meal-shopping', 'meal-conditions', 'plan-view'].map(name => `services/${name}.js`),
  ...['js', 'json', 'wxml', 'wxss'].map(ext => `pages/recipe-library/recipe-library.${ext}`)])

function memoryStore(base, library) {
  const clone = value => JSON.parse(JSON.stringify(value))
  const namespace = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const initial = clone(base.store.data)
  initial.generationPreferences = { restrictions: '虚构忌口，仅测试', dislikes: '虚构软偏好，仅测试' }
  initial.favoriteRecipes = []
  for (const day of initial.activePlan.days) for (const meal of day.meals) {
    Object.assign(meal, { servings: 2, quantityBasis: 'total', estimatedCookingMinutes: 15 })
  }
  const now = '2026-10-09T00:00:00.000Z'
  let writes = 0, fail = false
  const store = { data: clone(initial), state: 'ready', init: async () => {},
    isCurrentNamespace(value) { return value === namespace },
    async changeFavorite(action, payload, revision) {
      if (store.state !== 'ready' || revision !== store.data.stateRevision) throw Error('虚构同步状态已变化')
      if (fail) throw Error('虚构保存失败')
      let next
      if (action === 'addFavorite') {
        if (payload.mealId !== 'fixture-meal-0' || payload.expectedPlanId !== initial.activePlan.id) throw Error('Only fictional capture allowed')
        next = library.add(store.data, payload.mealId, 'fav_' + '1'.repeat(32), now)
      } else if (action === 'applyFavorite') {
        next = library.proposal(store.data, payload.favoriteId, payload.target, now)
      } else if (action === 'removeFavorite') next = library.remove(store.data, payload.favoriteId)
      else throw Error('Fixture action not allowed')
      store.data = { ...next, stateRevision: revision + 1 }; writes++
      return store.data
    },
  }
  const controls = {
    reset() { store.data = clone(initial); store.state = 'ready'; writes = 0; fail = false },
    failSave(value) { fail = value === true },
    offline(value) { store.state = value === true ? 'offline' : 'ready' },
    snapshot() { return { data: clone(store.data), writes } },
  }
  return { store, controls }
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
    files['miniprogram/' + relative] = text; sourceHashes['miniprogram/' + relative] = sha256(Buffer.from(text))
  }
  const sourceHash = sha256(Buffer.from(canonical(sourceHashes)))
  files['project.config.json'] = JSON.stringify({ appid: 'touristappid', compileType: 'miniprogram',
    projectname: '收藏隔离测试-不可发布', miniprogramRoot: 'miniprogram/',
    setting: { es6: true, enhance: true, postcss: true, minified: false, urlCheck: true }, condition: {} })
  files['miniprogram/app.json'] = JSON.stringify({ pages: ['pages/plan/plan', 'pages/recipe-library/recipe-library', 'pages/access/access', 'pages/recipe-catalog/recipe-catalog'],
    window: { navigationBarTitleText: '仅虚构数据测试', navigationBarBackgroundColor: '@navigationBarBackgroundColor',
      navigationBarTextStyle: '@navigationBarTextStyle', backgroundColor: '@backgroundColor' },
    darkmode: true, themeLocation: 'theme.json', style: 'v2',
    tabBar: { list: [{ pagePath: 'pages/plan/plan', text: '测试首页' }, { pagePath: 'pages/access/access', text: '测试入口' }] } })
  files['miniprogram/services/user-store.js'] = `const base = (${mealMemory.toString()})(require('./meal-shopping').reconcileChecks)\nconst fixture = (${memoryStore.toString()})(base, require('./recipe-library'))\nmodule.exports = { userStore: fixture.store, controls: fixture.controls }\n`
  files['miniprogram/services/membership-store.js'] = "module.exports = { membershipStore: { cacheNamespace: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', init: async () => ({ status: 'active' }), onCacheNamespaceChange: () => () => {} } }\n"
  files['miniprogram/app.js'] = `App({ globalData: { libraryUiFixture: '${KIND}', libraryUiSourceHash: '${sourceHash}' }, libraryUiTest: require('./services/user-store').controls })\n`
  for (const route of ['plan', 'access', 'recipe-catalog']) {
    files[`miniprogram/pages/${route}/${route}.js`] = "Page({ open() { wx.navigateTo({ url: '/pages/recipe-library/recipe-library' }) }, capture() { wx.navigateTo({ url: '/pages/recipe-library/recipe-library?mealId=fixture-meal-0' }) } })\n"
    files[`miniprogram/pages/${route}/${route}.json`] = '{}\n'
    files[`miniprogram/pages/${route}/${route}.wxml`] = '<view class="screen"><text>收藏隔离测试：仅虚构内存，不连接云端或 AI，不可发布。本页非真实餐单或菜谱库。</text><button class="primary-button fixture-open" bindtap="open">查看虚构收藏</button><button class="secondary-button fixture-capture" bindtap="capture">收藏虚构早餐</button></view>\n'
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
  const project = safeDirectory(root, ['.local', 'library-ui', result.manifest.fixtureHash.slice(0, 16), 'project'])
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
  } catch (_) { console.error('LIBRARY_UI_FIXTURE_BUILD_FAILED'); process.exitCode = 1 }
}
module.exports = { KIND, SOURCES, memoryStore, contents, buildFixture }
