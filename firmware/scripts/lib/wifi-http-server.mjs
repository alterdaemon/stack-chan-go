import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildOutputDirectory } from './build-output.mjs'

/**
 * Keep the SDK HTTP server, with its header-buffer growth fix in a generated copy.
 * The installed SDK is untouched. The XS browser-header regression exercises this copy.
 */
export function prepareWiFiHTTPServer(moddableDirectory = process.env.MODDABLE) {
  if (!moddableDirectory) throw new Error('MODDABLE is required to prepare the Wi-Fi HTTP server')
  const source = readFileSync(join(moddableDirectory, 'modules/io/http/server/httpserver.js'), 'utf8')
  const original = 'if (position === length)\n\t\t\t\t\t\tlineBuffer.buffer.resize(length << 1);'
  const fixed = [
    'if (position === length) {',
    '\t\t\t\t\t\tif (length === lineBuffer.buffer.maxByteLength) {',
    '\t\t\t\t\t\t\tthis.#onError("HTTP header line too long");',
    '\t\t\t\t\t\t\treturn;',
    '\t\t\t\t\t\t}',
    '\t\t\t\t\t\tlineBuffer.buffer.resize(length <<= 1);',
    '\t\t\t\t\t}',
  ].join('\n')
  if (source.split(original).length !== 2)
    throw new Error('SDK HTTP parser changed; review the header-buffer compatibility fix')
  const destination = join(buildOutputDirectory, 'wifi-settings/httpserver.js')
  const patched = source.replace(original, fixed)
  mkdirSync(dirname(destination), { recursive: true })
  let previous
  try {
    previous = readFileSync(destination, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (previous !== patched) writeFileSync(destination, patched)
  return destination
}
