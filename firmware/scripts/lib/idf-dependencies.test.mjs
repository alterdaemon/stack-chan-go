import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { prepareCoreS3IdfDependencies } from './idf-dependencies.mjs'

test('prepares both managed components without duplicating them', () => {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), 'stackchan-idf-dependencies-'))
  const audioManifest = JSON.parse(readFileSync(new URL('../../host/modules/audio/manifest.json', import.meta.url)))
  const audioCodec = audioManifest.platforms['esp32/m5stackchan_cores3'].dependency.find(
    ({ name }) => name === 'esp_audio_codec',
  )

  try {
    const manifestPath = prepareCoreS3IdfDependencies({
      outputDirectory,
      platformName: 'm5stackchan_cores3',
      applicationName: 'stack-chan-host',
      mode: 'debug',
    })
    const first = readFileSync(manifestPath, 'utf8')
    prepareCoreS3IdfDependencies({
      outputDirectory,
      platformName: 'm5stackchan_cores3',
      applicationName: 'stack-chan-host',
      mode: 'debug',
    })
    const second = readFileSync(manifestPath, 'utf8')

    assert.equal(second, first)
    assert.equal(count(second, 'espressif/esp_audio_codec:'), 1)
    assert.ok(second.includes(`espressif/esp_audio_codec: ${audioCodec.version}`))
    assert.equal(count(second, 'espressif/esp32-camera:'), 1)
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true })
  }
})

test('prepares the built-in CoreS3 camera dependency', () => {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), 'stackchan-idf-dependencies-'))

  try {
    const manifestPath = prepareCoreS3IdfDependencies({
      outputDirectory,
      platformName: 'm5stack_cores3',
      applicationName: 'stack-chan-host',
      mode: 'release',
    })
    const manifest = readFileSync(manifestPath, 'utf8')

    assert.equal(count(manifest, 'espressif/esp32-camera:'), 1)
    assert.equal(count(manifest, 'espressif/esp_audio_codec:'), 0)
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true })
  }
})

test('uses the generated directory for each ESP32 build mode', () => {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), 'stackchan-idf-dependencies-'))

  try {
    for (const mode of ['debug', 'instrument', 'release']) {
      const manifestPath = prepareCoreS3IdfDependencies({
        outputDirectory,
        platformName: 'm5stackchan_cores3',
        applicationName: 'stack-chan-host',
        mode,
      })
      assert.equal(
        manifestPath,
        path.join(
          outputDirectory,
          'tmp',
          'esp32',
          'm5stackchan_cores3',
          mode,
          'stack-chan-host',
          'xsProj-esp32s3',
          'main',
          'idf_component.yml',
        ),
      )
    }
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true })
  }
})

test('prepares RT camera dependencies in its own directory for all build modes', () => {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), 'stackchan-rt-idf-dependencies-'))
  const cameraManifest = JSON.parse(
    readFileSync(new URL('../../host/modules/camera/manifest_device.json', import.meta.url)),
  )
  try {
    for (const mode of ['debug', 'instrument', 'release']) {
      const options = {
        outputDirectory,
        platformName: 'stackchan_rt',
        applicationName: 'stack-chan-host',
        mode,
      }
      const manifestPath = prepareCoreS3IdfDependencies(options)
      assert.equal(
        manifestPath,
        path.join(
          outputDirectory,
          'tmp/esp32/stackchan_rt',
          mode,
          'stack-chan-host/xsProj-esp32s3/main/idf_component.yml',
        ),
      )
      const first = readFileSync(manifestPath, 'utf8')
      for (const { name, version } of cameraManifest.dependencies) {
        assert.ok(first.includes(`espressif/${name}: ${version}`))
        assert.equal(count(first, `espressif/${name}:`), 1)
      }
      prepareCoreS3IdfDependencies(options)
      assert.equal(readFileSync(manifestPath, 'utf8'), first)
      assert.equal(count(first, 'espressif/esp_audio_codec:'), 0)
    }
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true })
  }
})

/**
 * Counts non-overlapping occurrences in a string.
 * @param {string} source - Text to search.
 * @param {string} value - Value to count.
 * @returns {number} Number of occurrences.
 */
function count(source, value) {
  return source.split(value).length - 1
}

