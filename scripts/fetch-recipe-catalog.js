'use strict'

// Explicit build-time fetch, not imported by the mini-program or cloud functions.
const fs = require('node:fs')
const path = require('node:path')
const { INPUTS, DATASET_COMMIT } = require('./recipe-catalog-source')
const { CatalogError, safeDirectory, verifyBytes } = require('./recipe-catalog-import')

async function download(spec, fetcher = fetch) {
  if (!INPUTS.includes(spec)) throw new CatalogError('UNAPPROVED_SOURCE')
  const response = await fetcher(`https://raw.githubusercontent.com/${spec.repository}/${spec.commit}/${spec.path}`, {
    redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30000),
    headers: { Accept: 'text/plain, application/json' },
  })
  if (!response.ok || !response.body) throw new CatalogError('SOURCE_DOWNLOAD_FAILED')
  const reader = response.body.getReader(); const chunks = []; let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > spec.bytes) throw new CatalogError('SOURCE_SIZE_EXCEEDED')
      chunks.push(Buffer.from(part.value))
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
  const result = Buffer.concat(chunks)
  verifyBytes(spec.name, result)
  return result
}
async function main() {
  if (process.argv.length !== 2) throw new CatalogError('NO_CUSTOM_PATHS_OR_NETWORK_OPTIONS')
  const directory = safeDirectory(path.resolve(__dirname, '..'), ['.local', 'recipe-catalog', DATASET_COMMIT, 'inputs'])
  for (const spec of INPUTS) {
    const filename = path.join(directory, spec.name)
    if (fs.existsSync(filename)) {
      const stat = fs.lstatSync(filename)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== spec.bytes) throw new CatalogError('UNSAFE_INPUT_FILE')
      verifyBytes(spec.name, fs.readFileSync(filename))
    } else {
      const bytes = await download(spec)
      fs.writeFileSync(filename, bytes, { flag: 'wx' })
    }
  }
  console.log('Four pinned public inputs verified. Stored only in ignored .local; no runtime files changed.')
}
if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof CatalogError ? error.code : 'SOURCE_DOWNLOAD_FAILED')
    process.exitCode = 1
  })
}
module.exports = { download }
