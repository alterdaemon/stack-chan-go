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
        pending = b''
        printed = 0
        results = []
        while time.monotonic() < deadline and printed < 1024 * 1024:
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
                # Probe output contains counters and sanitized codes only.
                prefixes = [b'[live-probe] ', b'[main] ', b'[openai-live] ', b'Guru Meditation', b'assert failed', b'Exception']
                starts = [line.find(prefix) for prefix in prefixes if prefix in line]
                start = min(starts) if starts else -1
                if start < 0:
                    continue
                text = line[start:].decode(errors='replace')
                if text.startswith('[live-probe] '):
                    started = True
                    event = json.loads(text[len('[live-probe] '):])
                    if event.get('phase') == 'end':
                        results.append(event)
                print(text, flush=True)
                printed += len(text)
                if '"phase":"done"' in text:
                    valid = len(results) == 3 and all(
                        item.get('state') == 'standby' and item.get('history', 0) > 0
                        for item in results
                    )
                    verify = next((item for item in results if item.get('mode') == 'verify'), {})
                    valid = valid and verify.get('inputReceived') and verify.get('resumedFragments', 0) > 0
                    if not valid:
                        print('probe completed without passing standby, resume and input checks', file=sys.stderr)
                    return 0 if valid else 1
                if '"phase":"failed"' in text or 'MOD override unavailable' in text:
                    return 1
        print('probe capture timed out or exceeded its output bound', file=sys.stderr)
        return 1
    finally:
        os.close(fd)


if __name__ == '__main__':
    sys.exit(main())
