'use strict'

// No network, Git history, configuration or actual user documents are needed.
// Pin the exact released implementation so shared schema-copy scripts cannot
// accidentally turn the old-client path into a new-schema writer.
const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '../cloudfunctions/userData/legacy-v8')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'source-manifest.json'), 'utf8'))
assert.strictEqual(manifest.releaseVersion, '0.2.1')
assert.strictEqual(manifest.sourceCommit, 'd5eb53382ad37d34cf0e14d57a33f42c1a45578b')
assert.strictEqual(manifest.stateSchemaVersion, 8)
assert.deepStrictEqual(Object.keys(manifest.files).sort(), ['index.js', 'legacy-plan.js', 'not-found.js', 'user-state.js'])
for (const [name, expected] of Object.entries(manifest.files)) {
  const source = fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n')
  assert.strictEqual(crypto.createHash('sha256').update(source).digest('hex'), expected, `frozen source changed: ${name}`)
  for (const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    assert(['wx-server-sdk', './user-state', './legacy-plan', './not-found'].includes(match[1]), 'unexpected legacy dependency')
  }
}
const legacy = require(path.join(root, 'user-state'))
assert.strictEqual(legacy.CURRENT_SCHEMA, 8)
for (const schemaVersion of [9, 10, 11, 12, 13, 14]) {
  assert.throws(() => legacy.migrate({ ...legacy.defaults(), schemaVersion }), error => error.code === 'STATE_SCHEMA_UNSUPPORTED')
}
console.log('Released userData source pin and newer-document rejection passed')
