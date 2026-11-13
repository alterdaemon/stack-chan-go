import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  assertNoCustomBuildOutput,
  buildOutputDirectory,
  firmwareDirectory,
  hostApplicationName,
  invalidateCoreS3Image,
  moddableOutputArguments,
} from './build-output.mjs'

test('build output configuration is repository-local and stable', () => {
  assert.equal(hostApplicationName, 'stack-chan-host')
  assert.equal(buildOutputDirectory, `${firmwareDirectory}/dist`)
  assert.deepEqual(moddableOutputArguments(), ['-o', buildOutputDirectory])
})

test('custom Moddable output directories are rejected', () => {
  assert.throws(() => assertNoCustomBuildOutput(['-o', '/tmp/elsewhere']), /fixed to/)
  assert.throws(() => assertNoCustomBuildOutput(['-o=/tmp/elsewhere']), /fixed to/)
  assert.doesNotThrow(() => assertNoCustomBuildOutput(['-d', '-m']))
})

test('a failed CoreS3 rebuild cannot leave a previous linked image available', () => {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), 'stackchan-image-freshness-'))
  try {
    const target = 'esp32/m5stackchan_cores3/release/stack-chan-host'
    const build = path.join(outputDirectory, 'tmp', target, 'xsProj-esp32s3/build')
    const bin = path.join(outputDirectory, 'bin', target)
    for (const directory of [build, bin]) {
      mkdirSync(directory, { recursive: true })
      for (const suffix of ['elf', 'bin']) writeFileSync(path.join(directory, `xs_esp32.${suffix}`), 'old')
      writeFileSync(path.join(directory, 'bootloader.bin'), 'preserve')
    }
    const options = { platformName: 'm5stackchan_cores3', mode: 'release', outputDirectory }
    assert.throws(() => invalidateCoreS3Image({ ...options, mode: '../wrong' }), /Unsupported/)
    assert.throws(() => invalidateCoreS3Image({ ...options, platformName: '../wrong' }), /Unsupported/)
    invalidateCoreS3Image(options)
    invalidateCoreS3Image(options)
    for (const directory of [build, bin]) {
      for (const suffix of ['elf', 'bin']) assert.equal(existsSync(path.join(directory, `xs_esp32.${suffix}`)), false)
      assert.equal(readFileSync(path.join(directory, 'bootloader.bin'), 'utf8'), 'preserve')
    }
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true })
  }
})
