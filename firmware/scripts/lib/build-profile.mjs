import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Invalidates target output when source mappings or creation settings change. */
export function prepareBuildProfile({
  outputDirectory,
  platformName,
  mode,
  applicationName,
  manifest,
  moddableDirectory,
}) {
  for (const value of [platformName, mode, applicationName]) {
    if (!/^[\w.-]+$/.test(value) || value === '.' || value === '..') throw new Error('Invalid build profile path')
  }
  const digest = createHash('sha256')
  const visited = new Set()
  const variables = {
    MODDABLE: moddableDirectory,
    MODULES: moddableDirectory && path.join(moddableDirectory, 'modules'),
  }
  function visit(filename) {
    filename = path.resolve(filename)
    if (existsSync(filename) && statSync(filename).isDirectory()) filename = path.join(filename, 'manifest.json')
    if (visited.has(filename)) return
    visited.add(filename)
    digest.update(filename).update('\0')
    if (!existsSync(filename)) return
    const source = readFileSync(filename, 'utf8')
    digest.update(source).update('\0')
    const data = JSON.parse(source)
    for (const block of [data, ...Object.values(data.platforms ?? {})]) {
      for (let include of [block.include].flat().filter(Boolean)) {
        if (typeof include !== 'string') continue
        include = include.replace(/\$\((\w+)\)/g, (original, name) => variables[name] ?? original)
        if (!include.includes('$(')) visit(path.resolve(path.dirname(filename), include))
      }
    }
  }
  visit(manifest)
  // Board manifests are selected by -p, independently of application includes.
  visit(fileURLToPath(new URL(`../../host/platforms/${platformName}/manifest.json`, import.meta.url)))
  if (moddableDirectory) {
    visit(path.join(moddableDirectory, 'build/devices/esp32/targets', platformName, 'manifest.json'))
    const version = path.join(moddableDirectory, 'tools/VERSION')
    digest.update(moddableDirectory)
    if (existsSync(version)) digest.update(readFileSync(version))
  }
  const fingerprint = digest.digest('hex')
  const profile = path.join(
    outputDirectory,
    'generated/build-profiles',
    platformName,
    mode,
    `${applicationName}.sha256`,
  )
  const previous = existsSync(profile) ? readFileSync(profile, 'utf8') : undefined
  if (previous !== fingerprint) {
    // Make compares timestamps, so remapping an alias to an older source can
    // otherwise keep bytecode and native objects from a different manifest.
    rmSync(path.join(outputDirectory, 'tmp/esp32', platformName, mode, applicationName), {
      recursive: true,
      force: true,
    })
    rmSync(path.join(outputDirectory, 'tmp/esp32', platformName, mode, 'lib'), { recursive: true, force: true })
    rmSync(path.join(outputDirectory, 'bin/esp32', platformName, mode, applicationName), {
      recursive: true,
      force: true,
    })
  }
  return () => {
    mkdirSync(path.dirname(profile), { recursive: true })
    const temporary = `${profile}.${process.pid}.tmp`
    writeFileSync(temporary, fingerprint)
    renameSync(temporary, profile)
  }
}
