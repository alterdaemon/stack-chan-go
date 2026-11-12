// Copyright (c) 2026 Shinya Ishikawa
// SPDX-License-Identifier: Apache-2.0
#ifndef MOD_LIVE_CODEC_H
#define MOD_LIVE_CODEC_H
#include <stdbool.h>
#include <stdint.h>
#include "driver/i2c_master.h"
typedef struct {
    i2c_master_dev_handle_t device;
    uint8_t savedGain[2];
    bool saved;
    unsigned captureGainQ10;
} LiveCodec;
int liveCodecOpen(LiveCodec *codec, unsigned gainDb);
int liveCodecClose(LiveCodec *codec);
#endif
