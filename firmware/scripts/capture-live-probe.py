#!/usr/bin/env python3
"""Read bounded, machine-readable device probe output without resetting it."""
import argparse
import json
import os
import select
import sys
import termios
import time
import tty


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', default='/dev/ttyACM0')
    parser.add_argument('--seconds', type=int, default=180)
    parser.add_argument('--realtime', action='store_true', help='Validate the Realtime Mini probe')
    parser.add_argument('--search-only', action='store_true', help='Validate only the prompt search scenario')
    parser.add_argument('--prompt', action='store_true', help='Validate saved and RAM-only prompts in both modes')
    args = parser.parse_args()
    fd = os.open(args.port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        tty.setraw(fd, termios.TCSANOW)
        cfg = termios.tcgetattr(fd)
        cfg[4] = cfg[5] = termios.B115200
        termios.tcsetattr(fd, termios.TCSANOW, cfg)
        deadline = time.monotonic() + args.seconds
        startup_deadline = time.monotonic() + 30
        started = False
        closing_deadline = None
        pending = b''
        printed = 0
        results = []
        while time.monotonic() < deadline and printed < 1024 * 1024:
            if closing_deadline and time.monotonic() > closing_deadline:
                print('probe close did not complete within 15 seconds', file=sys.stderr)
                return 1
            if not started and time.monotonic() > startup_deadline:
                print('probe did not start within 30 seconds', file=sys.stderr)
                return 1
            if not select.select([fd], [], [], .25)[0]:
                continue
            try:
                data = os.read(fd, 4096)
            except BlockingIOError:
                continue
            pending = (pending + data)[-16384:]
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                # Prompt probes include generated speech, never credentials or instruction bodies.
                prefixes = [b'[prompt-probe] ', b'[realtime-probe] ', b'[live-probe] ', b'[main] ', b'[openai-live] ', b'Guru Meditation', b'assert failed', b'Exception']
                starts = [line.find(prefix) for prefix in prefixes if prefix in line]
                start = min(starts) if starts else -1
                if start < 0:
                    continue
                text = line[start:].decode(errors='replace')
                prefix = '[prompt-probe] ' if args.prompt else '[realtime-probe] ' if args.realtime else '[live-probe] '
                if text.startswith(prefix):
                    started = True
                    event = json.loads(text[len(prefix):])
                    if event.get('phase') in ('end', 'cancelled', 'initial', 'explicit_update', 'audio_input', 'arithmetic', 'search'):
                        results.append(event)
                if args.realtime and text.startswith('[openai-live] '):
                    if text.startswith('[openai-live] closing'):
                        closing_deadline = time.monotonic() + 15
                    elif any(text.startswith('[openai-live] ' + state) for state in ('idle', 'error', 'connected')):
                        closing_deadline = None
                print(text, flush=True)
                printed += len(text)
                if '"phase":"done"' in text:
                    valid = len(results) == 3 and all(
                        item.get('state') == 'standby' and item.get('history', 0) > 0
                        for item in results
                    )
                    verify = next((item for item in results if item.get('mode') == 'verify'), {})
                    valid = valid and verify.get('inputReceived') and verify.get('resumedFragments', 0) > 0
                    if args.realtime:
                        endings = [item for item in results if item.get('phase') == 'end']
                        cancellations = [item for item in results if item.get('phase') == 'cancelled']
                        valid = len(endings) == 2 and {item.get('bargeIn') for item in endings} == {False, True}
                        valid = valid and all(item.get('observed', {}).get('speech', 0) > 0 and item.get('observed', {}).get('results', 0) > 0 for item in endings)
                        valid = valid and all(item.get('observed', {}).get('delayOverruns') == 0 for item in endings)
                        interrupted = next((item.get('observed', {}) for item in endings if item.get('bargeIn')), {})
                        valid = valid and interrupted.get('cleared', 0) > 0 and isinstance(interrupted.get('localStopMs'), (int, float))
                        valid = valid and len(cancellations) == 1 and cancellations[0].get('observed', {}).get('cancelled', 0) > 0
                    if args.prompt:
                        valid = len(results) == 10 and all(
                            (item.get('requestMatches') and item.get('match') is not False if item.get('mode') == 'live' else item.get('match'))
                            and item.get('status') in ('completed', 'audio_received') for item in results)
                        valid = valid and sum(item.get('mode') == 'live' for item in results) == 1
                        valid = valid and sum(item.get('phase') == 'audio_input' for item in results) == 4
                        valid = valid and all(item.get('markerFollowed') for item in results if item.get('variant') == 'marker')
                    if args.prompt and args.search_only:
                        valid = len(results) == 1 and all(
                            item.get('phase') == 'search' and item.get('match') is True
                            and item.get('status') == 'completed' and item.get('text', '').strip()
                            and item.get('tools', 0) > 0 and item.get('sources', 0) > 0
                            and not item.get('toolError') and item.get('media', {}).get('audibleMs', 0) > 0
                            for item in results)
                    if not valid:
                        print('probe completed without passing its required checks', file=sys.stderr)
                    return 0 if valid else 1
                if '"phase":"failed"' in text or 'MOD override unavailable' in text:
                    return 1
        print('probe capture timed out or exceeded its output bound', file=sys.stderr)
        return 1
    finally:
        os.close(fd)


if __name__ == '__main__':
    sys.exit(main())
