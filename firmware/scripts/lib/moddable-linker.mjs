import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// This is the build host's preload VM limit, independent of target creation.keys.
export function prepareHostLinker({
  moddableDirectory,
  outputDirectory,
  platform = process.platform,
  run = spawnSync,
}) {
  const host = { linux: 'lin', darwin: 'mac' }[platform]
  if (!host) return undefined
  const xs = path.join(moddableDirectory, 'xs')
  const toolSource = path.join(xs, 'tools/xsl.c')
  const source = readFileSync(toolSource, 'utf8')
  const limit = /([0-9]+)(?:\s*\*\s*([0-9]+))?,([ \t]*)\/\* initialKeyCount \*\//g
  const matches = [...source.matchAll(limit)]
  if (matches.length !== 1) throw new Error('Unsupported xsl host key allocation; check the Moddable SDK')
  const capacity = Number(matches[0][1]) * Number(matches[0][2] ?? 1)
  if (capacity >= 16384) return undefined
  const patched = source.replace(limit, '2048 * 8,$3/* initialKeyCount */')
  const inputs = new Map()
  function collect(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${prefix}/${entry.name}`
      if (entry.isDirectory()) collect(path.join(directory, entry.name), relative)
      else if (entry.isFile() && /\.[ch]$/.test(entry.name))
        inputs.set(relative, readFileSync(path.join(directory, entry.name)))
    }
  }
  for (const directory of ['sources', 'includes', 'platforms']) collect(path.join(xs, directory), directory)
  for (const entry of readdirSync(path.join(xs, 'tools'))
    .filter((name) => /^xsl.*\.[ch]$/.test(name))
    .sort())
    inputs.set(`tools/${entry}`, readFileSync(path.join(xs, 'tools', entry)))
  const makefile = path.join(xs, 'makefiles', host, 'xsl.mk')
  inputs.set('makefile', readFileSync(makefile))
  const hash = createHash('sha256').update(`${host}/${process.arch}/${process.env.CC ?? 'cc'}/16384`)
  for (const [name, bytes] of inputs) hash.update(name).update(bytes)
  const fingerprint = hash.digest('hex')
  const directory = path.join(outputDirectory, 'generated/xsl-host', fingerprint.slice(0, 16))
  const tools = path.join(directory, 'tools')
  const build = path.join(directory, 'build')
  const binaryDirectory = path.join(build, 'bin', host, 'release')
  const binary = path.join(binaryDirectory, 'xsl')
  const receipt = path.join(directory, 'receipt.json')
  const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
  if (existsSync(binary) && existsSync(receipt)) {
    try {
      const saved = JSON.parse(readFileSync(receipt, 'utf8'))
      if (saved.fingerprint === fingerprint && saved.sha256 === digest(binary)) return binaryDirectory
    } catch {
      // An interrupted cache write is rebuilt from the checked SDK inputs.
    }
  }
  mkdirSync(tools, { recursive: true })
  for (const [name, bytes] of inputs) {
    if (name.startsWith('tools/')) writeFileSync(path.join(tools, path.basename(name)), bytes)
  }
  writeFileSync(path.join(tools, 'xsl.c'), patched)
  const result = run(
    'make',
    ['-B', '-f', makefile, 'GOAL=release', `XS_DIR=${xs}`, `TLS_DIR=${tools}`, `BUILD_DIR=${build}`, '-j4'],
    {
      encoding: 'utf8',
      env: { ...process.env, MAKEFLAGS: '' },
      timeout: 180000,
    },
  )
  if (result.error || result.status !== 0 || !existsSync(binary))
    throw new Error(`Host xsl build failed: ${result.error?.message ?? result.stderr?.slice(-2000) ?? result.status}`)
  writeFileSync(
    receipt,
    JSON.stringify({ fingerprint, hostKeys: 16384, targetCreationUnchanged: true, sha256: digest(binary) }),
  )
  return binaryDirectory
}
