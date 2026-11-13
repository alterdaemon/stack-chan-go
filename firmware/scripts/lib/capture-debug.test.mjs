import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('USB capture retains record-loss maxima after Off resets device counters', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stackchan-capture-'))
  try {
    const result = execFileSync(
      'python3',
      [
        '-c',
        String.raw`import json, os, pty, select, subprocess, sys, time
for index, (dropped, native, late) in enumerate([(0,0,False), (3,0,False), (0,5,False), (3,5,False), (0,7,True)]):
    master, slave = pty.openpty()
    process = subprocess.Popen([sys.executable, sys.argv[1], '--port', os.ttyname(slave),
        '--duration', '0.2', '--output', os.path.join(sys.argv[2], str(index)+'.jsonl')],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    pending = b''
    deadline = time.monotonic()+5
    try:
        while process.poll() is None and time.monotonic() < deadline:
            if not select.select([master], [], [], 0.05)[0]: continue
            pending += os.read(master, 4096)
            while b'\n' in pending:
                command, _, pending = pending.partition(b'\n')
                command = command.strip()
                if command not in (b'diag on', b'diag off'): continue
                event = dict(component='debug', event='control', action='on' if command==b'diag on' else 'off',
                             enabled=command==b'diag on', dropped=0, nativeDropped=native if late and command==b'diag off' else 0)
                os.write(master, ('@diag '+json.dumps(event)+'\n').encode())
                if command == b'diag on':
                    os.write(master, ('@diag '+json.dumps(dict(component='device', event='snapshot',
                        dropped=dropped, nativeDropped=0 if late else native))+'\n').encode())
        stdout, stderr = process.communicate(timeout=2)
        summary = json.loads(stdout.strip().splitlines()[-1])
        assert summary['dropped']==dropped and summary['nativeDropped']==native, (stdout,stderr)
        assert (process.returncode==0)==(dropped==0 and native==0), (stdout,stderr)
        assert summary['acknowledged']
    finally:
        if process.poll() is None: process.kill(); process.communicate()
        os.close(master); os.close(slave)
print('passed 5 PTY captures')
`,
        fileURLToPath(new URL('../mod/capture-debug.py', import.meta.url)),
        directory,
      ],
      { encoding: 'utf8', timeout: 15000 },
    )
    assert.match(result, /passed 5 PTY captures/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('native crash retention exports only code addresses and rejects raw console or stack data', () => {
  const result = execFileSync(
    'python3',
    [
      '-c',
      String.raw`
import importlib.util, sys
spec=importlib.util.spec_from_file_location('capture_debug',sys.argv[1])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
assert module.native_failure(b'Backtrace: 0x40381234:0x3fc12345 0x42001234:0x3fc23456\r')==dict(component='native',event='backtrace',frames=['0x40381234','0x42001234'])
assert module.native_failure(b'abort() was called at PC 0x42001234 on core 1\r')==dict(component='native',event='abort',pc='0x42001234',core=1)
for text in [b'private-secret',b'Stack memory: 0x12345678',b'Backtrace: 0x40381234:0x3fc12345 private-secret',b'abort() private-secret']:
    assert module.native_failure(text) is None
print('passed')
`,
      fileURLToPath(new URL('../mod/capture-debug.py', import.meta.url)),
    ],
    { encoding: 'utf8' },
  )
  assert.match(result, /passed/)
})
