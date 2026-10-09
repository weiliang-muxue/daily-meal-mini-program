'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { contents, buildFixture, SOURCES, KIND } = require('./build-catalog-ui-fixture')
const { canonical, sha256 } = require('./recipe-catalog-import')
const root = path.resolve(__dirname, '..')

test('fixture copies only public UI and replaces account/configuration entry points', () => {
  const { files, manifest } = contents()
  assert.equal(manifest.kind, KIND)
  for (const flag of ['productionConfigurationRead', 'cloudEnabled', 'personalDataIncluded', 'deployable']) assert.equal(manifest[flag], false)
  assert.equal(JSON.parse(files['project.config.json']).appid, 'touristappid')
  for (const relative of SOURCES) {
    const source = fs.readFileSync(path.join(root, 'miniprogram', relative), 'utf8')
    assert.equal(files['miniprogram/' + relative], source)
    assert.equal(manifest.sourceHashes['miniprogram/' + relative], sha256(Buffer.from(source)))
  }
  assert(!SOURCES.includes('services/membership-store.js'))
  assert(!Object.keys(files).some(name => /cloudfunctions|config\.js$|user-store|private\.config/.test(name)))
  assert.doesNotMatch(Object.values(files).join('\n'), /wx\.(?:cloud|request|login|getStorage|setStorage)/)
  assert.deepEqual(contents(), { files, manifest })
  const withoutManifest = { ...files }; delete withoutManifest['fixture-manifest.json']
  assert.equal(sha256(Buffer.from(canonical(withoutManifest))), manifest.fixtureHash)
})

test('fixture JS and WXSS dependency closure includes every relative import', () => {
  const { files } = contents()
  for (const [filename, source] of Object.entries(files)) {
    if (!/\.(?:js|wxss)$/.test(filename)) continue
    const expressions = filename.endsWith('.js') ? /require\(['"]([^'"]+)['"]\)/g : /@import\s+['"]([^'"]+)['"]/g
    for (const match of source.matchAll(expressions)) {
      assert(match[1].startsWith('.'), 'No external dependency in fixture')
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(filename), match[1]))
      assert(Object.hasOwn(files, resolved) || Object.hasOwn(files, resolved + '.js'), filename + ': ' + match[1])
    }
  }
})

function temporarySources(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meal-catalog-fixture-test-'))
  const resolved = fs.realpathSync(directory)
  t.after(() => {
    assert.equal(fs.realpathSync(directory), resolved)
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()))
    assert(path.basename(resolved).startsWith('meal-catalog-fixture-test-'))
    fs.rmSync(resolved, { recursive: true })
  })
  for (const relative of SOURCES) {
    const filename = path.join(directory, 'miniprogram', relative)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.copyFileSync(path.join(root, 'miniprogram', relative), filename)
  }
  // No app config or account module exists here: successful build proves they are not read.
  return directory
}
test('builder uses hash-isolated outputs, preserves prior runs and refuses conflicts', t => {
  const directory = temporarySources(t)
  const first = buildFixture(directory)
  assert(first.project.startsWith(path.join(directory, '.local', 'catalog-ui') + path.sep))
  assert.deepEqual(buildFixture(directory), first)
  const firstFile = path.join(first.project, 'miniprogram', SOURCES[0])
  fs.appendFileSync(path.join(directory, 'miniprogram', SOURCES[0]), '\n/* test public revision */\n')
  const second = buildFixture(directory)
  assert.notEqual(first.project, second.project)
  assert(fs.existsSync(firstFile))
  fs.appendFileSync(path.join(second.project, 'miniprogram', SOURCES[0]), '\n/* conflicting output */\n')
  assert.throws(() => buildFixture(directory), /OUTPUT_CONFLICT/)
})

test('parent directory junctions are rejected before source reading', t => {
  const directory = temporarySources(t)
  const original = path.join(directory, 'miniprogram', 'styles')
  const moved = path.join(directory, 'test-styles')
  fs.renameSync(original, moved)
  fs.symlinkSync(moved, original, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => contents(directory), /FIXTURE_SOURCE_INVALID/)
})
