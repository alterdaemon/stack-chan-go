import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const VERSIONED_PACKAGES = [
  'firmware/package.json',
  'firmware/package-lock.json',
  'web/package.json',
  'web/package-lock.json',
]

export function versionFromReleaseTag(tag) {
  const match = /^v(\d+\.\d+\.\d+(?:-[rR][1-9]\d*)?)$/.exec(tag)
  if (!match) throw new Error(`release tag must match vX.Y.Z or vX.Y.Z-RN (N >= 1): ${tag}`)
  return match[1]
}

export function releaseNotesForTag(rootDirectory, tag) {
  const version = versionFromReleaseTag(tag)
  const prerelease = /-[rR][1-9]\d*$/.test(version)
  const relativePath = prerelease ? 'CHANGELOG-MOD.md' : `docs/release-notes/v${version}.md`
  const releaseNotePath = path.join(rootDirectory, relativePath)
  if (!existsSync(releaseNotePath)) throw new Error(`release notes are missing: ${relativePath}`)
  let releaseNotes = readFileSync(releaseNotePath, 'utf8').trim()
  if (prerelease) {
    const lines = releaseNotes.split(/\r?\n/)
    const headings = []
    let fence
    for (const [index, line] of lines.entries()) {
      const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (delimiter) {
        if (!fence) fence = delimiter[1]
        else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim())
          fence = undefined
        continue
      }
      if (fence) continue
      const heading = /^(#{1,3})\s+(.+?)\s*$/.exec(line)
      if (heading) headings.push({ index, level: heading[1].length, title: heading[2] })
    }
    const matches = headings.filter((heading) => heading.level === 3 && heading.title === version)
    if (matches.length !== 1) throw new Error(`expected exactly one release section for ${version} in ${relativePath}`)
    const start = matches[0].index + 1
    const end = headings.find((heading) => heading.index >= start)?.index ?? lines.length
    releaseNotes = lines.slice(start, end).join('\n').trim()
  }
  if (!releaseNotes) throw new Error(`release notes are empty for ${version}: ${relativePath}`)
  return { releaseNotePath, releaseNotes, version, prerelease }
}

export function validateRelease(rootDirectory, tag) {
  const version = versionFromReleaseTag(tag)

  for (const relativePath of VERSIONED_PACKAGES) {
    const document = JSON.parse(readFileSync(path.join(rootDirectory, relativePath), 'utf8'))
    if (document.version !== version) {
      throw new Error(`${relativePath} version is ${document.version ?? 'missing'}; expected ${version}`)
    }
    if (relativePath.endsWith('package-lock.json') && document.packages?.['']?.version !== version) {
      throw new Error(
        `${relativePath} root package version is ${document.packages?.['']?.version ?? 'missing'}; expected ${version}`,
      )
    }
  }

  const flashManifestDirectory = path.join(rootDirectory, 'web', 'flash')
  const flashManifestNames = readdirSync(flashManifestDirectory).filter((name) =>
    /^manifest_esp32_.*\.json$/.test(name),
  )
  if (flashManifestNames.length === 0) {
    throw new Error('web flash manifests are missing')
  }
  for (const name of flashManifestNames) {
    const relativePath = path.join('web', 'flash', name)
    const document = JSON.parse(readFileSync(path.join(rootDirectory, relativePath), 'utf8'))
    if (document.version !== version) {
      throw new Error(`${relativePath} version is ${document.version ?? 'missing'}; expected ${version}`)
    }
  }

  const notes = releaseNotesForTag(rootDirectory, tag)

  const changesetDirectory = path.join(rootDirectory, '.changeset')
  const pendingChangesets = readdirSync(changesetDirectory).filter(
    (name) => name.endsWith('.md') && name !== 'README.md',
  )
  if (pendingChangesets.length > 0) {
    throw new Error(`pending Changesets must be consumed before release: ${pendingChangesets.join(', ')}`)
  }

  return notes
}
