'use strict'

// Build-time public evidence only. Never read provider configuration or user data.
const DATASET_COMMIT = 'b227b896d650709aa345e639634ecd5c3358e607'
const SOURCE_VERIFICATION_COMMIT = 'c694a5c457d45e6e012ae6cd9a7724aab86e320b'
const LICENSE_SHA256 = '6b0382b16279f26ff69014300541967a356a666eb0b91b422f6862f6b7dad17e'
const INPUTS = Object.freeze([
  Object.freeze({ name: 'dataset-license.txt', repository: 'zkeq/vibe-cook-backend', commit: DATASET_COMMIT,
    path: 'LICENSE', bytes: 1211, sha256: LICENSE_SHA256 }),
  Object.freeze({ name: 'upstream-license.txt', repository: 'Anduin2017/HowToCook', commit: SOURCE_VERIFICATION_COMMIT,
    path: 'LICENSE', bytes: 1211, sha256: LICENSE_SHA256 }),
  Object.freeze({ name: 'index.json', repository: 'zkeq/vibe-cook-backend', commit: DATASET_COMMIT,
    path: 'json/index.json', bytes: 196695,
    sha256: '5b62c934a9d6d375eafda5f8fb44f950b11ccdb5f59d3a188040bef6d45ea172' }),
  Object.freeze({ name: 'recipes.json', repository: 'zkeq/vibe-cook-backend', commit: DATASET_COMMIT,
    path: 'json/recipes.json', bytes: 2339189,
    sha256: '4bb0203fa7b5dfaa0ae9262a4f747da20fa05ca74c4dd9c021ea914dc1eb44fe' }),
])

module.exports = { DATASET_COMMIT, SOURCE_VERIFICATION_COMMIT, LICENSE_SHA256, INPUTS }
