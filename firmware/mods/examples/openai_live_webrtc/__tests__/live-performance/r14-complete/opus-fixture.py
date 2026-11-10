#!/usr/bin/env python3
"""Generate the bounded Opus replay fixture from 16 kHz mono PCM16."""
import argparse
import hashlib
import struct
import subprocess
from pathlib import Path


def ogg_packets(data):
    offset, packet = 0, bytearray()
    while offset < len(data):
        if data[offset:offset + 5] != b'OggS\0' or offset + 27 > len(data):
            raise ValueError('invalid Ogg page')
        count = data[offset + 26]
        table = data[offset + 27:offset + 27 + count]
        if len(table) != count:
            raise ValueError('truncated Ogg segment table')
        offset += 27 + count
        for size in table:
            if offset + size > len(data):
                raise ValueError('truncated Ogg packet')
            packet.extend(data[offset:offset + size])
            offset += size
            if size != 255:
                yield bytes(packet)
                packet.clear()
    if packet:
        raise ValueError('unterminated Ogg packet')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pcm', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    if not 32000 <= args.pcm.stat().st_size <= 160000 or args.pcm.stat().st_size % 2:
        parser.error('expected 1–5 seconds of mono PCM16 at 16 kHz')
    ogg = subprocess.check_output([
        'ffmpeg', '-nostdin', '-loglevel', 'error', '-f', 's16le',
        '-ar', '16000', '-ac', '1', '-i', str(args.pcm), '-c:a', 'libopus',
        '-application', 'voip', '-frame_duration', '20', '-b:a', '24000',
        '-f', 'ogg', 'pipe:1',
    ])
    packets = list(ogg_packets(ogg))
    if len(packets) < 3 or not packets[0].startswith(b'OpusHead') or not packets[1].startswith(b'OpusTags'):
        raise ValueError('missing Opus headers')
    frames = packets[2:]
    if not 30 <= len(frames) <= 256 or any(not 0 < len(p) <= 1275 for p in frames):
        raise ValueError('unexpected Opus fixture bounds')
    fixture = b''.join(struct.pack('<H', len(p)) + p for p in frames)
    args.output.write_bytes(fixture)
    print(f'{len(frames)} packets, {len(fixture)} bytes, SHA-256 {hashlib.sha256(fixture).hexdigest()}')


if __name__ == '__main__':
    main()
