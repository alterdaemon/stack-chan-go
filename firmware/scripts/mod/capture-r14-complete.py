#!/usr/bin/env python3
"""Bounded R14 diagnostic collection; opening the serial port does not reset it."""
import argparse
import errno
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
    parser.add_argument('--seconds', type=int, default=900)
    parser.add_argument('--startup', type=int, default=30)
    parser.add_argument('--quiet-limit', type=int, default=55)
    parser.add_argument('--marker', default='r14-complete')
    parser.add_argument('--camera-events', action='store_true')
    args = parser.parse_args()
    probe_marker = f'[{args.marker}] '.encode()
    opening = time.monotonic()
    while True:
        try:
            fd = os.open(args.port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
            break
        except OSError as error:
            if error.errno not in (errno.ENOENT, errno.ENODEV, errno.EIO) or time.monotonic() - opening >= 10:
                raise
            time.sleep(0.1)
    try:
        tty.setraw(fd, termios.TCSANOW)
        settings = termios.tcgetattr(fd)
        settings[4] = settings[5] = termios.B115200
        termios.tcsetattr(fd, termios.TCSANOW, settings)
        began = last = time.monotonic()
        started = False
        pending = b''
        size = 0
        while time.monotonic() - began < args.seconds and size < 2 * 1024 * 1024:
            now = time.monotonic()
            if not started and now - began > args.startup:
                print(f'{args.marker} probe did not start', file=sys.stderr)
                return 1
            if started and now - last > args.quiet_limit:
                print(f'{args.marker} probe stopped progressing', file=sys.stderr)
                return 1
            if not select.select([fd], [], [], 0.25)[0]:
                continue
            try:
                pending = (pending + os.read(fd, 8192))[-32768:]
            except BlockingIOError:
                continue
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                offset = line.find(probe_marker)
                if offset >= 0:
                    event = json.loads(line[offset + len(probe_marker):])
                    event['hostMonotonic'] = time.monotonic()
                    output = json.dumps(event, separators=(',', ':'))
                    print(output, flush=True)
                    size += len(output)
                    started = True
                    last = time.monotonic()
                    if event.get('phase') == 'failed':
                        return 1
                    if event.get('phase') == 'done':
                        return 0
                elif any(pattern in line for pattern in (b'Guru Meditation', b'assert failed', b'XS abort', b'stack overflow')):
                    print('Device reported a fatal runtime error', file=sys.stderr)
                    return 1
                elif b'[main] startup failed' in line:
                    print('Host application failed before the diagnostic started', file=sys.stderr)
                    return 1
                elif b'Failed to create audio src thread' in line:
                    print(json.dumps({'phase': 'sdk-diagnostic', 'code': 'audio_src_thread_create_failed',
                                      'hostMonotonic': time.monotonic()}), flush=True)
                elif b'[openai-live] diagnostic ' in line:
                    detail = json.loads(line.split(b'[openai-live] diagnostic ', 1)[1])
                    fields = {key: detail[key] for key in ('code', 'stage', 'site', 'status', 'providerCode') if key in detail}
                    print(json.dumps({'phase': 'provider-diagnostic', **fields}), flush=True)
                elif args.camera_events:
                    for marker, phase in (
                        (b'[CameraPreview] render mode=bitmap', 'preview-bitmap'),
                        (b'[CameraPreview] render mode=mosaic', 'preview-mosaic'),
                        (b'[CameraPreview] stop error', 'preview-stop-error'),
                        (b'[CameraPreview] camera stop done', 'preview-stopped'),
                        (b'[runtime-camera] touch panel resume done', 'touch-resumed'),
                        (b'[runtime-camera] touch panel restart error', 'touch-resume-error'),
                    ):
                        if marker in line:
                            print(json.dumps({'phase': phase, 'hostMonotonic': time.monotonic()}), flush=True)
                            break
        print(f'{args.marker} probe exceeded its time/output bound', file=sys.stderr)
        return 1
    finally:
        os.close(fd)


if __name__ == '__main__':
    sys.exit(main())
