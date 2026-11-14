import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('USB status and snapshots report the running build configuration across revisions', () => {
  execFileSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-'], {
    timeout: 10000,
    input: `
      import assert from 'node:assert/strict'
      import { readFileSync } from 'node:fs'
      import { createContext, runInContext, SourceTextModule, SyntheticModule } from 'node:vm'
      import { DebugRecorder } from ${JSON.stringify(new URL('./core.js', import.meta.url).href)}

      const source = readFileSync(${JSON.stringify(fileURLToPath(new URL('./service.js', import.meta.url)))}, 'utf8')
      for (const firmwareVersion of ['2.1.0-R5', '3.7.2-R19']) {
        let serial, recorder, sequence = 0, stopped = 0, polling = 0
        const records = []
        const native = {
          xs_device_debug_now: () => 0,
          xs_device_debug_available: () => true,
          xs_device_debug_stamp: () => ({ ms: 0, seq: ++sequence }),
          xs_device_debug_enable() {},
          xs_device_debug_read() {},
          xs_device_debug_info: () => ({ app_sha256: 'a'.repeat(64), sdk: 'v6.1' }),
          xs_device_debug_tune() {},
        }
        class USBSerial {
          connected = true
          constructor(options) { this.options = options; serial = this }
          read(buffer) {
            if (!this.pending) return 0
            buffer.set(this.pending)
            const length = this.pending.length
            this.pending = undefined
            return length
          }
          write(bytes) { records.push(JSON.parse(new TextDecoder().decode(bytes).slice(6))) }
          send(command) { this.pending = new TextEncoder().encode(command + '\\n'); this.options.onReadable() }
        }
        const context = createContext({
          native: (name) => { assert.ok(name in native); return native[name] },
          TextEncoder,
        })
        runInContext('ArrayBuffer.fromString = (value) => new TextEncoder().encode(value).buffer', context)
        const imports = {
          'mc/config': { default: { firmwareVersion } },
          'device-debug/core': { DebugRecorder },
          'device-debug': { default: {
            install(value) { recorder = value },
            snapshot: () => ({ application: 'test' }),
            sampleLive() {},
            tuningSnapshot: () => ({}),
            resetTuning: async () => {},
            stopControlledLive: async () => { stopped++ },
          } },
          'stackchan-usb-serial': { default: USBSerial },
          'stackchan-usb-serial-types': { isUSBSerialOutputFullError: () => false },
          timer: { default: { repeat: () => { polling++; return 1 }, clear() { polling-- } } },
        }
        const service = new SourceTextModule(source, { context })
        await service.link((name) => new SyntheticModule(Object.keys(imports[name]), function () {
          for (const [key, value] of Object.entries(imports[name])) this.setExport(key, value)
        }, { context }))
        await service.evaluate()
        service.namespace.default()
        assert.equal(polling, 0, 'Off starts no diagnostic poll timer')
        serial.send('diag status')
        assert.equal(recorder.enabled, false)
        serial.send('diag on')
        assert.equal(polling, 1)
        serial.send('diag off')
        assert.equal(polling, 0, 'Off removes the diagnostic poll timer')
        assert.equal(recorder.enabled, false)
        assert.equal(stopped, 1, 'ending diagnostics stops the USB-owned LIVE session')
        for (const action of ['status', 'on', 'off']) {
          assert.equal(records.find((record) => record.action === action)?.firmware, firmwareVersion)
        }
        const snapshot = records.find((record) => record.event === 'snapshot')
        assert.equal(snapshot?.firmware, firmwareVersion)
        assert.equal(snapshot?.app_sha256, 'a'.repeat(64))
      }
    `,
  })
})
