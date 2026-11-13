import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const libraryDirectory = dirname(fileURLToPath(import.meta.url))

export const hostApplicationName = 'stack-chan-host'
export const firmwareDirectory = resolve(libraryDirectory, '../..')
export const buildOutputDirectory = join(firmwareDirectory, 'dist')

/**
 * Creates the repository-local Moddable output root if it does not exist.
 * mcconfig requires the directory passed to -o to exist before it starts.
 * @returns {string} Absolute output directory path.
 */
export function ensureBuildOutputDirectory() {
  mkdirSync(buildOutputDirectory, { recursive: true })
  return buildOutputDirectory
}

/**
 * Removes all generated Stack-chan build artifacts and leaves an empty output
 * root ready for mcconfig.
 * @returns {string} Absolute output directory path.
 */
export function cleanBuildOutputDirectory() {
  rmSync(buildOutputDirectory, { recursive: true, force: true })
  return ensureBuildOutputDirectory()
}

/**
 * Rejects a caller-supplied output directory so repository commands cannot
 * silently write outside firmware/dist.
 * @param {string[]} args - Arguments forwarded to a Moddable build tool.
 */
export function assertNoCustomBuildOutput(args) {
  if (args.some((arg) => arg === '-o' || arg.startsWith('-o='))) {
    throw new Error(`-o is managed by Stack-chan build commands and fixed to ${buildOutputDirectory}`)
  }
}

/**
 * Returns the output selector shared by mcconfig, mcrun, and mcpack.
 * @returns {string[]}
 */
export function moddableOutputArguments() {
  return ['-o', buildOutputDirectory]
}

/** Prevent an ignored IDF failure from reusing a previous CoreS3 linked image. */
export function invalidateCoreS3Image({ platformName, mode, outputDirectory = buildOutputDirectory }) {
  if (!['m5stack_cores3', 'm5stackchan_cores3'].includes(platformName)) throw new Error('Unsupported CoreS3 platform')
  if (!['debug', 'instrument', 'release'].includes(mode)) throw new Error('Unsupported build mode')
  const target = join('esp32', platformName, mode, hostApplicationName)
  const build = join(outputDirectory, 'tmp', target, 'xsProj-esp32s3', 'build')
  const bin = join(outputDirectory, 'bin', target)
  // Moddable's build target ignores idf.py failure but its ELF objdump is fatal.
  // Removing the old ELF makes that check fail; no stale BIN may survive either.
  for (const directory of [build, bin])
    for (const suffix of ['elf', 'bin']) rmSync(join(directory, `xs_esp32.${suffix}`), { force: true })
}
