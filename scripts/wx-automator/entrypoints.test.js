'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = __dirname
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8')

test('all runtime state stays in the ignored local automator directory', () => {
  const runtime = require('./automation-runtime')
  assert.equal(runtime.PROJECT_ROOT, path.resolve(root, '..', '..'))
  assert.equal(runtime.LOCAL_AUTOMATOR_DIR, path.join(runtime.PROJECT_ROOT, '.local', 'automator'))
  for (const name of ['smoke.js', 'visual-regression.js', 'interactive-smoke.js', 'ai-safe-release-probe.js']) {
    assert.match(read(name), /LOCAL_AUTOMATOR_DIR/)
    assert.doesNotMatch(
      read(name),
      /path\.join\(__dirname,\s*['"]artifacts['"]/,
    )
  }
})

test('smoke collects ordinary route failures but fails fast on a closed session', () => {
  const source = read('smoke.js')
  assert.match(source, /const SCREENSHOT_TIMEOUT_MS = DEFAULT_SCREENSHOT_TIMEOUT_MS/)
  assert.match(source, /DEVTOOLS_PERFORMANCE_NOTICE/)
  assert.match(source, /expectedRoute:\s*route/)
  assert.match(source, /if \(isFatalSessionError\(error\)\) throw error/)
  assert.match(source, /report\.routes\.some\(\(item\) => item\.category !== 'PASSED'\)/)
  assert.doesNotMatch(source, /item\.stage === 'CAPTURE_SCREENSHOT'\) throw error/)
})

test('visual checks use viewport dimensions and viewport-relative element offsets', () => {
  const source = read('visual-regression.js')
  const runtime = read('automation-runtime.js')
  assert.match(source, /readAutomatorViewport\(miniProgram, initialPage/)
  assert.match(runtime, /'window\.innerWidth', 'window\.innerHeight'/)
  assert.match(runtime, /miniProgram\.evaluate\(function readWindowInfo\(\) \{ return wx\.getWindowInfo\(\) \}\)/)
  assert.doesNotMatch(runtime, /miniProgram\.systemInfo\(\)/)
  assert.doesNotMatch(runtime, /properties:\s*\[[^\]]*scrollHeight/)
  assert.match(source, /DEVTOOLS_PERFORMANCE_NOTICE/)
  assert.doesNotMatch(source, /page\.size\(\)/)
  assert.doesNotMatch(source, /offset\s*&&\s*offset\.top\)\s*-\s*(?:scrollPosition|\(Number\(rawScrollTop\))/)
  assert.match(source, /if \(name !== 'access'\) throw error/)
  assert.match(source, /if \(item\.route !== 'pages\/plan\/plan'\) throw error/)
  assert.match(source, /if \(isFatalSessionError\(probeError\)\) throw probeError/)
})

test('interactive route probes cannot swallow a closed session', () => {
  const source = read('interactive-smoke.js')
  assert.doesNotMatch(source, /currentPage\(\)\.catch\(/)
  assert.match(source, /async function optionalNonFatal/)
  assert.match(source, /if \(isFatalSessionError\(error\)\) throw error/)
})

test('empty history verifies the planner destination without a contradictory back navigation', () => {
  const source = read('interactive-smoke.js')
  const historyStep = source.match(/await step\('HISTORY_CANCEL'[\s\S]*?await step\('DRAFT_SAFE'/)
  assert(historyStep, 'history smoke step must remain present')
  assert.match(historyStep[0], /page = await current\('pages\/planner\/planner', 12000\)/)
  assert.doesNotMatch(historyStep[0], /navigateAndAcquire\(miniProgram, '\/pages\/planner\/planner'/)
  assert.match(historyStep[0], /waitForData\(page, \(next\) => next\.loadingPage === false\)/)
  assert.doesNotMatch(historyStep[0], /miniProgram\.navigateBack\(\)/)
})

test('interactive empty draft and planner task actions use semantic selectors', () => {
  const source = read('interactive-smoke.js')
  const draftStep = source.match(/await step\('DRAFT_SAFE'[\s\S]*?await writableStep\('PLANNER_CONTROLS'/)
  assert(draftStep, 'DRAFT_SAFE step missing')
  assert.match(draftStep[0], /tapControl\(page, '\.state-action', 0\)/)
  assert.doesNotMatch(draftStep[0], /tapControl\(page, 'button'/)

  const plannerStep = source.match(/await writableStep\('PLANNER_CONTROLS'[\s\S]*?await step\('AI_NO_GENERATE'/)
  assert(plannerStep, 'PLANNER_CONTROLS step missing')
  assert.match(plannerStep[0], /elements\(page, '\.bottom-actions \.task-action'\)/)
  assert.match(plannerStep[0], /tapControl\(page, '\.bottom-actions \.task-action', 0\)/)
})

test('history retry remains a blocking failure when the error state persists', () => {
  const source = read('interactive-smoke.js')
  const historyStep = source.match(/await step\('HISTORY_CANCEL'[\s\S]*?await step\('DRAFT_SAFE'/)
  assert(historyStep, 'history smoke step must remain present')
  assert.match(historyStep[0], /if \(retried\.viewState === 'error'\) throw new Error\('餐单历史重试后仍不可用'\)/)
  assert.doesNotMatch(historyStep[0], /skip:\s*true[\s\S]{0,120}(?:历史|重试|不可用)/)
})

test('visual access redirect stays allowed through navigation and screenshot health probes', () => {
  const source = read('visual-regression.js')
  assert.match(source, /allowedRoutes: name === 'access' \? \['pages\/plan\/plan'\] : \[\]/)
  assert.match(source, /allowedRoutes: item\.allowedRoutes/)
  assert.match(source, /captureVisualEvidence\([\s\S]*?allowedRoutes: item\.allowedRoutes \|\| \[\]/)
})

test('planner visual gate validates exact button geometry and screenshot glyph pixels', () => {
  const source = read('visual-regression.js')
  assert.match(source, /assertStepperButtonGeometry\(boxes, report\.viewport, stage\)/)
  assert.match(source, /assertPngStepperGlyphs/)
  assert.match(source, /state\.durationAtMin !== \(durationDays === 1\)/)
  assert.match(source, /state\.durationAtMax !== \(durationDays === 14\)/)
})

test('entrypoints subscribe through the guarded diagnostics helper', () => {
  for (const name of ['smoke.js', 'visual-regression.js', 'interactive-smoke.js']) {
    const source = read(name)
    assert.match(source, /unsubscribeDiagnostics\s*=\s*await subscribeAutomatorDiagnostics\(/)
    assert.match(source, /cleanupAutomatorSession\(miniProgram, unsubscribeDiagnostics\)/)
    assert.match(source, /mergeAutomatorCleanupReport\(report, cleanup\)/)
    assert.match(source, /cleanupFailureCount/)
    assert.doesNotMatch(source, /miniProgram\.on\(['"]console['"]/)
    assert.doesNotMatch(source, /await safeDisconnect\(miniProgram\)/)
  }
})

test('entrypoints use the shared strict diagnostic classifier as a release gate', () => {
  for (const name of ['smoke.js', 'visual-regression.js', 'interactive-smoke.js']) {
    const source = read(name)
    assert.match(source, /classifyAutomatorDiagnostic\(entry\)/)
  }
  assert.match(read('smoke.js'), /report\.cleanupFailureCount/)
  assert.match(read('visual-regression.js'), /report\.cleanupFailureCount/)
  assert.match(read('interactive-smoke.js'), /report\.blockingConsoleCount/)
  assert.match(read('interactive-smoke.js'), /report\.failure\s*=\s*\{/)
})

test('image parser is a direct exact dependency', () => {
  const manifest = JSON.parse(read('package.json'))
  const lock = JSON.parse(read('package-lock.json'))
  assert.equal(manifest.dependencies.pngjs, '3.4.0')
  assert.equal(lock.lockfileVersion, 3)
  assert.equal(lock.packages[''].dependencies.pngjs, '3.4.0')
  assert.equal(lock.packages['node_modules/pngjs'].version, '3.4.0')
})

test('AI release probe exposes only reviewed public task failure categories', () => {
  const source = read('ai-safe-release-probe.js')
  assert.match(source, /PUBLIC_TASK_ERROR_CATEGORIES/)
  assert.match(source, /Object\.prototype\.hasOwnProperty\.call\(publicTaskErrorCategories, value\)/)
  assert.match(source, /classifiedTaskFailure\(task\.errorCode\)/)
  assert.match(source, /fail\(state\.taskFailureCode \|\| 'GENERATION_FAILED'\)/)
  assert.doesNotMatch(source, /task\.failureCode/)
  assert.doesNotMatch(source, /task\.(?:message|detail|response|url|apiKey|openid|unionid)/)
  assert.doesNotMatch(source, /AI_RELEASE_PROBE_(?:FAILED|PROGRESS|GENERATED)[^\n]*task\./)
  assert.doesNotMatch(source, /providerConfigVersionPrefix|AI_RELEASE_PROBE_PROVIDER/)
  assert.match(source, /const clientReadablePlan = \(value\) =>/)
  assert.match(source, /if \(!clientReadablePlan\(clientRead\.data\)/)
})

test('AI release probe verifies the generated draft in plan preview before cleanup without confirming it', () => {
  const source = read('ai-safe-release-probe.js')
  const evidence = read('plan-preview-evidence.js')
  const previewStart = source.indexOf('async function capturePreviewEvidence')
  const previewEnd = source.indexOf('async function cleanupProbe', previewStart)
  assert(previewStart >= 0 && previewEnd > previewStart)
  const previewSource = source.slice(previewStart, previewEnd)
  assert.match(source, /await capturePreviewEvidence\(miniProgram, ownerToken, PROCESS_INSTANCE_ID, DURATION\)/)
  assert.match(source, /navigateAndAcquire\(miniProgram, PREVIEW_URL/)
  assert.match(source, /classifyPreviewDataSummary/)
  assert.match(source, /classifyRenderedSummary/)
  assert.match(source, /'\.page-title'/)
  assert.match(source, /'\.meal-title'/)
  assert.match(source, /'\.ingredient-item'/)
  assert.match(source, /'\.meal-method'/)
  assert.match(source, /captureScreenshotWithRetry\(miniProgram, path\.join\(run\.outputDir, 'top\.png'\)/)
  assert.match(source, /captureScreenshotWithRetry\(miniProgram, path\.join\(run\.outputDir, 'bottom\.png'\)/)
  assert.match(source, /PLAN_PREVIEW_ACTIONS_SELECT/)
  assert.doesNotMatch(previewSource, /callMethod\(['"]confirmPlan['"]|confirmDraft|确认并使用餐单/)
  assert.match(evidence, /dataFields:\s*booleanFields/)
  assert.match(evidence, /renderedFields:\s*booleanFields/)
  assert.doesNotMatch(evidence, /planId|firstMealTitle|ingredientItems|methodText/)
})

test('AI release probe fails closed when recovery state disappeared', () => {
  const source = read('ai-safe-release-probe.js')
  assert.match(source, /'RECOVERY_STATE_LOST'/)
  assert.match(source, /if \(recoveryAction === 'state-lost'\) throw 'RECOVERY_STATE_LOST'/)
  assert.match(source, /if \(journalClaimed && cleanupResult && cleanupResult\.ok\)/)
})
