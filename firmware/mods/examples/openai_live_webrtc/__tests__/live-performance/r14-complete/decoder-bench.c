// Isolated device comparison using the installed SDK queue and Opus decoder.
#include "xsHost.h"
#include "xsmc.h"
#include "r14-config.h"
#include "audio_decoder.h"
#include "data_queue.h"
#include "msg_q.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdlib.h>

typedef struct { unsigned hash, samples, frames; } Decoded;
static int decoded(av_render_audio_frame_t *frame, void *context) {
    Decoded *out = context;
    const int16_t *samples = (const int16_t *)frame->data;
    for (unsigned i = 0; i < frame->size / 2; i++) out->hash = (out->hash ^ (uint16_t)samples[i]) * 16777619u;
    out->samples += frame->size / 2; out->frames++;
    return 0;
}
void xs_r14_decoder_bench(xsMachine *the) {
    void *buffer; xsUnsignedValue bytes;
    xsmcGetBufferReadable(xsArg(0), &buffer, &bytes);
    unsigned batch = xsmcToInteger(xsArg(1)), cancelAfter = xsmcToInteger(xsArg(2));
    if (batch != 1 && batch != 3) xsRangeError("decoder batch");
    Decoded out = {.hash = 2166136261u};
    adec_cfg_t cfg = {.audio_info = {.codec = AV_RENDER_AUDIO_CODEC_OPUS, .sample_rate = 48000, .channel = 2, .bits_per_sample = 16}, .frame_cb = decoded, .ctx = &out};
    adec_handle_t decoder = adec_open(&cfg);
    data_queue_t *queue = data_queue_init(8192);
    msg_q_handle_t control = msg_q_create(2, sizeof(unsigned));
    if (!decoder || !queue || !control) {
        if (decoder) adec_close(decoder);
        if (queue) data_queue_deinit(queue);
        if (control) msg_q_destroy(control);
        xsUnknownError("decoder benchmark allocation");
    }
    unsigned offset = 0, packets = 0, groups = 0, command = 0;
    int err = 0;
    TaskStatus_t before, after;
    vTaskDelay(1); vTaskGetInfo(NULL, &before, pdFALSE, eInvalid);
    int64_t began = esp_timer_get_time();
    while (offset + 2 <= bytes && !command && !err) {
        // Both variants receive the same burst of three already available packets.
        for (unsigned n = 0; n < 3 && offset + 2 <= bytes; n++) {
            const uint8_t *raw = buffer;
            unsigned size = raw[offset] | (raw[offset + 1] << 8); offset += 2;
            if (!size || size > 1275 || size > bytes - offset) { err = -101; break; }
            uint8_t *queued = data_queue_get_buffer(queue, size);
            if (!queued) { err = -102; break; }
            memcpy(queued, raw + offset, size); offset += size;
            if (data_queue_send_buffer(queue, size)) { err = -103; break; }
        }
        while (data_queue_have_data(queue) && !command && !err) {
            groups++;
            for (unsigned n = 0; n < batch && data_queue_have_data(queue); n++) {
                // Check cancellation BETWEEN packets in both variants.
                msg_q_recv(control, &command, sizeof(command), true);
                if (command) break;
                void *raw; int size;
                if (data_queue_read_lock(queue, &raw, &size)) { err = -104; break; }
                av_render_audio_data_t data = {.data = raw, .size = size, .pts = packets * 20};
                err = adec_decode(decoder, &data);
                data_queue_read_unlock(queue);
                packets++;
                if (cancelAfter && packets == cancelAfter) {
                    unsigned stop = 1; msg_q_send(control, &stop, sizeof(stop));
                }
            }
        }
    }
    int64_t elapsed = esp_timer_get_time() - began;
    vTaskDelay(1); vTaskGetInfo(NULL, &after, pdFALSE, eInvalid);
    data_queue_consume_all(queue);
    adec_close(decoder); data_queue_deinit(queue); msg_q_destroy(control);
    if (err) xsUnknownError("decoder benchmark %d", err);
    xsmcVars(1); xsmcSetNewObject(xsResult);
#define SET(name, value) xsmcSetNumber(xsVar(0), (double)(value)); xsmcSet(xsResult, xsID(name), xsVar(0))
    SET("packets", packets); SET("groups", groups); SET("samples", out.samples);
    SET("hash", out.hash); SET("frames", out.frames); SET("elapsedUs", elapsed);
    SET("cpuUs", after.ulRunTimeCounter - before.ulRunTimeCounter); SET("cancelled", command);
#undef SET
}
