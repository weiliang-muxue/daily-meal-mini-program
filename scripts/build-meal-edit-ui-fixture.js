'use strict'

// Public native UI plus a fictional memory-only store. Never deploy this project.
const fs = require('node:fs')
const path = require('node:path')
const { safeDirectory, writeIfSameOrMissing, sha256, canonical } = require('./recipe-catalog-import')
const ROOT = path.resolve(__dirname, '..')
const KIND = 'meal-edit-ui-fixture-v1'
const SOURCES = Object.freeze(['app.wxss', 'theme.json', 'services/meal-editor.js', 'services/meal-shopping.js',
  'services/meal-conditions.js', 'services/plan-view.js',
  ...['js', 'json', 'wxml', 'wxss'].map(ext => 'pages/meal-edit/meal-edit.' + ext)])

function memoryStore(reconcileChecks) {
  const clone = value => JSON.parse(JSON.stringify(value))
  const ingredient = (name, quantity, unit) => ({ name, quantity, unit, category: '其他' })
  const meal = (id, title, quantity) => ({ id, title, type: 'breakfast', scenario: 'default',
    ingredients: [ingredient('虚构燕麦', quantity, 'g'), ingredient('虚构鸡蛋', 1, '个')], method: '仅供界面测试的做法', tag: '' })
  const activePlan = { id: 'fixture-plan', planVersion: 1, source: 'ai', durationDays: 2,
    generationBasis: { mealTypes: ['breakfast'] },
    days: [0, 1].map(i => ({ id: 'fixture-day-' + i, name: '测试日 ' + (i + 1), date: '2026-10-' + (10 + i),
      exercise: { planned: false }, meals: [meal('fixture-meal-' + i, '虚构早餐 ' + (i + 1), i ? 60 : 40)] })),
    shoppingGroups: [{ id: 'fixture-group', name: '其他', items: [
      { id: 'fixture-oats', name: '虚构燕麦', amount: '100 g' }, { id: 'fixture-eggs', name: '虚构鸡蛋', amount: '2 个' },
    ] }],
  }
  const initial = { activePlan, activePlanId: activePlan.id, stateRevision: 1, mealOverrides: {},
    checkedShoppingIds: ['fixture-oats', 'fixture-eggs'], dinnerModeByDay: {}, defaultDinnerMode: 'rest' }
  let fail = false, writes = 0
  const store = { data: clone(initial), state: 'ready', init: async () => {},
    async setMealOverride(id, value) {
      if (id !== 'fixture-meal-0') throw Error('Only the fictional target may be edited')
      if (fail) { store.state = 'error'; throw Error('模拟保存失败，请重试') }
      const next = clone(store.data)
      if (value === null) delete next.mealOverrides[id]; else next.mealOverrides[id] = clone(value)
      next.stateRevision++
      store.data = reconcileChecks(store.data, next); store.state = 'ready'; writes++
    },
  }
  return { store, controls: { reset() { store.data = clone(initial); store.state = 'ready'; writes = 0; fail = false },
    failSave(value) { fail = value === true }, snapshot() { return { data: clone(store.data), writes } } } }
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
    projectname: '餐食编辑隔离测试-不可发布', miniprogramRoot: 'miniprogram/',
    setting: { es6: true, enhance: true, postcss: true, minified: false, urlCheck: true }, condition: {} })
  files['miniprogram/app.json'] = JSON.stringify({ pages: ['pages/plan/plan', 'pages/meal-edit/meal-edit', 'pages/access/access'],
    window: { navigationBarTitleText: '仅虚构数据测试', navigationBarBackgroundColor: '@navigationBarBackgroundColor',
      navigationBarTextStyle: '@navigationBarTextStyle', backgroundColor: '@backgroundColor' },
    darkmode: true, themeLocation: 'theme.json', style: 'v2',
    tabBar: { list: [{ pagePath: 'pages/plan/plan', text: '测试首页' }, { pagePath: 'pages/access/access', text: '测试入口' }] } })
  files['miniprogram/services/user-store.js'] = `const create = ${memoryStore.toString()}\nconst fixture = create(require('./meal-shopping').reconcileChecks)\nmodule.exports = { userStore: fixture.store, controls: fixture.controls }\n`
  files['miniprogram/services/membership-store.js'] = "module.exports = { membershipStore: { cacheNamespace: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', init: async () => ({ status: 'active' }), onCacheNamespaceChange: () => () => {} } }\n"
  files['miniprogram/app.js'] = `App({ globalData: { mealEditUiFixture: '${KIND}', mealEditUiSourceHash: '${sourceHash}' }, mealEditUiTest: require('./services/user-store').controls })\n`
  for (const route of ['plan', 'access']) {
    files[`miniprogram/pages/${route}/${route}.js`] = "Page({ openMeal() { wx.navigateTo({ url: '/pages/meal-edit/meal-edit?mealId=fixture-meal-0' }) } })\n"
    files[`miniprogram/pages/${route}/${route}.json`] = '{}\n'
    files[`miniprogram/pages/${route}/${route}.wxml`] = '<view class="screen"><text>餐食编辑隔离测试：仅虚构数据，不连接云端或 AI，不可发布。</text><button class="primary-button fixture-open" bindtap="openMeal">编辑虚构早餐</button></view>\n'
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
  const project = safeDirectory(root, ['.local', 'meal-edit-ui', result.manifest.fixtureHash.slice(0, 16), 'project'])
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
  } catch (_) { console.error('MEAL_EDIT_UI_FIXTURE_BUILD_FAILED'); process.exitCode = 1 }
}
module.exports = { KIND, SOURCES, memoryStore, contents, buildFixture }
