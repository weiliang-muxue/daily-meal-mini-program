'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const catalog = require('./recipe-catalog-import')
const source = require('./recipe-catalog-source')
const { download } = require('./fetch-recipe-catalog')

// Public-domain license, byte-for-byte fixture for both pinned LICENSE inputs.
const license = Buffer.from(`This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <https://unlicense.org>
`, 'utf8')

function fixture(suffix = 'one') {
  const id = `test_${suffix}`
  const record = {
    id, title: `虚构测试菜 ${suffix}`, category: '测试', markdown_path: `dishes/test/测试/${suffix}.md`,
    status: 'published', summary: '仅供自动测试的虚构菜谱', difficulty: 1, duration_min: 10, calories: 100,
    tags: ['测试'], cover_image: `ai-generated/${id}.jpg`, overview_image: `overview/${id}_overview.jpg`,
    ingredients: [{ name: '测试鸡蛋', amount: '1个（只用蛋清）', buying_tip: '保留蛋清说明', optional: false, per_serving: true }],
    tools: ['测试锅'], servings: { base: 1, formula: [{ name: '测试鸡蛋', expr: '1 * n' }] },
    steps: [{ index: 1, title: '测试步骤', instruction: '虚构流程，不作实际操作指导', duration_sec: 60,
      tips: ['测试提示'], produces: null, image: `steps/${id}/step_1.jpg` }], tips: ['测试说明'],
  }
  const index = {}
  ;['id', 'title', 'category', 'markdown_path', 'cover_image', 'overview_image', 'difficulty', 'duration_min', 'calories', 'tags']
    .forEach(key => { index[key] = record[key] })
  index.json_path = `json/recipes/${id}.json`
  return { index, record }
}
function analyzeOne(change = () => {}) {
  const { index, record } = fixture(); change(record, index)
  return catalog.analyze([index], [record])
}
function quarantines(change, code) {
  const result = analyzeOne(change)
  assert.equal(result.candidates.length, 0)
  assert.equal(result.quarantined.length, 1)
  assert.equal(result.quarantined[0].reason, code)
  return result
}
function throwsCode(fn, code) { assert.throws(fn, error => error instanceof catalog.CatalogError && error.code === code) }
function withDirectory(fn) {
  const base = fs.realpathSync(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(base, 'meal-catalog-test-'))
  try { fn(directory) } finally {
    const resolved = fs.realpathSync(directory)
    assert.equal(path.dirname(resolved), base)
    assert(path.basename(resolved).startsWith('meal-catalog-test-'))
    assert(!fs.lstatSync(directory).isSymbolicLink())
    fs.rmSync(resolved, { recursive: true, force: false })
  }
}

