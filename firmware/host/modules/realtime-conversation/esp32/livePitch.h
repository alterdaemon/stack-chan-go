// Copyright (c) 2026 Shinya Ishikawa
// SPDX-License-Identifier: Apache-2.0
#ifndef MOD_LIVE_PITCH_H
#define MOD_LIVE_PITCH_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct LivePitch LivePitch;
// Non-blocking mono PCM16 source. Return the number of samples actually read.
typedef size_t (*LivePitchRead)(void *context, int16_t *samples, size_t count);
typedef struct { size_t received; bool missing; } LivePitchResult;

// Zero succeeds without allocating or opening Sonic; callers use the original path.
int livePitchOpen(LivePitch **out, int semitones);
// Clocked at 48 kHz. Missing input becomes silence, draining Sonic's delayed tail
// during pauses instead of carrying words into a later utterance.
int livePitchRender(LivePitch *pitch, LivePitchRead read, void *context,
                    int16_t *output, size_t count, LivePitchResult *result);
void livePitchClose(LivePitch *pitch);
#endif
