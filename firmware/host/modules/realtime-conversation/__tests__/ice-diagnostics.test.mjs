import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('ICE metadata bounds untrusted datagrams and returns only binding types and numeric errors', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stackchan-ice-metadata-'))
  try {
    const binary = join(directory, 'ice')
    execFileSync(
      'cc',
      [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-fsanitize=address,undefined',
        '-I',
        fileURLToPath(new URL('../esp32/', import.meta.url)),
        '-x',
        'c',
        '-',
        '-o',
        binary,
      ],
      {
        input: `
#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include "ice-diagnostics.h"
int main(void) {
    uint8_t packet[64] = {0, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42};
    unsigned type = 99, code = 99;
    assert(!liveIceMetadata(NULL, 64, &type, &code));
    assert(!liveIceMetadata(packet, -1, &type, &code));
    assert(liveIceMetadata(packet, 20, &type, &code) && type == 1 && code == 0);
    packet[0] = 1;
    assert(liveIceMetadata(packet, 20, &type, &code) && type == 0x101);
    packet[1] = 0x11; packet[3] = 12;
    packet[21] = 9; packet[23] = 8; packet[26] = 4; packet[27] = 1;
    memcpy(packet + 28, "test", 4);
    assert(liveIceMetadata(packet, 32, &type, &code) && type == 0x111 && code == 401);
    packet[23] = 0xff;
    assert(!liveIceMetadata(packet, 32, &type, &code));
    packet[23] = 7;
    assert(liveIceMetadata(packet, 32, &type, &code) && code == 401);
    packet[3] = 11;
    assert(!liveIceMetadata(packet, 32, &type, &code));
    packet[0] = 0x80;
    assert(!liveIceMetadata(packet, 64, &type, &code));
    for (int length = 0; length <= 128; length++) {
        uint8_t *data = calloc(length ? length : 1, 1);
        memcpy(data, packet, length < 8 ? length : 8);
        if (length >= 20) {
            data[0] = 1; data[1] = 0x11;
            for (unsigned declared = 0; declared < 256; declared++) {
                data[3] = declared;
                liveIceMetadata(data, length, &type, &code);
            }
        } else assert(!liveIceMetadata(data, length, &type, &code));
        free(data);
    }
    return 0;
}
`,
      },
    )
    execFileSync(binary, { timeout: 5000, env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
