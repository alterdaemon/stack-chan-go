import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'

import { releaseNotesForTag, validateRelease, versionFromReleaseTag } from './release-validation.mjs'

const temporaryDirectories = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

function createReleaseFixture(version = '1.0.0') {
  const rootDirectory = mkdtempSync(path.join(tmpdir(), 'stackchan-release-'))
  temporaryDirectories.push(rootDirectory)

  for (const directory of ['firmware', 'web/flash', 'docs/release-notes', '.changeset']) {
    mkdirSync(path.join(rootDirectory, directory), { recursive: true })
  }
  for (const packageDirectory of ['firmware', 'web']) {
    writeFileSync(path.join(rootDirectory, packageDirectory, 'package.json'), JSON.stringify({ version }))
    writeFileSync(
      path.join(rootDirectory, packageDirectory, 'package-lock.json'),
      JSON.stringify({ version, packages: { '': { version } } }),
    )
  }
  writeFileSync(path.join(rootDirectory, 'web', 'flash', 'manifest_esp32_fixture.json'), JSON.stringify({ version }))
  if (/-[rR]/.test(version))
    writeFileSync(path.join(rootDirectory, 'CHANGELOG-MOD.md'), `# Fork changes\n\n### ${version}\n\nRelease notes.\n`)
  else writeFileSync(path.join(rootDirectory, 'docs/release-notes', `v${version}.md`), '# Release notes\n')
  writeFileSync(path.join(rootDirectory, '.changeset', 'README.md'), '# Changesets\n')

  return rootDirectory
}

test('versionFromReleaseTag accepts stable versions and numbered fork revisions', () => {
  assert.equal(versionFromReleaseTag('v1.0.0'), '1.0.0')
  assert.equal(versionFromReleaseTag('v2.1.0-R1'), '2.1.0-R1')
  for (let revision = 1; revision <= 11; revision++) {
    assert.equal(versionFromReleaseTag(`v2.0.1-r${revision}`), `2.0.1-r${revision}`)
  }
  for (const tag of ['1.0.0', 'v1.0.0rc', 'v1.0', 'latest', 'v2.0.1-r0', 'v2.0.1-r01', 'v2.0.1-beta1', 'v2.0.1-rc1']) {
    assert.throws(() => versionFromReleaseTag(tag), /must match vX\.Y\.Z/)
  }
})

test('validateRelease accepts aligned package metadata and release notes', () => {
  const rootDirectory = createReleaseFixture()
  assert.equal(validateRelease(rootDirectory, 'v1.0.0').version, '1.0.0')
  assert.equal(validateRelease(rootDirectory, 'v1.0.0').prerelease, false)
})

test('validateRelease validates fork revision metadata and identifies a prerelease', () => {
  const rootDirectory = createReleaseFixture('2.0.1-r10')
  const result = validateRelease(rootDirectory, 'v2.0.1-r10')
  assert.equal(result.version, '2.0.1-r10')
  assert.equal(result.prerelease, true)
  assert.equal(result.releaseNotes, 'Release notes.')
  assert.throws(() => validateRelease(rootDirectory, 'v2.0.1-r9'), /expected 2\.0\.1-r9/)
})

test('fork notes select exactly the requested revision and preserve its subsections and code', () => {
  const root = createReleaseFixture('2.1.0-R1')
  const body = 'Release impact: patch.\n\n#### Checks\n\nPassed.\n\n```md\n### 2.1.0-R1\n```'
  writeFileSync(
    path.join(root, 'CHANGELOG-MOD.md'),
    `# Changes\n\n## Unreleased\n\nNot published.\n\n## 2.1.0\n\n### 2.1.0-R10\n\nLater.\n\n### 2.1.0-R1\n\n${body}\n\n## 2.0.1\n\n### 2.0.1-r15\n\nOlder.\n`.replaceAll(
      '\n',
      '\r\n',
    ),
  )
  assert.equal(releaseNotesForTag(root, 'v2.1.0-R1').releaseNotes, body)
  assert.equal(releaseNotesForTag(root, 'v2.0.1-r15').releaseNotes, 'Older.')
})

test('fork notes reject missing, empty and duplicate revisions instead of publishing another section', () => {
  const root = createReleaseFixture('2.1.0-R1')
  for (const document of [
    '### 2.1.0-R10\n\nWrong revision.',
    '### 2.1.0-R1\n\n### 2.0.1-r15\n\nOther series.',
    '### 2.1.0-R1\n\nFirst.\n\n### 2.1.0-R1\n\nDuplicate.',
    '~~~md\n### 2.1.0-R1\n\nOnly an example.\n~~~',
  ]) {
    writeFileSync(path.join(root, 'CHANGELOG-MOD.md'), document)
    assert.throws(() => validateRelease(root, 'v2.1.0-R1'), /release (section|notes)/)
  }
})

test('validateRelease rejects mismatched versions', () => {
  const rootDirectory = createReleaseFixture()
  writeFileSync(path.join(rootDirectory, 'web', 'package.json'), JSON.stringify({ version: '0.1.0' }))
  assert.throws(() => validateRelease(rootDirectory, 'v1.0.0'), /web\/package\.json version is 0\.1\.0/)
})

test('validateRelease rejects a mismatched web flash manifest version', () => {
  const rootDirectory = createReleaseFixture()
  writeFileSync(
    path.join(rootDirectory, 'web', 'flash', 'manifest_esp32_fixture.json'),
    JSON.stringify({ version: '0.1.0' }),
  )
  assert.throws(
    () => validateRelease(rootDirectory, 'v1.0.0'),
    /web[/\\]flash[/\\]manifest_esp32_fixture\.json version is 0\.1\.0/,
  )
})

test('validateRelease rejects unconsumed Changesets', () => {
  const rootDirectory = createReleaseFixture()
  writeFileSync(path.join(rootDirectory, '.changeset', 'pending.md'), '# Pending\n')
  assert.throws(() => validateRelease(rootDirectory, 'v1.0.0'), /pending Changesets must be consumed/)
})
