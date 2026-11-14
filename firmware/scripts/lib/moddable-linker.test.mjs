import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { prepareHostLinker } from './moddable-linker.mjs'

function fixture(body) {
  const root = mkdtempSync(path.join(tmpdir(), 'stackchan-host-linker-'))
  try {
    const sdk = path.join(root, 'sdk')
    for (const directory of ['tools', 'sources', 'includes', 'platforms', 'makefiles/lin'])
      mkdirSync(path.join(sdk, 'xs', directory), { recursive: true })
    const source = '2048 * 4,\t/* initialKeyCount */\n32, /* target fixture remains separate */\n'
    writeFileSync(path.join(sdk, 'xs/tools/xsl.c'), source)
    writeFileSync(path.join(sdk, 'xs/tools/xsl.h'), 'fixture header')
    writeFileSync(path.join(sdk, 'xs/makefiles/lin/xsl.mk'), 'fixture Makefile')
    let builds = 0
    const options = {
      moddableDirectory: sdk,
      outputDirectory: path.join(root, 'dist'),
      platform: 'linux',
      run(command, args) {
        builds++
        assert.equal(command, 'make')
        const tools = args.find((arg) => arg.startsWith('TLS_DIR=')).slice(8)
        assert.equal(readFileSync(path.join(tools, 'xsl.c'), 'utf8'), source.replace('2048 * 4', '2048 * 8'))
        const build = args.find((arg) => arg.startsWith('BUILD_DIR=')).slice(10)
        const bin = path.join(build, 'bin/lin/release')
        mkdirSync(bin, { recursive: true })
        writeFileSync(path.join(bin, 'xsl'), 'fixture executable')
        return { status: 0 }
      },
    }
    body({ root, sdk, source, options, builds: () => builds })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('host linker capacity preserves the SDK and reuses only a matching verified tool', () =>
  fixture((f) => {
    const directory = prepareHostLinker(f.options)
    assert.equal(f.builds(), 1)
    assert.equal(readFileSync(path.join(f.sdk, 'xs/tools/xsl.c'), 'utf8'), f.source)
    assert.equal(prepareHostLinker(f.options), directory)
    assert.equal(f.builds(), 1)
    writeFileSync(path.join(directory, 'xsl'), 'corrupt fixture')
    prepareHostLinker(f.options)
    assert.equal(f.builds(), 2)
    writeFileSync(path.resolve(directory, '../../../../receipt.json'), '{')
    prepareHostLinker(f.options)
    assert.equal(f.builds(), 3)
    writeFileSync(path.join(f.sdk, 'xs/includes/fixture.h'), 'changed SDK input')
    assert.notEqual(prepareHostLinker(f.options), directory)
    assert.equal(f.builds(), 4)
  }))

test('adequate upstream linker capacity is reused; unknown layouts and failed builds fail explicitly', () =>
  fixture((f) => {
    const source = path.join(f.sdk, 'xs/tools/xsl.c')
    writeFileSync(source, '16384, /* initialKeyCount */\n')
    assert.equal(prepareHostLinker(f.options), undefined)
    assert.equal(f.builds(), 0)
    writeFileSync(source, 'unknown layout')
    assert.throws(() => prepareHostLinker(f.options), /Unsupported/)
    writeFileSync(source, f.source)
    assert.throws(
      () => prepareHostLinker({ ...f.options, run: () => ({ status: 2, stderr: 'fixture failure' }) }),
      /fixture failure/,
    )
  }))
