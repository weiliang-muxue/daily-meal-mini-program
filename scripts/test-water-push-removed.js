'use strict'

// Retain historic state and owner-scoped cleanup, but no UI or sending ability.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const { runtimeFile } = require('./build-wechat-package')
const { defaults, migrate } = require('../shared/user-state')
const app = JSON.parse(read('miniprogram/app.json'))
assert(!app.pages.some(page => /water-reminder/.test(page)))
for (const file of [
  'miniprogram/pages/water-reminder/water-reminder.js',
  'miniprogram/pages/water-reminder/push-actions.js',
  'miniprogram/services/water-push.js',
  'cloudfunctions/waterReminder/index.js',
  'cloudfunctions/waterReminder/config.json',
]) assert(!fs.existsSync(path.join(root, file)), `${file} must stay removed`)

function checkRuntime(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const file = `${directory}/${entry.name}`
    if (entry.isDirectory()) checkRuntime(file)
    else if (/\.(?:js|json|wxml)$/.test(file) && !/\.test\.js$/.test(file)) {
      assert(!/requestSubscribeMessage|subscribeMessage\.send|waterReminderMinute|services\/water-push|openWaterReminder/.test(read(file)),
        `${file} must not subscribe, send or link to cancelled water push`)
    }
  }
}
checkRuntime('miniprogram')
checkRuntime('cloudfunctions')
assert(!runtimeFile('cloudfunctions/waterReminder/index.js'))
assert(!runtimeFile('cloudfunctions/waterReminder/config.json'))
assert(!JSON.parse(read('database.indexes.json')).indexes.some(index => index.collectionName === 'meal_water_push'))
assert.deepStrictEqual(JSON.parse(read('database.rules.json')).meal_water_push, { read: false, write: false })
assert(read('cloudfunctions/privacy/index.js').includes("{ collection: 'meal_water_push', id: openid }"))

const before = { ...defaults(), schemaVersion: 8, stateRevision: 7,
  waterReminder: { ...defaults().waterReminder, enabled: true, scheduleVersion: 5 } }
const frozen = JSON.stringify(before)
const after = migrate(before)
assert.strictEqual(JSON.stringify(before), frozen, 'migration must not mutate its input')
assert.deepStrictEqual(after.waterReminder, before.waterReminder, 'removal must not delete historic preferences')
assert.strictEqual(after.stateRevision, 7)
assert.deepStrictEqual(after.activePlan, before.activePlan)
assert.deepStrictEqual(after.planHistory, before.planHistory)
for (const file of ['smoke.js', 'visual-regression.js', 'interactive-smoke.js', 'run-mainline-smoke.js']) {
  assert(!/water-reminder|WATER_REMINDER_DRAFT/.test(read(`scripts/wx-automator/${file}`)))
}
console.log('Cancelled water push: no UI, subscription, sender, timer or package entry; historic data and privacy guards retained')
