// Copyright (c) 2026 Shinya Ishikawa
// SPDX-License-Identifier: Apache-2.0
#ifndef MOD_LIVE_ECHO_H
#define MOD_LIVE_ECHO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* The reference has already passed through the playback delay line. Keep
 * processing for another 200 ms after its last nonzero sample, including
 * startup, so a quiet frame cannot expose the acoustic tail. This state is
 * advanced by capture samples, never by the independently running renderer. */
typedef struct {
    unsigned tail;
} LiveEcho;

static inline void liveEchoReset(LiveEcho *echo)
{
    echo->tail = 3200;
}

static inline bool liveEchoNeedsAEC(LiveEcho *echo, const int16_t *reference, size_t count)
{
    size_t last = count;
    while (last && !reference[last - 1]) last--;
    if (last) {
        unsigned silence = count - last;
        echo->tail = silence < 3200 ? 3200 - silence : 0;
        return true;
    }
    bool active = echo->tail != 0;
    echo->tail = count < echo->tail ? echo->tail - count : 0;
    return active;
}

static inline void liveEchoListeningLevel(int16_t *samples, size_t count, unsigned gainQ10)
{
    if (!gainQ10 || gainQ10 == 1024) return;
    for (size_t i = 0; i < count; i++) {
        int64_t sample = (int64_t)samples[i] * gainQ10 / 1024;
        samples[i] = sample > INT16_MAX ? INT16_MAX : sample < INT16_MIN ? INT16_MIN : sample;
    }
}

#endif
