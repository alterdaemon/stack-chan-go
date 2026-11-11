#!/usr/bin/env node

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateRelease } from './lib/release-validation.mjs'

const [tag, option, ...extra] = process.argv.slice(2)
const firmwareDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rootDirectory = path.resolve(firmwareDirectory, '..')

try {
  if (extra.length || (option && option !== '--notes')) throw new Error('usage: validate-release.mjs <tag> [--notes]')
  const result = validateRelease(rootDirectory, tag ?? '')
  if (option === '--notes') process.stdout.write(`${result.releaseNotes}\n`)
  else console.log(`[stack-chan] release metadata is valid: v${result.version}`)
} catch (error) {
  console.error(`[stack-chan] release metadata is invalid: ${error.message}`)
  process.exit(1)
}
