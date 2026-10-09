'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { contents, SOURCES, memoryServices } = require('./build-planner-ui-fixture')

test('planner fixture copies a closed public dependency set without production configuration', () => {
  const result = contents(), { files, manifest } = result
  assert.deepEqual(contents(), result)
  for (const flag of ['productionConfigurationRead', 'cloudEnabled', 'personalDataIncluded', 'deployable']) assert.equal(manifest[flag], false)
  assert.equal(JSON.parse(files['project.config.json']).appid, 'touristappid')
  assert.equal(SOURCES.length, 13)
  for (const source of SOURCES) assert.equal(files['miniprogram/' + source], fs.readFileSync(path.resolve(__dirname, '../miniprogram', source), 'utf8'))
  assert(!SOURCES.some(p => /config|user-store|membership-store|ai-planner/.test(p)))
  assert.doesNotMatch(Object.values(files).join('\n'), /wx\.(?:cloud|request|login|getStorage|setStorage)/)
  for (const [filename, source] of Object.entries(files)) {
    if (!/\.(?:js|wxss)$/.test(filename)) continue
    const re = filename.endsWith('.js') ? /require\(['"]([^'"]+)['"]\)/g : /@import\s+['"]([^'"]+)['"]/g
    for (const match of source.matchAll(re)) {
      assert(match[1].startsWith('.'))
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(filename), match[1]))
      assert(Object.hasOwn(files, target) || Object.hasOwn(files, target + '.js'), filename + ': ' + target)
    }
  }
})

test('fixture preferences remain in memory, preserve fictional plan and cannot generate', async () => {
  const { userStore, aiPlanner, controls } = memoryServices(), before = controls.snapshot()
  await userStore.patch({ generationPreferences: { servings: 2 } })
  assert.deepEqual(userStore.data.activePlan, before.data.activePlan)
  assert.equal(controls.snapshot().writes, 1)
  await assert.rejects(userStore.patch({ activePlan: null }), /FIXTURE_WRITE_REJECTED/)
  await assert.rejects(aiPlanner.start(), { code: 'UI_FIXTURE_GENERATION_DISABLED' })
  assert.equal(controls.snapshot().starts, 1)
  controls.reset(); assert.deepEqual(controls.snapshot(), before)
})

test('duration input itself reserves a 48px touch width, not only its wrapper', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../miniprogram/pages/planner/planner.wxss'), 'utf8')
  const rule = css.match(/\.duration-input\s*\{([^}]+)\}/)[1]
  assert.match(rule, /(?:^|;)\s*width:\s*48px;/)
  assert.match(rule, /min-width:\s*48px;/)
  assert.match(rule, /min-height:\s*48px;/)
})
