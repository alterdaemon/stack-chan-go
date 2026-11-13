// SPDX-License-Identifier: Apache-2.0
#ifndef STACKCHAN_ICE_DIAGNOSTICS_H
#define STACKCHAN_ICE_DIAGNOSTICS_H
#include <stdbool.h>
#include <stdint.h>

/* Metadata only, not STUN authentication. No payload, identifier or address is
 * retained. The peer implementation still validates every connectivity check. */
static inline bool liveIceMetadata(const uint8_t *data, int size, unsigned *type, unsigned *error)
{
    if (!data || size < 20 || data[0] & 0xc0 || data[4] != 0x21 || data[5] != 0x12 ||
        data[6] != 0xa4 || data[7] != 0x42) return false;
    unsigned kind = ((unsigned)data[0] << 8) | data[1];
    unsigned length = ((unsigned)data[2] << 8) | data[3];
    if ((kind != 1 && kind != 0x101 && kind != 0x111) || length & 3 || length > (unsigned)size - 20) return false;
    unsigned code = 0, end = 20 + length;
    for (unsigned at = 20; at < end;) {
        if (end - at < 4) return false;
        unsigned attribute = ((unsigned)data[at] << 8) | data[at + 1];
        unsigned bytes = ((unsigned)data[at + 2] << 8) | data[at + 3];
        if (bytes > end - at - 4) return false;
        if (kind == 0x111 && attribute == 9 && bytes >= 4 && data[at + 7] <= 99)
            code = (data[at + 6] & 7) * 100 + data[at + 7];
        unsigned padded = (bytes + 3) & ~3U;
        if (padded > end - at - 4) return false;
        at += 4 + padded;
    }
    *type = kind;
    *error = code >= 300 && code <= 699 ? code : 0;
    return true;
}
#endif
