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
        self.valid = True
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
                device = json.loads(line)['device']
                self.rows.append(device)
                if device.get('component') == 'native' and device.get('event') in ('abort', 'backtrace'):
                    self.valid = False
                    raise RuntimeError('Native failure invalidated qualification')
                if device.get('dropped', 0) or device.get('nativeDropped', 0) or device.get('progressDropped', 0):
                    self.valid = False
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

    def command(self, text, action, timeout=7, allow_unavailable=False, **fields):
        self.pump()
        after = len(self.rows)
        self.child.stdin.write(text + '\n')
        self.child.stdin.flush()
        result = self.wait(lambda d: d.get('component') == 'debug' and d.get('action') == action and
                           all((d.get(k) in ('applied', 'failed') if k == 'phase' and v == 'applied'
                                else d.get(k) == v) for k, v in fields.items()), after, seconds=timeout)
        if result.get('phase') == 'failed':
            if allow_unavailable and result.get('errorCode') == 'live_unavailable':
                return result
            raise RuntimeError(f'USB control failed: {action}/{fields.get("parameter", "")}: {result.get("errorCode", "failed")}')
        return result

    def set(self, parameter, value):
        self.command(f'diag set {parameter} {value}', 'set', timeout=310 if parameter == 'probe' else 7,
                     parameter=parameter, phase='applied')

    def reset(self):
        self.command('diag reset', 'set', parameter='reset', phase='applied')

    def speech(self, language, after, api=False):
        """Observe text plus rendered output; these are not acoustic/EOT measurements."""
        baseline = max((r.get('audibleMs', 0) for r in self.rows[:after]), default=0)
        cursor, first, accepted, stats = after, None, api, {}
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            self.pump()
            for row in self.rows[cursor:]:
                cursor += 1
                if row.get('event') == 'failure':
                    raise RuntimeError('Speech failed: ' + str(row.get('errorCode')))
                if row.get('event') == 'receive' and row.get('type') in ('output_transcript.added', 'session.output_transcript.delta'):
                    first = row['ms'] if first is None else first
                if row.get('event') == 'probe.output' and row.get('probe') == language:
                    if row.get('accepted') is not True:
                        raise RuntimeError('Speech transcript did not match the fixed probe')
                    accepted = True
                if row.get('component') == 'audio' and row.get('event') == 'snapshot':
                    stats.update(row)
                    if accepted and first is not None and row.get('outputIdleMs', 0) >= 1000 and stats.get('audibleMs', 0) > baseline:
                        return dict(firstTranscriptMs=first, idleSnapshotMs=row['ms'],
                                    sourcePeak=stats.get('sourcePeak'), sourceAbsPeak=stats.get('sourceAbsPeak'),
                                    playbackPeak=stats.get('playbackPeak'),
                                    volumeQ10=stats.get('volumeQ10'), underruns=stats.get('underruns'), overruns=stats.get('overruns'))
            if self.child.poll() is not None:
                raise RuntimeError('USB capture ended during speech')
            time.sleep(0.03)
        raise RuntimeError('Speech completion timed out; remaining cases untested')

    def trial(self, name, profile='start', interruption='off', settings=None, hold=0, probes=()):
        quiet = getattr(self.args, 'quiet', False)
        settings = dict(settings or {})
        if getattr(self.args, 'session_volume', None) is not None:
            settings['volume'] = self.args.session_volume
        if quiet and (profile != 'start' or settings.get('volume', 0) != 0):
            raise ValueError('Quiet trials require the configured start profile and volume 0')
        self.reset()
        if quiet:
            # Trim covers native audio initialization; session volume remains zero
            # even if Off/lease loss later restores the diagnostic trim to one.
            self.set('speaker', 0)
            settings['volume'] = 0
        self.set('interruption', interruption)
        for parameter, value in settings.items():
            self.set(parameter, value)
        self.command('diag status', 'status', interruptionTrial=interruption,
                     **({'speaker': 0, 'trialVolume': 0} if quiet else {}))
        after = len(self.rows)
        started = time.monotonic()
        self.child.stdin.write(f'diag live {profile}\n')
        self.child.stdin.flush()
        end = {'phase': 'failed'}
        elapsed = None
        probe_error = None
        speech = []
        try:
            end = self.wait(lambda d: d.get('action') == 'live' and d.get('setting') == profile and
                            d.get('phase') in ('applied', 'failed'), after)
            elapsed = round(time.monotonic() - started, 3)
            if end['phase'] == 'applied':
                for probe in probes:
                    probe_after = len(self.rows)
                    self.set('probe', probe)
                    if probe in ('english', 'polish'):
                        speech.append(self.speech(probe, probe_after, api=settings.get('connection') == 'api-live'))
            until = time.monotonic() + hold if end['phase'] == 'applied' else 0
            while time.monotonic() < until:
                self.pump()
                time.sleep(0.1)
        except (RuntimeError, OSError) as error:
            probe_error = error
        finally:
            try:
                self.command('diag live stop', 'live', setting='stop', phase='applied')
            except (RuntimeError, OSError) as error:
                self.valid = False
                probe_error = probe_error or error
        details = self.rows[after:]
        result = dict(name=name, profile=profile, interruption=interruption, settings=settings, quiet=quiet,
                      phase='probe_failed' if probe_error and end['phase'] == 'applied' else end['phase'],
                      seconds=elapsed or round(time.monotonic() - started, 3),
                      startupSeconds=elapsed, totalSeconds=round(time.monotonic() - started, 3),
                      session=next((d for d in details if d.get('event') == 'call.session'), None),
                      rejections=[d for d in details if d.get('event') in ('control.rejection', 'control.http')],
                      failures=[d for d in details if d.get('event') == 'failure'],
                      backend=[d for d in details if d.get('event', '').startswith('backend.')],
                      transport=[d for d in details if d.get('component') == 'https'],
                      nativeFailures=[d for d in details if d.get('component') == 'native'],
                      probeOutputs=[d for d in details if d.get('event') == 'probe.output'])
        result['speech'] = speech
        self.results.append(result)
        (self.args.output / 'results.json').write_text(json.dumps(self.results, indent=2) + '\n')
        print(json.dumps({k: result[k] for k in ('name', 'interruption', 'phase', 'startupSeconds', 'totalSeconds')}), flush=True)
        if probe_error:
            raise probe_error
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
        try:
            self.child.stdin.close()
        except OSError:
            pass
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
    parser.add_argument('--models', nargs='+', choices=('gpt-6.1-terra', 'gpt-6-luna'),
                        help='Explicit targeted models; default is the single Terra baseline')
    parser.add_argument('--efforts', nargs='+', choices=('medium', 'none', 'low', 'high', 'xhigh', 'max'),
                        help='Explicit targeted efforts; default is medium; no multi-model/effort product')
    parser.add_argument('--quiet', action='store_true',
                        help='Use configured starts with zero session volume plus temporary speaker trim')
    parser.add_argument('--parameter', choices=('pitch', 'style', 'volume', 'standby', 'prompt'),
                        help='Explicit parameter to investigate; otherwise test only configured starts')
    parser.add_argument('--suite', choices=('voices', 'parameters', 'backend', 'audio', 'matched', 'cycles', 'soak'), required=True)
    parser.add_argument('--connection', choices=('both', 'chatgpt', 'api-live'), default='both', help='Matched suite only; explicit RAM trial')
    parser.add_argument('--language', choices=('english', 'polish'), default='english', help='Fixed matched speech probe')
    parser.add_argument('--session-volume', type=float, help='Bounded RAM session volume for configured trials')
    parser.add_argument('--duration', type=int, default=7200, help='USB lease-renewing capture bound, seconds')
    parser.add_argument('--cycles', type=int, default=100)
    parser.add_argument('--hold', type=int, default=3600, help='Connected soak duration in seconds')
    args = parser.parse_args()
    if args.models and args.efforts and len(args.models) > 1 and len(args.efforts) > 1:
        parser.error('Choose one model or one effort per targeted run; no Cartesian product')
    if args.quiet and (args.suite in ('audio', 'matched') or args.parameter == 'volume'):
        parser.error('Audible/volume qualification cannot run in quiet mode')
    if args.parameter and args.suite != 'parameters':
        parser.error('--parameter requires --suite parameters')
    if args.connection != 'both' and args.suite != 'matched':
        parser.error('--connection requires --suite matched')
    if args.session_volume is not None and (not 0 <= args.session_volume <= 1 or args.parameter == 'volume'):
        parser.error('Invalid or conflicting session volume')
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
        ready_deadline = time.monotonic() + 35
        while True:
            stopped = capture.command('diag live stop', 'live', setting='stop', phase='applied', allow_unavailable=True)
            if stopped['phase'] == 'applied':
                break
            if time.monotonic() >= ready_deadline:
                raise RuntimeError('LIVE controls unavailable after startup; check the active MOD')
            time.sleep(0.5)
        if args.suite == 'matched':
            for mode in ('off', 'on') if args.interruption == 'both' else (args.interruption,):
                for connection in ('api-live', 'chatgpt') if args.connection == 'both' else (args.connection,):
                    if not capture.trial(f'{connection}-{args.language}', interruption=mode,
                        settings={'connection': connection, 'volume': 0.1, 'pitch': 0, 'prompt': 'standard', 'standby': 300},
                        probes=(args.language,)):
                        raise RuntimeError('Matched baseline failed; remaining cases untested')
        elif args.suite == 'backend':
            modes = ('off', 'on') if args.interruption == 'both' else (args.interruption,)
            for mode in modes:
                for model in args.models or ('gpt-6.1-terra',):
                    for effort in args.efforts or ('medium',):
                        if not capture.trial(f'{model}-{effort}',
                                             profile='start' if args.quiet else 'standard', interruption=mode,
                                             settings={'model': model, 'effort': effort, 'voice': 'cove'},
                                             probes=('reasoning', 'search')):
                            if any(d.get('status') in (402, 429) or d.get('providerCode') in
                                   ('rate_limit_exceeded', 'insufficient_quota', 'usage_limit_reached')
                                   for d in capture.rows):
                                raise RuntimeError('Account limit stopped qualification; remaining cases untested')
                            raise RuntimeError('Backend baseline failed; remaining cases untested')
        elif args.suite == 'voices':
            voices = args.voices or ['cove']
            for mode in ('off', 'on') if args.interruption == 'both' else (args.interruption,):
                for voice in voices:
                    if not capture.trial(voice, 'start' if args.quiet else 'standard', mode, {'voice': voice}):
                        raise RuntimeError('Voice baseline failed; remaining cases untested')
        elif args.suite == 'audio':
            for mode in ('off', 'on'):
                for probe in ('english', 'polish'):
                    if not capture.trial(probe, interruption=mode, settings={'volume': 0.1}, probes=(probe,)):
                        raise RuntimeError('Speech baseline failed; remaining cases untested')
        elif args.suite == 'parameters':
            for mode in ('off', 'on') if args.interruption == 'both' else (args.interruption,):
                if not args.parameter:
                    if not capture.trial('configured', interruption=mode):
                        raise RuntimeError('Configured baseline failed; remaining cases untested')
                    continue
                values = {'pitch': (-6, 0, 6), 'style': ('default', 'calm', 'expressive'),
                          'volume': (0, 0.1, 1), 'standby': (1, 60, 3600),
                          'prompt': ('standard', 'long')}[args.parameter]
                for value in values:
                    if not capture.trial(f'{args.parameter}-{value}', interruption=mode,
                                         settings={args.parameter: value}):
                        raise RuntimeError('Parameter trial failed; remaining cases untested')
        elif args.suite == 'cycles':
            failures = consecutive = 0
            for index in range(args.cycles):
                if capture.trial(f'cycle-{index + 1}', interruption='on' if index % 2 else 'off'):
                    consecutive = 0
                else:
                    failures += 1
                    consecutive += 1
                    if consecutive >= 2:
                        raise RuntimeError('Repeated start failures; stop before consuming more account quota')
            if failures:
                raise RuntimeError(f'{failures}/{args.cycles} start/stop cycles failed; see retained evidence')
        else:
            if not capture.trial('soak', interruption='on', settings={'standby': 3600}, hold=args.hold):
                raise RuntimeError('Soak failed')
    finally:
        capture.close()


if __name__ == '__main__':
    main()
