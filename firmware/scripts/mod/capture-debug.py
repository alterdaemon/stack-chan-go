#!/usr/bin/env python3
"""Control RAM-only device diagnostics over USB without resetting the board."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import select
import termios
import time
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', default='/dev/ttyACM0')
    parser.add_argument('--command', choices=('capture', 'status', 'off'), default='capture')
    parser.add_argument('--duration', type=float, default=180)
    parser.add_argument('--interactive', action='store_true', help='Accept diag commands on stdin while capturing')
    parser.add_argument('--output', type=Path, help='Private JSONL destination for capture')
    args = parser.parse_args()
    if args.command == 'capture' and args.output is None:
        parser.error('--output is required for capture')
    if not 0 < args.duration <= 43200:
        parser.error('--duration must be between 0 and 43200 seconds')
    output = None
    if args.output:
        # Exclusivity prevents accidentally replacing an earlier incident trace.
        fd_out = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        output = os.fdopen(fd_out, 'w', buffering=1)
    fd = None
    old = None
    records = 0
    acknowledged = False
    requested_off = False
    last_control = None
    pending = bytearray()
    try:
        fd = os.open(args.port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        old = termios.tcgetattr(fd)
        raw = list(old)
        raw[3] &= ~(termios.ECHO | termios.ICANON | termios.ISIG)
        raw[1] &= ~termios.OPOST
        # Deliberately do not manipulate DTR/RTS, baud rate, boot mode or HUPCL.
        termios.tcsetattr(fd, termios.TCSANOW, raw)

        def send(command):
            data = memoryview((command + '\n').encode('ascii'))
            deadline = time.monotonic() + 2
            while data:
                if time.monotonic() > deadline:
                    raise RuntimeError('USB command write timed out')
                if select.select([], [fd], [], 0.1)[1]:
                    data = data[os.write(fd, data):]

        send('diag on' if args.command == 'capture' else 'diag ' + args.command)
        started = time.monotonic()
        deadline = started + (args.duration if args.command == 'capture' else 5)
        next_keepalive = started + 10
        stdin_open = args.interactive
        while time.monotonic() < deadline:
            now = time.monotonic()
            if not acknowledged and now - started > 5:
                raise RuntimeError('No diagnostic acknowledgement; firmware may lack support or USB may be owned by the dock')
            if args.command == 'capture' and last_control is not None and now - last_control > 25:
                raise RuntimeError('Diagnostic keepalive acknowledgement lost; capture stopped')
            if args.command == 'capture' and now >= next_keepalive:
                send('diag keepalive')
                next_keepalive = now + 10
            ready = select.select([fd] + ([sys.stdin] if stdin_open else []), [], [], 0.2)[0]
            if sys.stdin in ready:
                line = sys.stdin.readline()
                if not line:
                    stdin_open = False
                else:
                    command = line.strip()
                    if len(command) <= 128 and command.isascii() and command.startswith('diag '):
                        send(command)
                        requested_off = command == 'diag off'
            if fd not in ready:
                continue
            chunk = os.read(fd, 4096)
            if not chunk:
                raise RuntimeError('USB device disconnected')
            pending.extend(chunk)
            while b'\n' in pending:
                line, _, pending = pending.partition(b'\n')
                # Console output can precede a record. Parse only the diagnostic envelope.
                marker = line.find(b'@diag ')
                if marker < 0:
                    continue
                try:
                    event = json.loads(line[marker + 6:])
                except (ValueError, UnicodeError):
                    continue
                records += 1
                if output:
                    output.write(json.dumps({'hostUtc': datetime.now(timezone.utc).isoformat(), 'device': event}) + '\n')
                if event.get('component') == 'debug' and event.get('event') == 'control':
                    action = event.get('action')
                    last_control = time.monotonic()
                    if args.command == 'capture' and event.get('enabled') is False:
                        if requested_off:
                            return
                        raise RuntimeError('Device disabled diagnostics; capture stopped and RAM trials were reset')
                    expected = {'capture': 'on', 'status': 'status', 'off': 'off'}[args.command]
                    if action == expected:
                        acknowledged = True
                        print(json.dumps(event), flush=True)
                        if args.command != 'capture':
                            return
                    elif action in ('status', 'set', 'invalid_command', 'command_pending', 'enable_required'):
                        print(json.dumps(event), flush=True)
            if len(pending) > 4096:
                pending.clear()
    except KeyboardInterrupt:
        pass
    finally:
        if fd is not None:
            if args.command == 'capture':
                try:
                    os.write(fd, b'diag off\n')
                    # Read acknowledgement without extending the capture indefinitely.
                    limit = time.monotonic() + 1
                    while time.monotonic() < limit:
                        if not select.select([fd], [], [], 0.1)[0]:
                            continue
                        if b'"action":"off"' in os.read(fd, 4096):
                            print('Diagnostics disabled', flush=True)
                            break
                except OSError:
                    pass  # The firmware lease expires even after cable/process loss.
            if old is not None:
                try:
                    termios.tcsetattr(fd, termios.TCSANOW, old)
                except (OSError, termios.error):
                    pass
            os.close(fd)
        if output:
            output.close()
        print(json.dumps({'records': records, 'acknowledged': acknowledged}), flush=True)


if __name__ == '__main__':
    main()
