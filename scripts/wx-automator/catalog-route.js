'use strict'

// Navigate to a bundled public example, never a personal meal identifier.
function catalogRoute(route) {
  if (route.replace(/^\//, '') !== 'pages/recipe-detail/recipe-detail') return route
  const first = require('../../miniprogram/data/recipe-catalog')[0]
  if (!first || !/^[a-z0-9_-]+$/.test(first.id)) throw new Error('CATALOG_SMOKE_SAMPLE_MISSING')
  return route + '?id=' + encodeURIComponent(first.id)
}
module.exports = { catalogRoute }