test('fixed inputs are four allowlisted files, single aggregate representation, no moving refs', () => {
  assert.equal(source.INPUTS.length, 4)
  assert(source.INPUTS.every(item => /^[a-f0-9]{40}$/.test(item.commit)))
  assert.deepEqual(source.INPUTS.map(item => item.path), ['LICENSE', 'LICENSE', 'json/index.json', 'json/recipes.json'])
  assert.equal(source.INPUTS.filter(item => item.path === 'json/recipes.json').length, 1)
  assert(Object.isFrozen(source.INPUTS) && source.INPUTS.every(Object.isFrozen))
})
test('both license pins match complete public-domain text including LF bytes', () => {
  assert.equal(license.length, 1211)
  assert.equal(catalog.sha256(license), source.LICENSE_SHA256)
  for (const name of ['dataset-license.txt', 'upstream-license.txt']) assert.equal(catalog.verifyBytes(name, license).name, name)
})
test('missing, modified, wrong-size, CRLF and unknown inputs fail before import', () => {
  for (const value of [null, license.toString('utf8'), Buffer.from('bad'), Buffer.from(license.toString().replace(/\n/g, '\r\n'))]) {
    throwsCode(() => catalog.verifyBytes('dataset-license.txt', value), 'INPUT_INTEGRITY_FAILED')
  }
  const tampered = Buffer.from(license); tampered[0] ^= 1
  throwsCode(() => catalog.verifyBytes('dataset-license.txt', tampered), 'INPUT_INTEGRITY_FAILED')
  throwsCode(() => catalog.verifyBytes('main/LICENSE', license), 'INPUT_INTEGRITY_FAILED')
})
test('successful transform preserves all food quantities/notes but no image or nutrition estimates', () => {
  const result = analyzeOne()
  assert.equal(result.candidates.length, 1); assert.equal(result.quarantined.length, 0)
  const item = result.candidates[0]
  assert.equal(item.record.ingredients[0].amount, '1个（只用蛋清）')
  assert.equal(item.record.ingredients[0].note, '保留蛋清说明')
  assert.equal(item.record.ingredients[0].perServing, true)
  assert(!/image|jpg|calories|summary|formula|difficulty|tags|produces/.test(JSON.stringify(item.record)))
  assert.equal(result.releaseReady, false); assert.equal(result.runtimeCatalogWritten, false)
  assert.equal(item.provenance.source_commit, 'unknown')
  assert.equal(item.provenance.source_path_verified, false)
  assert.equal(item.provenance.review_status.content, 'pending')
  assert.equal(item.provenance.review_status.license, 'pending-input-integrity')
  assert.equal(result.inputIntegrityVerified, false)
  assert.equal(item.provenance.image_policy, 'excluded')
  assert.equal(item.provenance.imported_record_sha256, catalog.recordHash(item.record))
})
test('nullable hints in the fixed dataset are supported, numbers in hints are not', () => {
  const first = analyzeOne(record => { record.steps[0].tips = null })
  assert.deepEqual(first.candidates[0].record.steps[0].tips, [])
  const second = analyzeOne(record => { record.steps[0].tips = [null, '保留提示', null] })
  assert.deepEqual(second.candidates[0].record.steps[0].tips, ['保留提示'])
  quarantines(record => { record.steps[0].tips = [1] }, 'INVALID_TEXT')
})
test('ordinary comparison signs remain text and never become HTML', () => {
  const result = analyzeOne(record => { record.ingredients[0].buying_tip = '甲 > 乙，温度 < 100 度' })
  assert.equal(result.candidates[0].record.ingredients[0].note, '甲 > 乙，温度 < 100 度')
})
test('deterministic canonical hashes ignore object and record order, not list order', () => {
  const a = fixture('a'); const b = fixture('b')
  const before = JSON.stringify([a, b])
  const first = catalog.analyze([a.index, b.index], [a.record, b.record])
  assert.deepEqual(first, catalog.analyze([b.index, a.index], [b.record, a.record]))
  assert.equal(JSON.stringify([a, b]), before)
  assert.equal(catalog.recordHash({ b: 1, a: 2 }), catalog.recordHash({ a: 2, b: 1 }))
  assert.notEqual(catalog.recordHash([1, 2]), catalog.recordHash([2, 1]))
  assert.equal(first.importedAt, catalog.IMPORTED_AT)
})
test('source and transformed digests are distinct and cannot claim a generated upstream version', () => {
  const { index, record } = fixture()
  const item = catalog.analyze([index], [record]).candidates[0]
  assert.equal(item.provenance.source_record_sha256, catalog.recordHash(record))
  assert.equal(item.provenance.source_index_sha256, catalog.recordHash(index))
  assert.notEqual(item.provenance.source_record_sha256, item.provenance.imported_record_sha256)
  assert.equal(item.provenance.dataset_record_path, 'json/recipes.json#id=test_one')
  assert.equal(item.provenance.dataset_individual_path, 'json/recipes/test_one.json')
})
test('duplicate ids and missing index mappings fail whole batches instead of overwriting', () => {
  const a = fixture('a'); const b = fixture('b')
  throwsCode(() => catalog.analyze([a.index, a.index], [a.record, b.record]), 'DUPLICATE_INDEX_ID')
  throwsCode(() => catalog.analyze([a.index, b.index], [a.record, a.record]), 'DUPLICATE_RECORD_ID')
  throwsCode(() => catalog.analyze([a.index], [b.record]), 'MISSING_SOURCE_INDEX')
  throwsCode(() => catalog.analyze([a.index], [a.record, b.record]), 'COUNT_MISMATCH')
})
test('source-path aliases quarantine every involved item', () => {
  const a = fixture('a'); const b = fixture('b')
  b.record.markdown_path = a.record.markdown_path; b.index.markdown_path = a.record.markdown_path
  const result = catalog.analyze([a.index, b.index], [a.record, b.record])
  assert.equal(result.candidates.length, 0)
  assert(result.quarantined.every(item => item.reason === 'DUPLICATE_SOURCE_PATH'))
})
test('path traversal, absolute/encoded paths and wrong detail paths do not establish provenance', () => {
  for (const value of ['dishes/../x.md', '/dishes/x.md', 'dishes/a/%2e%2e/x.md', 'dishes/a\\x.md', 'dishes//x.md', 'dishes/a/x.md?y']) {
    quarantines((record, index) => { record.markdown_path = index.markdown_path = value }, 'INVALID_SOURCE_PATH')
  }
  quarantines((_, index) => { index.json_path = 'json/recipes/other.json' }, 'INVALID_RECORD_PATH')
  quarantines((_, index) => { index.title = '不同标题' }, 'SOURCE_MAPPING_MISMATCH')
  quarantines((_, index) => { index.markdown_path = 'dishes/test/other.md' }, 'SOURCE_MAPPING_MISMATCH')
  quarantines((_, index) => { index.duration_min = 12 }, 'SOURCE_MAPPING_MISMATCH')
})
test('unknown fields including prototype-like JSON keys are rejected, not silently dropped', () => {
  quarantines(record => { record.endpoint = 'external' }, 'UNEXPECTED_FIELDS')
  quarantines(record => { record.ingredients[0].extra = true }, 'UNEXPECTED_FIELDS')
  quarantines(record => { Object.defineProperty(record, '__proto__', { value: {}, enumerable: true }) }, 'UNEXPECTED_FIELDS')
  quarantines((_, index) => { index.extra = true }, 'UNEXPECTED_FIELDS')
})
test('HTML, URLs, control characters and bidirectional overrides are quarantined', () => {
  for (const value of ['<script>bad()</script>', '<img src=x>', 'https://example.invalid', 'javascript:bad()', 'data:text/html,x', 'bad\u0000', 'bad\u202e']) {
    quarantines(record => { record.steps[0].instruction = value }, 'UNSAFE_TEXT')
  }
  quarantines(record => { record.summary = 'https://example.invalid' }, 'UNSAFE_TEXT')
})
test('empty required text, excessive text and malformed types are rejected without truncation', () => {
  quarantines(record => { record.title = ' '.repeat(5) }, 'EMPTY_TEXT')
  quarantines(record => { record.ingredients[0].name = '食'.repeat(81) }, 'INVALID_TEXT')
  quarantines(record => { record.ingredients[0].optional = 'false' }, 'INVALID_BOOLEAN')
  quarantines(record => { record.servings.base = 0 }, 'INVALID_NUMBER')
  quarantines(record => { record.duration_min = NaN }, 'INVALID_NUMBER')
  quarantines(record => { record.ingredients = [] }, 'INVALID_LIST')
  quarantines(record => { record.steps[0].index = 2 }, 'INVALID_STEP_SEQUENCE')
  quarantines(record => { record.status = 'draft' }, 'UNPUBLISHED_SOURCE')
})
test('formula strings are never executed; quantities stay textual with original serving basis', () => {
  const result = analyzeOne(record => {
    record.servings.formula[0].expr = 'process.exit(99)'
    record.ingredients[0].amount = '适量'; record.servings.base = 4
  })
  assert.equal(result.candidates[0].record.ingredients[0].amount, '适量')
  assert.equal(result.candidates[0].record.servings, 4)
  assert(!JSON.stringify(result.candidates).includes('process.exit'))
})
test('screening flags are review hints, never authorization or clinical certification', () => {
  const result = analyzeOne(record => {
    record.summary = '生食和孕妇说明需要另行检查'; record.servings.base = 30
    record.steps[0].duration_sec = 432000
    record.tips = ['参考教程']
  })
  assert.deepEqual(result.candidates[0].provenance.review_flags, [
    'RAW_OR_UNDERCOOKED', 'HEALTH_CLAIM_OR_SPECIAL_POPULATION', 'THIRD_PARTY_OR_BRAND_REFERENCE',
    'LONG_PREPARATION', 'DURATION_BASIS_REVIEW', 'LARGE_BATCH',
  ])
  assert.equal(result.releaseReady, false)
  assert.equal(result.candidates[0].provenance.review_status.content, 'pending')
})
test('fixed source Unicode ids and nested Markdown paths are preserved, not renamed', () => {
  const { index, record } = fixture()
  record.id = index.id = 'test_（-one-）'; index.json_path = `json/recipes/${record.id}.json`
  const result = catalog.analyze([index], [record])
  assert.equal(result.candidates[0].record.id, record.id)
  assert.equal(result.candidates[0].provenance.source_path, record.markdown_path)
})
test('offline analysis cannot initiate any HTTP fetch', () => {
  const original = global.fetch
  global.fetch = () => { throw new Error('network forbidden') }
  try { assert.equal(analyzeOne().candidates.length, 1) } finally { global.fetch = original }
  const sourceText = fs.readFileSync(path.join(__dirname, 'recipe-catalog-import.js'), 'utf8')
  assert(!/require\(['"](?:https?|node:https?)['"]\)|\bfetch\(/.test(sourceText))
})
test('download uses only frozen public input, rejects redirects and includes no authorization', async () => {
  const result = await download(source.INPUTS[0], async (url, options) => {
    assert.equal(url, `https://raw.githubusercontent.com/zkeq/vibe-cook-backend/${source.DATASET_COMMIT}/LICENSE`)
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit')
    assert.deepEqual(options.headers, { Accept: 'text/plain, application/json' })
    return new Response(license)
  })
  assert.deepEqual(result, license)
  await assert.rejects(download({ ...source.INPUTS[0] }, () => { throw new Error('must not fetch') }), /UNAPPROVED_SOURCE/)
})
test('download rejects HTTP failures, size overruns and changed body bytes', async () => {
  await assert.rejects(download(source.INPUTS[0], async () => new Response('no', { status: 403 })), /SOURCE_DOWNLOAD_FAILED/)
  await assert.rejects(download(source.INPUTS[0], async () => new Response(Buffer.concat([license, Buffer.from('x')]))), /SOURCE_SIZE_EXCEEDED/)
  await assert.rejects(download(source.INPUTS[0], async () => new Response('changed')), /INPUT_INTEGRITY_FAILED/)
})
test('writes are idempotent, conflicts are not overwritten and unexpected input files fail', () => {
  withDirectory(directory => {
    const target = path.join(catalog.safeDirectory(directory, ['review']), 'output.json')
    catalog.writeIfSameOrMissing(target, '{}\n')
    catalog.writeIfSameOrMissing(target, '{}\n')
    throwsCode(() => catalog.writeIfSameOrMissing(target, '{"changed":true}\n'), 'OUTPUT_CONFLICT')
    assert.equal(fs.readFileSync(target, 'utf8'), '{}\n')
    throwsCode(() => catalog.readInputs(path.dirname(target)), 'UNEXPECTED_INPUT_FILES')
    throwsCode(() => catalog.safeDirectory(directory, ['..']), 'INVALID_DIRECTORY')
    throwsCode(() => catalog.safeDirectory(directory, ['dir/name']), 'INVALID_DIRECTORY')
  })
})
test('CLI does not accept arbitrary roots, URLs or release/publish switches', () => {
  for (const script of ['recipe-catalog-import.js', 'fetch-recipe-catalog.js']) {
    const result = spawnSync(process.execPath, [path.join(__dirname, script), '--publish'], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /NO_CUSTOM_PATHS_OR_NETWORK_OPTIONS/)
  }
})
test('junction/symlink directories cannot redirect cached inputs or reports', () => {
  withDirectory(directory => {
    const target = path.join(directory, 'target'); fs.mkdirSync(target)
    const link = path.join(directory, 'linked')
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    throwsCode(() => catalog.safeDirectory(directory, ['linked']), 'UNSAFE_DIRECTORY')
    assert.deepEqual(fs.readdirSync(target), [])
  })
})
test('neither tools, licenses in the cache nor review candidates enter the WeChat package', () => {
  const { runtimeFile } = require('./build-wechat-package')
  for (const name of [
    'scripts/recipe-catalog-import.js', 'scripts/recipe-catalog-source.js', 'scripts/fetch-recipe-catalog.js',
    `.local/recipe-catalog/${source.DATASET_COMMIT}/inputs/recipes.json`,
    `.local/recipe-catalog/${source.DATASET_COMMIT}/inputs/dataset-license.txt`,
    `.local/recipe-catalog/${source.DATASET_COMMIT}/review-v1-example/candidates.json`,
  ]) assert.equal(runtimeFile(name), false)
  assert(fs.readFileSync(path.join(__dirname, '../.gitignore'), 'utf8').split(/\r?\n/).includes('.local/'))
})
