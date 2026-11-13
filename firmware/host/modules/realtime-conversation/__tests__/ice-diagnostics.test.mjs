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
                if (liveIceMetadata(data, length, &type, &code)) {
                    unsigned usernameLength;
                    liveIceChecks(data, &usernameLength);
                }
            }
        } else assert(!liveIceMetadata(data, length, &type, &code));
        free(data);
    }
    /* RFC 5769 section 2.1 sample request (public synthetic values). */
    uint8_t sample[] = {${[...Buffer.from('000100582112a442b7e7a701bc34d686fa87dfae802200105354554e207465737420636c69656e74002400046e0001ff80290008932ff9b151263b36000600096576746a3a68367659202020000800149aeaa70cbfd8cb56781ef2b5b2d3f249c1b571a280280004e57a3bcf', 'hex')].join(',')}};
    assert(liveIceMetadata(sample, sizeof(sample), &type, &code));
    unsigned usernameLength;
    assert(liveIceChecks(sample, &usernameLength) == (1|8|16|32|64|256) && usernameLength == 9);
    sample[sizeof(sample)-1] ^= 1;
    assert(liveIceChecks(sample, &usernameLength) == (1|8|16|32|256));
    memset(sample + sizeof(sample)-28, 0, 20);
    assert(liveIceChecks(sample, &usernameLength) == (1|8|16|32|128|256));
    size_t n = 0;
    const uint8_t sdp[] = "v=0\\r\\na=ice-pwd:example\\r\\na=ice-ufrag:peer\\r\\n";
    const uint8_t *attribute = liveIceAttribute(sdp, sizeof(sdp)-1, "a=ice-pwd:", &n);
    assert(attribute && n == 7 && !memcmp(attribute, "example", 7));
    assert(!liveIceAttribute(sdp, sizeof(sdp)-1, "a=unknown:", &n));
    const uint8_t *username = liveIceHmacUsername(sample, sizeof(sample)-32, &n);
    assert(username && n == 9 && !memcmp(username, "evtj:h6vY", 9));
    for (size_t length = 0; length < sizeof(sample); length++) {
        uint8_t *bounded = malloc(length ? length : 1);
        memcpy(bounded, sample, length);
        liveIceHmacUsername(bounded, length, &n);
        liveIceAttribute(bounded, length, "a=ice-pwd:", &n);
        free(bounded);
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
