'use strict'

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '../cloudfunctions/aiPlanner/legacy-v2')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'source-manifest.json'), 'utf8'))
const names = ['index.js', 'lib.js', 'not-found.js', 'provider-compat.js', 'provider-config.js', 'task-core.js', 'transport.js', 'user-state.js']
assert.strictEqual(manifest.sourceCommit, 'd5eb53382ad37d34cf0e14d57a33f42c1a45578b')
assert.strictEqual(manifest.releaseVersion, '0.2.1')
assert.deepStrictEqual(Object.keys(manifest.files).sort(), names)
for (const [name, expected] of Object.entries(manifest.files)) {
  const source = fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n')
  assert.strictEqual(crypto.createHash('sha256').update(source).digest('hex'), expected, `frozen AI source changed: ${name}`)
  for (const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    assert(['wx-server-sdk', 'crypto', 'dns', 'https', 'net', ...names.map(file => `./${file.slice(0, -3)}`)].includes(match[1]))
  }
}
const lib = require(path.join(root, 'lib'))
const tasks = require(path.join(root, 'task-core'))
const state = require(path.join(root, 'user-state'))
assert.strictEqual(lib.CONTRACT_VERSION, 2)
assert.strictEqual(lib.PLANNER_VERSION, '7')
assert.strictEqual(tasks.TASK_SCHEMA_VERSION, 3)
assert.strictEqual(tasks.AI_DATA_CONSENT_VERSION, 2)
assert.strictEqual(state.CURRENT_SCHEMA, 8)
assert.throws(() => state.migrate({ ...state.defaults(), schemaVersion: 13 }), error => error.code === 'STATE_SCHEMA_UNSUPPORTED')
assert.strictEqual(fs.readFileSync(path.join(root, 'user-state.js'), 'utf8').replace(/\r\n/g, '\n'),
  fs.readFileSync(path.resolve(root, '../../userData/legacy-v8/user-state.js'), 'utf8').replace(/\r\n/g, '\n'))
console.log('Released AI source pin, protocol constants and shared legacy state passed')
