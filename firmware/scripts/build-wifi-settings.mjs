#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = fileURLToPath(new URL('../..', import.meta.url))
const web = join(root, 'web')
const output = join(root, 'firmware/dist/wifi-settings')
const build = join(output, 'build')
const resources = join(output, 'resources')
const result = spawnSync('npm', ['run', 'build:device-settings'], { cwd: web, stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
cpSync(join(web, 'public/theme-init.js'), join(build, 'theme-init.js'))
rmSync(resources, { recursive: true, force: true })
mkdirSync(resources, { recursive: true })

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
}
const index = {}
let bytes = 0
function pack(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name)
    const url = `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      pack(path, url)
      continue
    }
    const resource = `wifi-settings-${Object.keys(index).length}.gz`
    const data = gzipSync(readFileSync(path), { level: 9 })
    bytes += data.length
    writeFileSync(join(resources, resource), data)
    index[url === '/preference/index.html' ? '/settings/' : url] = {
      resource,
      type: types[extname(path)] ?? 'application/octet-stream',
    }
  }
}
pack(build)
// /preference/ is also useful when opening the same entry through the shared navigation.
index['/preference/'] = index['/settings/']
writeFileSync(join(resources, 'wifi-settings-index.dat'), JSON.stringify(index))
console.log(`[settings] Embedded ${Object.keys(index).length} routes, ${bytes} compressed bytes`)
