import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('USB capture rejects an existing writer lock before commands or terminal changes', () => {
  const result = execFileSync(
    'python3',
    [
      '-c',
      String.raw`
import fcntl, os, pty, select, subprocess, sys, tempfile, termios
master, slave = pty.openpty()
try:
    fcntl.flock(slave, fcntl.LOCK_EX | fcntl.LOCK_NB)
    before = termios.tcgetattr(slave)
    with tempfile.TemporaryDirectory() as directory:
        for action in ['status', 'off', 'capture']:
            command = [sys.executable, sys.argv[1], '--port', os.ttyname(slave), '--command', action]
            if action == 'capture': command += ['--output', os.path.join(directory, 'trace.jsonl')]
            child = subprocess.run(command, capture_output=True, text=True, timeout=3)
            assert child.returncode != 0 and 'already owned' in child.stderr
            assert not select.select([master], [], [], 0)[0], 'Commands sent to an owned port'
            assert termios.tcgetattr(slave) == before, 'Owned terminal settings changed'
finally:
    os.close(master); os.close(slave)
print('passed shared writer lock')
`,
      fileURLToPath(new URL('../mod/capture-debug.py', import.meta.url)),
    ],
    { encoding: 'utf8' },
  )
  assert.match(result, /passed shared writer lock/)
})

