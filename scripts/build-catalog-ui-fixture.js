'use strict'

// Isolated native-rendering project. No production configuration, cloud or user state.
const fs = require('node:fs')
const path = require('node:path')
const { safeDirectory, writeIfSameOrMissing, sha256, canonical } = require('./recipe-catalog-import')
const ROOT = path.resolve(__dirname, '..')
const KIND = 'catalog-ui-fixture-v1'
const ROUTES = ['recipe-catalog/recipe-catalog', 'recipe-detail/recipe-detail', 'legal/sources']
const SOURCES = Object.freeze([
  'app.wxss', 'theme.json', 'styles/recipe-catalog.wxss',
  'services/recipe-catalog.js', 'utils/catalog-page.js',
  'data/recipe-catalog.js', 'data/recipe-catalog-meta.js',
  ...ROUTES.flatMap(route => ['js', 'json', 'wxml', 'wxss'].map(ext => 'pages/' + route + '.' + ext)),
])
function contents(root = ROOT) {
  const files = {}, sourceHashes = {}
  for (const relative of SOURCES) {
    // Do not follow a directory junction into private configuration or another checkout.
    let filename = fs.realpathSync(root)
    for (const segment of ['miniprogram', ...relative.split('/')]) {
      filename = path.join(filename, segment)
      if (fs.lstatSync(filename).isSymbolicLink()) throw new Error('FIXTURE_SOURCE_INVALID')
    }
    const stat = fs.lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('FIXTURE_SOURCE_INVALID')
    const text = fs.readFileSync(filename, 'utf8')
    files['miniprogram/' + relative] = text
    sourceHashes['miniprogram/' + relative] = sha256(Buffer.from(text))
  }
  files['project.config.json'] = JSON.stringify({ appid: 'touristappid', compileType: 'miniprogram',
    projectname: '菜谱界面隔离测试-不可发布', miniprogramRoot: 'miniprogram/',
    setting: { es6: true, enhance: true, postcss: true, minified: false, urlCheck: true }, condition: {} }, null, 2) + '\n'
  files['miniprogram/app.json'] = JSON.stringify({ pages: ROUTES.map(route => 'pages/' + route).concat(['pages/plan/plan', 'pages/access/access']),
    window: { navigationBarTitleText: '菜谱隔离测试', navigationBarBackgroundColor: '@navigationBarBackgroundColor',
      navigationBarTextStyle: '@navigationBarTextStyle', backgroundColor: '@backgroundColor' },
    darkmode: true, themeLocation: 'theme.json', style: 'v2',
    tabBar: { list: [{ pagePath: 'pages/plan/plan', text: '测试首页' }, { pagePath: 'pages/access/access', text: '测试入口' }] },
  }, null, 2) + '\n'
  const sourceHash = sha256(Buffer.from(canonical(sourceHashes)))
  files['miniprogram/app.js'] = `App({ globalData: { catalogUiFixture: '${KIND}', catalogUiSourceHash: '${sourceHash}' } })\n`
  files['miniprogram/services/membership-store.js'] = `'use strict'\n// Fictional test membership. Never copy this into the production project.\n` +
    `const member = { status: 'active', role: 'member' }\nmodule.exports = { membershipStore: { member, cacheNamespace: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',\n` +
    `init: () => Promise.resolve(member), onCacheNamespaceChange: () => () => {}, onMembershipChange: () => () => {} } }\n`
  for (const route of ['plan', 'access']) {
    files[`miniprogram/pages/${route}/${route}.js`] = 'Page({})\n'
    files[`miniprogram/pages/${route}/${route}.json`] = '{}\n'
    files[`miniprogram/pages/${route}/${route}.wxml`] = '<view class="screen">仅用于菜谱原生页面测试，不连接账号、云端或 AI。不可上传发布。</view>\n'
    files[`miniprogram/pages/${route}/${route}.wxss`] = ''
  }
  const fixtureHash = sha256(Buffer.from(canonical(files)))
  const manifest = { kind: KIND, fixtureHash, sourceHash, sourceHashes, productionConfigurationRead: false, cloudEnabled: false,
    personalDataIncluded: false, deployable: false, files: Object.keys(files).sort() }
  files['fixture-manifest.json'] = JSON.stringify(manifest, null, 2) + '\n'
  return { files, manifest }
}
function buildFixture(root = ROOT) {
  const result = contents(root)
  const project = safeDirectory(root, ['.local', 'catalog-ui', result.manifest.fixtureHash.slice(0, 16), 'project'])
  for (const [relative, text] of Object.entries(result.files)) {
    const directory = path.dirname(relative)
    if (directory !== '.') safeDirectory(project, directory.split('/'))
    writeIfSameOrMissing(path.join(project, relative), text)
  }
  return { project, manifest: result.manifest }
}
if (require.main === module) {
  try {
    if (process.argv.length !== 2) throw new Error('FIXTURE_ARGUMENTS_REJECTED')
    const result = buildFixture()
    console.log(JSON.stringify({ project: result.project, fixtureHash: result.manifest.fixtureHash, deployable: false }))
  } catch (_) { console.error('CATALOG_UI_FIXTURE_BUILD_FAILED'); process.exitCode = 1 }
}
module.exports = { KIND, ROUTES, SOURCES, contents, buildFixture }
