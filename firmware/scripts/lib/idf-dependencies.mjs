import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { prepareModdableMain } from './moddable-main.mjs'
import { webRtcComponents } from './webrtc-solution.mjs'

const dependenciesByPlatform = {
  m5stack_cores3: [['espressif/esp32-camera', '^2.0.10']],
  stackchan_rt: [
    ['espressif/esp32-camera', '^2.0.10'],
    ['espressif/esp_jpeg', '^1.3.1'],
  ],
  m5stackchan_cores3: [
    ['espressif/esp_audio_codec', '~2.5.0'],
    ['espressif/esp32-camera', '^2.0.10'],
  ],
}

/**
 * Seeds a generated CoreS3 IDF manifest before Moddable adds dependencies.
 * @param {{outputDirectory: string, platformName: string, applicationName: string, mode: string}} options - Build output configuration.
 * @returns {string} Path to the prepared IDF component manifest.
 */
export function prepareCoreS3IdfDependencies({
  outputDirectory,
  platformName,
  applicationName,
  mode,
  realtime = false,
  solutionDirectory,
  moddableDirectory = process.env.MODDABLE,
}) {
  if (!outputDirectory) throw new Error('Build output directory is required')
  const dependencies = dependenciesByPlatform[platformName]
  if (!dependencies) throw new Error(`Unsupported CoreS3 platform: ${platformName}`)
  if (!applicationName) throw new Error('Application name is required')
  if (!['debug', 'instrument', 'release'].includes(mode)) throw new Error(`Unsupported build mode: ${mode}`)

  const mainDirectory = path.join(
    outputDirectory,
    'tmp',
    'esp32',
    platformName,
    mode,
    applicationName,
    'xsProj-esp32s3',
    'main',
  )
  const manifestPath = path.join(mainDirectory, 'idf_component.yml')
  mkdirSync(mainDirectory, { recursive: true })

  const originalManifest = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null
  let manifest =
    originalManifest ?? "## IDF Component Manager Manifest File\ndependencies:\n  idf:\n    version: '>=4.1.0'\n"

  if (!/^dependencies:\s*$/m.test(manifest)) {
    throw new Error(`IDF component manifest has no dependencies block: ${manifestPath}`)
  }

  for (const [name, version] of dependencies) {
    if (manifest.includes(`  ${name}:`)) continue
    if (!manifest.endsWith('\n')) manifest += '\n'
    manifest += `  ${name}: ${version}\n`
  }

  if (realtime) {
    if (!['m5stack_cores3', 'm5stackchan_cores3'].includes(platformName) || !solutionDirectory)
      throw new Error('RealtimeConversation requires CoreS3 and ESP_WEBRTC_SOLUTION')
    const componentDirectory = path.join(mainDirectory, '..', 'components')
    mkdirSync(componentDirectory, { recursive: true })
    for (const name of webRtcComponents) {
      const source = path.resolve(solutionDirectory, 'components', name)
      if (!existsSync(path.join(source, 'CMakeLists.txt'))) throw new Error(`Missing WebRTC component: ${name}`)
      const destination = path.join(componentDirectory, name)
      if (name === 'esp_webrtc') preparePeerImplementation(source, destination)
      else linkComponent(source, destination)
    }
    // Use ESP-IDF's project component discovery; never patch the SDK CMake project.
    const conversation = JSON.parse(
      readFileSync(new URL('../../host/modules/realtime-conversation/esp32/manifest.json', import.meta.url)),
    )
    for (const { name, version } of conversation.dependencies) {
      if (name && !manifest.includes(`  espressif/${name}:`)) manifest += `  espressif/${name}: '${version}'\n`
    }
  }

  // Moddable 10.0.1 joins `idf.py add-dependency` commands with `&` on
  // POSIX. RT needs both entries seeded before make, including after a target
  // clean, to avoid concurrent manifest writes and reconfigure reading too early.
  if (manifest !== originalManifest) writeFileSync(manifestPath, manifest)
  prepareModdableMain({ moddableDirectory, mainDirectory, realtime })
  console.log(`[stack-chan] prepared IDF dependencies: ${manifestPath}`)
  return manifestPath
}

// esp_webrtc validates peer_impl but the pinned SDK ignores it when opening the
// peer. Honor the supplied implementation in generated output only, preserving
// the SDK and its licenses. This enables the existing bounded state observer.
function preparePeerImplementation(source, destination) {
  const relative = 'src/esp_webrtc.c'
  const original = readFileSync(path.join(source, relative), 'utf8')
  const before = 'esp_peer_open(&peer_cfg, esp_peer_get_default_impl(), &rtc->pc)'
  const after = 'esp_peer_open(&peer_cfg, rtc->rtc_cfg.peer_impl, &rtc->pc)'
  if (original.split(after).length === 2 && !original.includes(before)) {
    linkComponent(source, destination)
    return
  }
  if (original.split(before).length !== 2 || original.includes(after))
    throw new Error(`Unsupported WebRTC peer entry point: ${source}`)
  const marker = '.stackchan-peer-implementation'
  const current = lstatSync(destination, { throwIfNoEntry: false })
  if (current?.isSymbolicLink()) unlinkSync(destination)
  else if (
    current &&
    (!existsSync(path.join(destination, marker)) ||
      readFileSync(path.join(destination, marker), 'utf8') !== `${source}\n`)
  )
    throw new Error(`Refusing to replace component directory: ${destination}`)
  cpSync(source, destination, { recursive: true, preserveTimestamps: true })
  writeFileSync(path.join(destination, relative), original.replace(before, after))
  writeFileSync(path.join(destination, marker), `${source}\n`)
}

function linkComponent(source, destination) {
  const current = lstatSync(destination, { throwIfNoEntry: false })
  if (current) {
    if (!current.isSymbolicLink()) throw new Error(`Refusing to replace component directory: ${destination}`)
    if (existsSync(destination) && realpathSync(destination) === realpathSync(source)) return
    unlinkSync(destination)
  }
  symlinkSync(source, destination, 'dir')
}
