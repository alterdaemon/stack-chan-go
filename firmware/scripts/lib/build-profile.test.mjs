import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { prepareBuildProfile } from './build-profile.mjs'

test('manifest remapping to an older source invalidates target bytecode, native objects and SDK objects', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'stackchan-profile-'))
  try {
    const manifest = path.join(directory, 'manifest.json')
    const child = path.join(directory, 'child.json')
    writeFileSync(manifest, JSON.stringify({ include: ['./child.json'] }))
    writeFileSync(child, JSON.stringify({ modules: { preference: './original.js' } }))
    const older = path.join(directory, 'older.js')
    writeFileSync(older, 'export default "older source"')
    utimesSync(older, 1, 1)
    const outputDirectory = path.join(directory, 'dist')
    const options = {
      outputDirectory,
      platformName: 'm5stackchan_cores3',
      mode: 'release',
      applicationName: 'stack-chan-host',
      manifest,
    }
    const files = [
      'tmp/esp32/m5stackchan_cores3/release/stack-chan-host/modules/preference.xsb',
      'tmp/esp32/m5stackchan_cores3/release/stack-chan-host/preference.c.o',
      'tmp/esp32/m5stackchan_cores3/release/lib/xsAPI.c.o',
      'bin/esp32/m5stackchan_cores3/release/stack-chan-host/xs_esp32.bin',
    ]
    const untouched = path.join(outputDirectory, 'tmp/esp32/another_target/release/stack-chan-host/output')
    mkdirSync(path.dirname(untouched), { recursive: true })
    writeFileSync(untouched, 'other target')
    const commit = prepareBuildProfile(options)
    for (const file of files) {
      mkdirSync(path.dirname(path.join(outputDirectory, file)), { recursive: true })
      writeFileSync(path.join(outputDirectory, file), 'cached original')
    }
    commit()
    prepareBuildProfile(options)
    for (const file of files) assert.ok(existsSync(path.join(outputDirectory, file)))
    writeFileSync(child, JSON.stringify({ modules: { preference: './older.js' } }))
    prepareBuildProfile(options)
    for (const file of files) assert.ok(!existsSync(path.join(outputDirectory, file)))
    assert.ok(existsSync(untouched))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('failed profile changes remain invalidated until a successful build commits them', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'stackchan-profile-failed-'))
  try {
    const manifest = path.join(directory, 'manifest.json')
    writeFileSync(manifest, JSON.stringify({ creation: { stack: 768 } }))
    const options = {
      outputDirectory: directory,
      platformName: 'm5stackchan_cores3',
      mode: 'release',
      applicationName: 'stack-chan-host',
      manifest,
    }
    const partial = path.join(directory, 'tmp/esp32/m5stackchan_cores3/release/stack-chan-host/partial.xsb')
    prepareBuildProfile(options)
    mkdirSync(path.dirname(partial), { recursive: true })
    writeFileSync(partial, 'incomplete build')
    prepareBuildProfile(options)()
    assert.ok(!existsSync(partial))
    mkdirSync(path.dirname(partial), { recursive: true })
    writeFileSync(partial, 'successful build')
    prepareBuildProfile(options)
    assert.ok(existsSync(partial))
    writeFileSync(manifest, JSON.stringify({ creation: { stack: 1024 } }))
    prepareBuildProfile(options)
    assert.ok(!existsSync(partial))
    mkdirSync(path.dirname(partial), { recursive: true })
    writeFileSync(partial, 'failed changed build')
    writeFileSync(manifest, JSON.stringify({ creation: { stack: 768 } }))
    prepareBuildProfile(options)
    assert.ok(!existsSync(partial), 'returning to the prior profile must discard failed-build output')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
