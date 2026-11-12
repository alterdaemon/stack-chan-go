// Copyright (c) 2026 Shinya Ishikawa
// SPDX-License-Identifier: Apache-2.0
#include "livePitch.h"
#include "esp_ae_sonic.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

#define PITCH_BLOCK 160
struct LivePitch {
    esp_ae_sonic_handle_t sonic;
    int16_t input[PITCH_BLOCK];
    size_t offset;
};

int livePitchOpen(LivePitch **out, int semitones)
{
    *out = NULL;
    if (semitones < -6 || semitones > 6) return ESP_AE_ERR_INVALID_PARAMETER;
    if (!semitones) return 0;
    LivePitch *p = calloc(1, sizeof(*p));
    if (!p) return ESP_AE_ERR_MEM_LACK;
    esp_ae_sonic_cfg_t config = {.sample_rate = 16000, .channel = 1, .bits_per_sample = 16};
    int err = esp_ae_sonic_open(&config, &p->sonic);
    if (!err) err = esp_ae_sonic_set_speed(p->sonic, 1.0f);
    if (!err) err = esp_ae_sonic_set_pitch(p->sonic, powf(2.0f, semitones / 12.0f));
    if (err) { livePitchClose(p); return err; }
    p->offset = PITCH_BLOCK;
    *out = p;
    return 0;
}

int livePitchRender(LivePitch *p, LivePitchRead read, void *context,
                    int16_t *output, size_t count, LivePitchResult *result)
{
    *result = (LivePitchResult){0};
    if (!p || !count || count > PITCH_BLOCK) return ESP_AE_ERR_INVALID_PARAMETER;
    size_t written = 0;
    // Sonic may consume several blocks before producing its first output, or
    // produce output without consuming input. Preserve leftovers in both cases.
    // Bound work on the audio task; a stalled/malformed processor fails the call.
    for (unsigned work = 0; written < count && work < 16; work++) {
        if (p->offset == PITCH_BLOCK) {
            size_t got = read(context, p->input, PITCH_BLOCK);
            if (got > PITCH_BLOCK) return ESP_AE_ERR_FAIL;
            result->received += got;
            result->missing |= got < PITCH_BLOCK;
            memset(p->input + got, 0, (PITCH_BLOCK - got) * sizeof(int16_t));
            p->offset = 0;
        }
        esp_ae_sonic_in_data_t in = {.samples = p->input + p->offset, .num = PITCH_BLOCK - p->offset};
        esp_ae_sonic_out_data_t out = {.samples = output + written, .needed_num = count - written};
        int err = esp_ae_sonic_process(p->sonic, &in, &out);
        if (err) return err;
        if (in.consume_num > in.num || out.out_num > out.needed_num || (!in.consume_num && !out.out_num))
            return ESP_AE_ERR_FAIL;
        p->offset += in.consume_num;
        written += out.out_num;
    }
    return written == count ? 0 : ESP_AE_ERR_FAIL;
}

int livePitchReset(LivePitch *p)
{
    if (!p) return 0;
    int err = esp_ae_sonic_reset(p->sonic);
    if (!err) p->offset = sizeof(p->input) / sizeof(p->input[0]);
    return err;
}

void livePitchClose(LivePitch *p)
{
    if (!p) return;
    if (p->sonic) esp_ae_sonic_close(p->sonic);
    free(p);
}
