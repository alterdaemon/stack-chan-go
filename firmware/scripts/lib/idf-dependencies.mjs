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
    linkComponent(
      new URL('../../host/modules/debug-log/panic', import.meta.url).pathname,
      path.join(componentDirectory, 'stackchan_debug_panic'),
    )
    for (const name of webRtcComponents) {
      const source = path.resolve(solutionDirectory, 'components', name)
      if (!existsSync(path.join(source, 'CMakeLists.txt'))) throw new Error(`Missing WebRTC component: ${name}`)
      const destination = path.join(componentDirectory, name)
      if (name === 'esp_webrtc' || name === 'esp_peer') preparePeerImplementation(source, destination, name)
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

// Honor the peer implementation and observe socket results in generated output
// only. Preserve installed SDK sources/licenses and reject unsupported shapes.
function preparePeerImplementation(source, destination, name) {
  const relative = name === 'esp_webrtc' ? 'src/esp_webrtc.c' : 'src/transport/udp.c'
  const original = readFileSync(path.join(source, relative), 'utf8')
  const before = 'esp_peer_open(&peer_cfg, esp_peer_get_default_impl(), &rtc->pc)'
  const after = 'esp_peer_open(&peer_cfg, rtc->rtc_cfg.peer_impl, &rtc->pc)'
  if (name === 'esp_webrtc' && original.split(after).length === 2 && !original.includes(before)) {
    linkComponent(source, destination)
    return
  }
  const receive = 'ret = recvfrom(target_fd, buf, len, 0, (struct sockaddr *)&addr_storage, &addr_len);'
  const patches =
    name === 'esp_webrtc'
      ? [[before, after]]
      : [
          [
            '#define TAG "UDP"',
            `extern void stackchanLiveDebugIce(unsigned, const uint8_t *, int, int, int) __attribute__((weak));
static void stackchanObserveUdp(unsigned outgoing, const uint8_t *buf, int len, int result)
{
    int saved_errno = errno;
    if (stackchanLiveDebugIce) stackchanLiveDebugIce(outgoing, buf, len, result, result < 0 ? saved_errno : 0);
    errno = saved_errno;
}
#define TAG "UDP"`,
          ],
          ['measure_stop("sendto");', 'measure_stop("sendto");\n    stackchanObserveUdp(1, buf, len, ret);'],
          [receive, `${receive}\n        stackchanObserveUdp(0, buf, ret, ret);`],
          [
            'int ret = select(max_fd + 1, &read_set, NULL, NULL, tv);',
            'int ret = select(max_fd + 1, &read_set, NULL, NULL, tv);\n    stackchanObserveUdp(2, NULL, max_fd, ret);',
          ],
          [
            'if (max_fd < 0) {\n        return -1;',
            'if (max_fd < 0) {\n        stackchanObserveUdp(2, NULL, max_fd, -1);\n        return -1;',
          ],
        ]
  const updates = [[relative, patchPeerSource(original, patches, source)]]
  if (name === 'esp_peer') {
    const tcp = 'src/transport/tcp.c'
    const originalTcp = readFileSync(path.join(source, tcp), 'utf8')
    const tcpPatches = [
      [
        '#define TAG "TCP"',
        `extern void stackchanLiveDebugTcp(unsigned, int, int) __attribute__((weak));
static void stackchanObserveTcp(unsigned stage, int value, int result)
{
    int saved_errno = errno;
    if (stackchanLiveDebugTcp) stackchanLiveDebugTcp(stage, value, result);
    errno = saved_errno;
}
#define TAG "TCP"`,
      ],
      [
        'int fd = socket(addr->family == AF_INET6 ? AF_INET6 : AF_INET, SOCK_STREAM, 0);',
        'int fd = socket(addr->family == AF_INET6 ? AF_INET6 : AF_INET, SOCK_STREAM, 0);\n    stackchanObserveTcp(0, addr->port, fd < 0 ? -errno : 0);',
      ],
      [
        'int ret = connect(fd, (struct sockaddr *)&storage, addr_len);',
        'int ret = connect(fd, (struct sockaddr *)&storage, addr_len);\n    stackchanObserveTcp(1, addr->port, ret < 0 ? -errno : 0);',
      ],
      [
        'int ret = select(conn->fd + 1, NULL, &write_set, NULL, &tv);',
        'int ret = select(conn->fd + 1, NULL, &write_set, NULL, &tv);\n        stackchanObserveTcp(5, conn->addr.port, ret < 0 ? -errno : ret);',
      ],
      [
        'ESP_LOGW(TAG, "Async TCP connect failed: %s", strerror(err ? err : errno));',
        'stackchanObserveTcp(2, conn->addr.port, -(err ? err : errno));\n            ESP_LOGW(TAG, "Async TCP connect failed: %s", strerror(err ? err : errno));',
      ],
      [
        'conn->connecting = false;\n            conn->connected = true;',
        'conn->connecting = false;\n            conn->connected = true;\n            stackchanObserveTcp(2, conn->addr.port, 0);',
      ],
      [
        'int sret = tcp_connection_send(conn, item->data, item->len, tcp->cfg.send_timeout_ms);',
        'int sret = tcp_connection_send(conn, item->data, item->len, tcp->cfg.send_timeout_ms);\n        stackchanObserveTcp(3, item->len, sret < 0 ? -errno : sret);',
      ],
      [
        'ret = recv(conn->fd, data + received, len - received, 0);',
        'ret = recv(conn->fd, data + received, len - received, 0);\n        stackchanObserveTcp(4, len - received, ret < 0 ? -errno : ret);',
      ],
      [
        'int ret = select(max_fd + 1, &read_set, NULL, NULL, &tv);',
        'int ret = select(max_fd + 1, &read_set, NULL, NULL, &tv);\n    stackchanObserveTcp(6, max_fd, ret < 0 ? -errno : ret);',
        2,
      ],
    ]
    updates.push([tcp, patchPeerSource(originalTcp, tcpPatches, source)])
    const crypto = 'src/dtls_srtp_v6.c'
    const signature =
      'void utils_get_hmac_sha1(const char *input, size_t input_len, const char *key, size_t key_len, unsigned char *output)\n{'
    updates.push([
      crypto,
      patchPeerSource(
        readFileSync(path.join(source, crypto), 'utf8'),
        [
          [
            signature,
            `#include <errno.h>
extern void stackchanLiveDebugHmac(const char *, size_t, const char *, size_t) __attribute__((weak));
${signature}
    int saved_errno = errno;
    if (stackchanLiveDebugHmac) stackchanLiveDebugHmac(input, input_len, key, key_len);
    errno = saved_errno;`,
          ],
        ],
        source,
      ),
    ])
  }
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
  for (const [file, generated] of updates) writeFileSync(path.join(destination, file), generated)
  writeFileSync(path.join(destination, marker), `${source}\n`)
}

function patchPeerSource(original, patches, source) {
  let generated = original
  for (const [from, to, occurrences = 1] of patches) {
    if (generated.split(from).length !== occurrences + 1 || generated.includes(to))
      throw new Error(`Unsupported WebRTC peer entry point: ${source}`)
    generated = generated.replaceAll(from, to)
  }
  return generated
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