test('discovers local WebRTC components without editing their sources and isolates measurement builds', async () => {
  const { mkdirSync, writeFileSync, realpathSync } = await import('node:fs')
  const outputDirectory = mkdtempSync(path.join(tmpdir(), 'stackchan-realtime-deps-'))
  const solutionDirectory = path.join(outputDirectory, 'solution')
  const moddableDirectory = path.join(outputDirectory, 'sdk')
  const sdkMain = path.join(moddableDirectory, 'build/devices/esp32/lib/main')
  mkdirSync(sdkMain, { recursive: true })
  writeFileSync(
    path.join(sdkMain, 'main.c'),
    'void app_main() {\n xTaskCreate(loop_task, "main", 4096, NULL, 4, NULL);\n}\n',
  )
  const names = ['esp_webrtc', 'esp_peer', 'media_lib_utils', 'webrtc_utils', 'av_render']
  for (const name of names) {
    const component = path.join(solutionDirectory, 'components', name)
    mkdirSync(component, { recursive: true })
    writeFileSync(path.join(component, 'CMakeLists.txt'), 'idf_component_register()\n')
    if (name === 'av_render') {
      mkdirSync(path.join(component, 'src'))
      writeFileSync(
        path.join(component, 'src/av_render.c'),
        '/* SDK license */\n    _WAIT_BITS(render->event_group, wait_bits);\n    // Resend first frame pts\n',
      )
    }
    if (name === 'esp_webrtc') {
      mkdirSync(path.join(component, 'src'))
      writeFileSync(
        path.join(component, 'src/esp_webrtc.c'),
        '/* SDK license */\nint f() { return esp_peer_open(&peer_cfg, esp_peer_get_default_impl(), &rtc->pc); }\n',
      )
    }
    if (name === 'esp_peer') {
      mkdirSync(path.join(component, 'src/transport'), { recursive: true })
      writeFileSync(
        path.join(component, 'src/transport/udp.c'),
        `#define TAG "UDP"
void f() { measure_stop("sendto");
ret = recvfrom(target_fd, buf, len, 0, (struct sockaddr *)&addr_storage, &addr_len);
if (max_fd < 0) {
        return -1;
}
int ret = select(max_fd + 1, &read_set, NULL, NULL, tv); }
`,
      )
      writeFileSync(
        path.join(component, 'src/transport/tcp.c'),
        `#define TAG "TCP"
int fd = socket(addr->family == AF_INET6 ? AF_INET6 : AF_INET, SOCK_STREAM, 0);
int ret = connect(fd, (struct sockaddr *)&storage, addr_len);
int ret = select(conn->fd + 1, NULL, &write_set, NULL, &tv);
ESP_LOGW(TAG, "Async TCP connect failed: %s", strerror(err ? err : errno));
conn->connecting = false;
            conn->connected = true;
int sret = tcp_connection_send(conn, item->data, item->len, tcp->cfg.send_timeout_ms);
ret = recv(conn->fd, data + received, len - received, 0);
int ret = select(max_fd + 1, &read_set, NULL, NULL, &tv);
int ret = select(max_fd + 1, &read_set, NULL, NULL, &tv);
`,
      )
      writeFileSync(
        path.join(component, 'src/dtls_srtp_v6.c'),
        'void utils_get_hmac_sha1(const char *input, size_t input_len, const char *key, size_t key_len, unsigned char *output)\n{\n}\n',
      )
    }
  }
  const options = {
    outputDirectory,
    solutionDirectory,
    moddableDirectory,
    platformName: 'm5stackchan_cores3',
    applicationName: 'stack-chan-host',
    mode: 'release',
    realtime: true,
  }
  try {
    const manifestPath = prepareCoreS3IdfDependencies(options)
    const components = path.resolve(path.dirname(manifestPath), '../components')
    for (const name of names) {
      if (!['esp_webrtc', 'esp_peer', 'av_render'].includes(name))
        assert.equal(
          realpathSync(path.join(components, name)),
          realpathSync(path.join(solutionDirectory, 'components', name)),
        )
      assert.equal(readFileSync(path.join(components, name, 'CMakeLists.txt'), 'utf8'), 'idf_component_register()\n')
    }
    const first = readFileSync(manifestPath, 'utf8')
    const patched = [
      'av_render/src/av_render.c',
      'esp_webrtc/src/esp_webrtc.c',
      'esp_peer/src/transport/udp.c',
      'esp_peer/src/transport/tcp.c',
      'esp_peer/src/dtls_srtp_v6.c',
    ]
    for (const file of patched) utimesSync(path.join(components, file), 1000000000, 1000000000)
    prepareCoreS3IdfDependencies(options)
    for (const file of patched)
      assert.equal(
        statSync(path.join(components, file)).mtimeMs,
        1000000000000,
        'unchanged generated source must not force native recompilation',
      )
    assert.equal(readFileSync(manifestPath, 'utf8'), first)
    const relative = 'src/esp_webrtc.c'
    const original = readFileSync(path.join(solutionDirectory, 'components/esp_webrtc', relative), 'utf8')
    const generated = readFileSync(path.join(components, 'esp_webrtc', relative), 'utf8')
    assert.equal(
      generated,
      original.replace('esp_peer_get_default_impl()', 'rtc->rtc_cfg.peer_impl'),
      'only the generated call uses the supplied implementation and retains the SDK license',
    )
    assert.ok(original.includes('esp_peer_get_default_impl()'), 'external SDK remains unchanged')
    const renderOriginal = readFileSync(path.join(solutionDirectory, 'components/av_render/src/av_render.c'), 'utf8')
    assert.equal(
      readFileSync(path.join(components, 'av_render/src/av_render.c'), 'utf8'),
      renderOriginal.replace('    _WAIT_BITS', '    if (wait_bits) _WAIT_BITS'),
      'only the generated empty-renderer wait is guarded; SDK source and license remain unchanged',
    )
    const udp = readFileSync(path.join(components, 'esp_peer/src/transport/udp.c'), 'utf8')
    assert.ok(udp.includes('stackchanObserveUdp(1, buf, len, ret);'))
    assert.ok(udp.includes('stackchanObserveUdp(0, buf, ret, ret);'))
    assert.ok(udp.includes('stackchanObserveUdp(2, NULL, max_fd, ret);'))
    assert.ok(udp.includes('errno = saved_errno;'))
    assert.ok(
      !readFileSync(path.join(solutionDirectory, 'components/esp_peer/src/transport/udp.c'), 'utf8').includes(
        'stackchanObserveUdp',
      ),
    )
    const tcp = readFileSync(path.join(components, 'esp_peer/src/transport/tcp.c'), 'utf8')
    assert.ok(tcp.includes('stackchanObserveTcp(1, addr->port, ret < 0 ? -errno : 0);'))
    assert.ok(tcp.includes('stackchanObserveTcp(2, conn->addr.port, 0);'))
    assert.ok(tcp.includes('stackchanObserveTcp(3, item->len, sret < 0 ? -errno : sret);'))
    assert.ok(tcp.includes('stackchanObserveTcp(4, len - received, ret < 0 ? -errno : ret);'))
    assert.ok(tcp.includes('stackchanObserveTcp(5, conn->addr.port, ret < 0 ? -errno : ret);'))
    assert.ok(tcp.includes('errno = saved_errno;'))
    assert.equal(count(tcp, 'stackchanObserveTcp(6, max_fd, ret < 0 ? -errno : ret);'), 2)
    const crypto = readFileSync(path.join(components, 'esp_peer/src/dtls_srtp_v6.c'), 'utf8')
    assert.ok(crypto.includes('stackchanLiveDebugHmac(input, input_len, key, key_len);'))
    assert.ok(crypto.includes('errno = saved_errno;'))
    assert.ok(
      !readFileSync(path.join(solutionDirectory, 'components/esp_peer/src/transport/tcp.c'), 'utf8').includes(
        'stackchanObserveTcp',
      ),
    )
    writeFileSync(path.join(solutionDirectory, 'components/esp_webrtc', relative), 'unsupported SDK source\n')
    assert.throws(() => prepareCoreS3IdfDependencies(options), /Unsupported WebRTC peer entry point/)
    assert.equal(readFileSync(path.join(components, 'esp_webrtc', relative), 'utf8'), generated)
    writeFileSync(path.join(solutionDirectory, 'components/esp_webrtc', relative), original)
    const { unlinkSync } = await import('node:fs')
    unlinkSync(path.join(components, 'esp_webrtc/.stackchan-peer-implementation'))
    assert.throws(() => prepareCoreS3IdfDependencies(options), /Refusing to replace component directory/)
    assert.equal(count(first, 'espressif/esp_capture:'), 1)
    assert.equal(count(first, 'espressif/esp_sysview:'), 0)
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true })
  }
})

test('rejects missing WebRTC sources before invoking the SDK', () => {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), 'stackchan-realtime-missing-'))
  try {
    assert.throws(
      () =>
        prepareCoreS3IdfDependencies({
          outputDirectory,
          platformName: 'm5stackchan_cores3',
          applicationName: 'stack-chan-host',
          mode: 'release',
          realtime: true,
          solutionDirectory: path.join(outputDirectory, 'missing'),
        }),
      /Missing WebRTC component/,
    )
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true })
  }
})