test('qualification defaults are bounded baselines and reject a model/effort Cartesian product', () => {
  const result = execFileSync(
    'python3',
    [
      '-c',
      `
import contextlib, importlib.util, io, sys, tempfile
spec=importlib.util.spec_from_file_location('qualify_live',sys.argv[1])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
runs=[]
class Capture:
    def __init__(self,args): self.rows=[]
    def wait(self,*args,**kwargs): return dict(app_sha256='a'*64)
    def command(self,*args,**kwargs): return dict(phase='applied')
    def trial(self,*args,**kwargs): runs.append((args,kwargs)); return True
    def close(self): pass
module.Capture=Capture
for suite in ('backend','voices','parameters'):
    with tempfile.TemporaryDirectory() as directory:
        runs.clear()
        module.sys.argv=['qualify-live.py','--port','unused','--expected-sha','a'*64,
                         '--suite',suite,'--output',directory]
        module.main()
        assert len(runs)==2, (suite,runs)
        if suite=='backend':
            assert all(r[1]['settings']['model']=='gpt-6.1-terra' and
                       r[1]['settings']['effort']=='medium' for r in runs)
        if suite=='voices': assert all(r[0][0]=='cove' for r in runs)
with tempfile.TemporaryDirectory() as directory:
    runs.clear()
    module.sys.argv=['qualify-live.py','--port','unused','--expected-sha','a'*64,
        '--suite','backend','--output',directory,'--models','gpt-6-luna','gpt-6.1-terra',
        '--efforts','none','low']
    with contextlib.redirect_stderr(io.StringIO()):
        try: module.main(); raise AssertionError('Cartesian product accepted')
        except SystemExit as error: assert error.code==2
    assert not runs
print('passed focused qualification defaults')
`,
      fileURLToPath(new URL('../mod/qualify-live.py', import.meta.url)),
    ],
    { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
  )
  assert.match(result, /passed focused qualification defaults/)
})

test('quiet qualification applies both silence controls before startup and rejects audible profiles', () => {
  const result = execFileSync(
    'python3',
    [
      '-c',
      `
import importlib.util, io, json, sys, tempfile
from pathlib import Path
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('qualify_live',sys.argv[1])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as directory:
    capture=object.__new__(module.Capture)
    capture.args=SimpleNamespace(output=Path(directory),quiet=True)
    capture.results=[]; capture.rows=[]; capture.valid=True
    commands=[]
    class Writer(io.StringIO):
        def write(self,text): commands.append(text.strip()); return super().write(text)
    capture.child=SimpleNamespace(stdin=Writer())
    capture.reset=lambda: commands.append('reset')
    capture.set=lambda parameter,value: commands.append((parameter,value))
    def command(text,*args,**kwargs):
        if text=='diag status': assert kwargs['speaker']==0 and kwargs['trialVolume']==0
        commands.append(text)
    capture.command=command
    capture.wait=lambda *args,**kwargs: dict(phase='applied')
    assert capture.trial('quiet')
    assert commands.index(('speaker',0)) < commands.index('diag live start')
    assert commands.index(('volume',0)) < commands.index('diag live start')
    assert commands[-1]=='diag live stop'
    row=json.loads((Path(directory)/'results.json').read_text())[0]
    assert row['quiet'] and row['settings']['volume']==0
    assert row['startupSeconds'] >= 0 and row['totalSeconds'] >= row['startupSeconds']
    for profile,settings in [('standard',{}),('start',{'volume':1})]:
        before=len(commands)
        try: capture.trial('unsafe',profile=profile,settings=settings); raise AssertionError('Audible trial accepted')
        except ValueError: pass
        assert len(commands)==before
print('passed quiet qualification controls')
`,
      fileURLToPath(new URL('../mod/qualify-live.py', import.meta.url)),
    ],
    { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
  )
  assert.match(result, /passed quiet qualification controls/)
})

test('USB capture retains record-loss maxima after Off resets device counters', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stackchan-capture-'))
  try {
    const result = execFileSync(
      'python3',
      [
        '-c',
        String.raw`import json, os, pty, select, subprocess, sys, time
for index, (dropped, native, progress, late) in enumerate([(0,0,0,False), (3,0,0,False), (0,5,0,False), (3,5,0,False), (0,7,0,True), (0,0,4,True)]):
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
                             enabled=command==b'diag on', dropped=0, nativeDropped=native if late and command==b'diag off' else 0,
                             progressDropped=progress if late and command==b'diag off' else 0)
                os.write(master, ('@diag '+json.dumps(event)+'\n').encode())
                if command == b'diag on':
                    os.write(master, ('@diag '+json.dumps(dict(component='device', event='snapshot',
                        dropped=dropped, nativeDropped=0 if late else native, progressDropped=0 if late else progress))+'\n').encode())
        stdout, stderr = process.communicate(timeout=2)
        summary = json.loads(stdout.strip().splitlines()[-1])
        assert summary['dropped']==dropped and summary['nativeDropped']==native and summary['progressDropped']==progress, (stdout,stderr)
        assert (process.returncode==0)==(dropped==0 and native==0 and progress==0), (stdout,stderr)
        assert summary['acknowledged']
    finally:
        if process.poll() is None: process.kill(); process.communicate()
        os.close(master); os.close(slave)
print('passed 6 PTY captures')
`,
        fileURLToPath(new URL('../mod/capture-debug.py', import.meta.url)),
        directory,
      ],
      { encoding: 'utf8', timeout: 15000 },
    )
    assert.match(result, /passed 6 PTY captures/)
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
    { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
  )
  assert.match(result, /passed/)
})

test('LIVE qualification retains startup/probe failures and always attempts Stop', () => {
  const result = execFileSync(
    'python3',
    [
      '-c',
      String.raw`
import importlib.util, io, json, sys, tempfile
from pathlib import Path
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('qualify_live',sys.argv[1])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
for failure in [None,'startup','probe','stop']:
    with tempfile.TemporaryDirectory() as directory:
        capture=object.__new__(module.Capture)
        capture.args=SimpleNamespace(output=Path(directory))
        capture.results=[]; capture.rows=[]; capture.valid=True
        capture.child=SimpleNamespace(stdin=io.StringIO())
        commands=[]
        capture.reset=lambda: None
        capture.pump=lambda: None
        def command(text,*args,**kwargs):
            commands.append(text)
            if failure=='stop' and text=='diag live stop': raise RuntimeError('stop timeout')
        capture.command=command
        def wait(*args,**kwargs):
            if failure=='startup': raise RuntimeError('startup timeout')
            return dict(phase='applied')
        capture.wait=wait
        def set_value(parameter,value):
            if failure=='probe' and parameter=='probe': raise RuntimeError('probe failed')
        capture.set=set_value
        try:
            passed=capture.trial('fixture',probes=('reasoning',))
            assert failure is None and passed
        except RuntimeError:
            assert failure is not None
        rows=json.loads((Path(directory)/'results.json').read_text())
        assert len(rows)==1 and rows[0]['name']=='fixture'
        assert rows[0]['phase']==('failed' if failure=='startup' else 'probe_failed' if failure else 'applied')
        assert commands.count('diag live stop')==1
        assert capture.valid==(failure!='stop')
print('passed all qualification outcomes')
`,
      fileURLToPath(new URL('../mod/qualify-live.py', import.meta.url)),
    ],
    { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
  )
  assert.match(result, /passed all qualification outcomes/)
})

test('backend qualification stops at account limits even without a provider error code', () => {
  const result = execFileSync(
    'python3',
    [
      '-c',
      String.raw`
import importlib.util, sys, tempfile
spec=importlib.util.spec_from_file_location('qualify_live',sys.argv[1])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
for status in (402,429,401):
    runs=[]; closed=[]
    class Capture:
        def __init__(self,args): self.rows=[]; self.valid=True
        def wait(self,*args,**kwargs): return dict(app_sha256='a'*64)
        def command(self,*args,**kwargs): return dict(phase='applied')
        def trial(self,*args,**kwargs):
            runs.append(args); self.rows.append(dict(status=status)); return False
        def close(self): closed.append(True)
    module.Capture=Capture
    with tempfile.TemporaryDirectory() as directory:
        module.sys.argv=['qualify-live.py','--port','unused','--expected-sha','a'*64,
            '--suite','backend','--models','gpt-6-luna','--efforts','none','low',
            '--interruption','off','--output',directory]
        try: module.main(); raise AssertionError('Expected failed qualification')
        except RuntimeError as error:
            assert ('Account limit' in str(error)) == (status in (402,429))
    assert len(runs)==1
    assert closed==[True]
print('passed account limits')
`,
      fileURLToPath(new URL('../mod/qualify-live.py', import.meta.url)),
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    },
  )
  assert.match(result, /passed account limits/)
})
