#!/usr/bin/env python3
"""Qualify LIVE over the existing USB diagnostic lane; never flash or write preferences."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

# Codex 69231e11: RealtimeVoicesList::builtin().v3. Candidates, not promised entitlement.
VOICES = 'juniper maple spruce ember vale breeze arbor sol cove marin aube bubbie haetsal hanul himari leher miko neer porto rindo rio rivage selva sonna tinta viola'.split()


class Capture:
    def __init__(self, args):
        self.args = args
        self.rows = []
        self.reader = None
        self.results = []
        args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
        self.trace = args.output / 'capture.jsonl'
        self.log = (args.output / 'capture.log').open('x')
        self.child = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name('capture-debug.py')), '--port', args.port,
             '--interactive', '--duration', str(args.duration), '--output', str(self.trace)],
            stdin=subprocess.PIPE, stdout=self.log, stderr=subprocess.STDOUT, text=True, bufsize=1)

    def pump(self):
        if self.reader is None and self.trace.exists():
            self.reader = self.trace.open()
        if self.reader:
            while True:
                at = self.reader.tell()
                line = self.reader.readline()
                if not line:
                    break
                if not line.endswith('\n'):
                    self.reader.seek(at)
                    break
                self.rows.append(json.loads(line)['device'])
        if any(d.get('dropped', 0) or d.get('nativeDropped', 0) for d in self.rows):
            raise RuntimeError('Lost diagnostic records; qualification is invalid')

    def wait(self, predicate, after=0, seconds=35):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump()
            for row in self.rows[after:]:
                if predicate(row):
                    return row
            if self.child.poll() is not None:
                raise RuntimeError('USB capture ended')
            time.sleep(0.03)
        raise RuntimeError('USB control acknowledgement timed out')

    def command(self, text, action, timeout=7, **fields):
        self.pump()
        after = len(self.rows)
        self.child.stdin.write(text + '\n')
        self.child.stdin.flush()
        result = self.wait(lambda d: d.get('component') == 'debug' and d.get('action') == action and
                           all((d.get(k) in ('applied', 'failed') if k == 'phase' and v == 'applied'
                                else d.get(k) == v) for k, v in fields.items()), after, seconds=timeout)
        if result.get('phase') == 'failed':
            raise RuntimeError(f'USB control failed: {action}/{fields.get("parameter", "")}: {result.get("code", "failed")}')
        return result

    def set(self, parameter, value):
        self.command(f'diag set {parameter} {value}', 'set', timeout=55 if parameter == 'probe' else 7,
                     parameter=parameter, phase='applied')

    def reset(self):
        self.command('diag reset', 'set', parameter='reset', phase='applied')

    def trial(self, name, profile='start', interruption='off', settings=None, hold=0, probes=()):
        self.reset()
        self.set('interruption', interruption)
        for parameter, value in (settings or {}).items():
            self.set(parameter, value)
        self.command('diag status', 'status', interruptionTrial=interruption)
        after = len(self.rows)
        started = time.monotonic()
        self.child.stdin.write(f'diag live {profile}\n')
        self.child.stdin.flush()
        end = self.wait(lambda d: d.get('action') == 'live' and d.get('setting') == profile and
                        d.get('phase') in ('applied', 'failed'), after)
        elapsed = round(time.monotonic() - started, 3)
        if end['phase'] == 'applied':
            for probe in probes:
                self.set('probe', probe)
        until = time.monotonic() + hold if end['phase'] == 'applied' else 0
        while time.monotonic() < until:
            self.pump()
            time.sleep(0.1)
        self.command('diag live stop', 'live', setting='stop', phase='applied')
        details = self.rows[after:]
        result = dict(name=name, profile=profile, interruption=interruption, settings=settings or {},
                      phase=end['phase'], seconds=elapsed,
                      session=next((d for d in details if d.get('event') == 'call.session'), None),
                      rejections=[d for d in details if d.get('event') in ('control.rejection', 'control.http')],
                      failures=[d for d in details if d.get('event') == 'failure'],
                      backend=[d for d in details if d.get('event', '').startswith('backend.')],
                      probeOutputs=[d for d in details if d.get('event') == 'probe.output'])
        self.results.append(result)
        (self.args.output / 'results.json').write_text(json.dumps(self.results, indent=2) + '\n')
        print(json.dumps({k: result[k] for k in ('name', 'interruption', 'phase', 'seconds')}), flush=True)
        return result['phase'] == 'applied' and not result['failures']

    def close(self):
        if self.child.poll() is None:
            try:
                self.child.stdin.write('diag off\n')
                self.child.stdin.flush()
                self.child.wait(timeout=6)
            except (OSError, subprocess.TimeoutExpired):
                self.child.send_signal(signal.SIGINT)
                self.child.wait(timeout=6)
        self.pump()
        if self.reader:
            self.reader.close()
        self.log.close()
        if self.child.returncode:
            raise RuntimeError(f'USB capture failed: {self.child.returncode}')
        if not any(d.get('action') == 'off' and d.get('enabled') is False for d in self.rows):
            raise RuntimeError('Missing final Off acknowledgement')


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', required=True)
    parser.add_argument('--expected-sha', required=True, help='Running app ELF SHA256 from validated image')
    parser.add_argument('--output', required=True, type=Path, help='New private evidence directory')
    parser.add_argument('--voices', nargs='+', choices=VOICES, help='Specific documented candidates to retest')
    parser.add_argument('--interruption', choices=('off', 'on', 'both'), default='both')
    parser.add_argument('--suite', choices=('voices', 'parameters', 'backend', 'audio', 'cycles', 'soak'), required=True)
    parser.add_argument('--duration', type=int, default=7200, help='USB lease-renewing capture bound, seconds')
    parser.add_argument('--cycles', type=int, default=100)
    parser.add_argument('--hold', type=int, default=3600, help='Connected soak duration in seconds')
    args = parser.parse_args()
    if len(args.expected_sha) != 64 or any(c not in '0123456789abcdef' for c in args.expected_sha):
        parser.error('--expected-sha must be the validated image ELF SHA256')
    if not 1 <= args.cycles <= 1000 or not 1 <= args.hold <= 7200 or not 60 <= args.duration <= 14400:
        parser.error('Trial bounds exceeded')
    capture = Capture(args)
    try:
        first = capture.wait(lambda d: d.get('action') == 'on', seconds=7)
        if first.get('app_sha256') != args.expected_sha:
            raise RuntimeError('Running image identity differs from the validated candidate')
        (args.output / 'identity.json').write_text(json.dumps(first, indent=2) + '\n')
        if args.suite == 'backend':
            for mode in ('off', 'on'):
                for model in ('gpt-6.1-terra', 'gpt-6-luna'):
                    for effort in ('none', 'low', 'medium', 'high', 'xhigh', 'max'):
                        if not capture.trial(f'{model}-{effort}', interruption=mode,
                                             settings={'model': model, 'effort': effort}, probes=('reasoning',)):
                            raise RuntimeError('Backend parameter qualification failed')
                    if not capture.trial(f'{model}-search', interruption=mode,
                                         settings={'model': model, 'effort': 'medium'}, probes=('search',)):
                        raise RuntimeError('Search qualification failed')
        elif args.suite == 'voices':
            voices = args.voices or ['cove'] + [v for v in VOICES if v != 'cove']
            for mode in ('off', 'on') if args.interruption == 'both' else (args.interruption,):
                for voice in voices:
                    capture.trial(voice, 'standard', mode, {'voice': voice})
            capture.trial('baseline-recheck', 'standard')
        elif args.suite == 'audio':
            for mode in ('off', 'on'):
                for probe in ('english', 'polish'):
                    capture.trial(probe, interruption=mode, probes=(probe,), hold=10)
        elif args.suite == 'parameters':
            for mode in ('off', 'on') if args.interruption == 'both' else (args.interruption,):
                for profile in ('standard', 'voice', 'prompt', 'pitch', 'start'):
                    capture.trial(profile, profile, mode)
                for parameter, values in [('pitch', range(-6, 7)), ('style', ['default', 'calm', 'expressive']),
                                          ('volume', [0, 0.1, 0.5, 1]), ('standby', [1, 60, 3600]),
                                          ('prompt', ['standard', 'long'])]:
                    for value in values:
                        capture.trial(f'{parameter}-{value}', interruption=mode, settings={parameter: value})
        elif args.suite == 'cycles':
            for index in range(args.cycles):
                if not capture.trial(f'cycle-{index + 1}', interruption='on' if index % 2 else 'off'):
                    raise RuntimeError('Start/stop cycle failed')
        else:
            if not capture.trial('soak', interruption='on', settings={'standby': 3600}, hold=args.hold):
                raise RuntimeError('Soak failed')
    finally:
        capture.close()


if __name__ == '__main__':
    main()
