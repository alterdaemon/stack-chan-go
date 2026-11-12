#include "livePitch.h"
#include "esp_ae_sonic.h"
#include <assert.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

static int opens, closes, failure;
static float selectedPitch;
typedef struct { int16_t data[4096]; unsigned count; } Fake;
int esp_ae_sonic_open(esp_ae_sonic_cfg_t *config, esp_ae_sonic_handle_t *out) {
    assert(config->channel == 1 && config->bits_per_sample == 16);
    assert(config->sample_rate == 16000);
    *out = calloc(1, sizeof(Fake)); opens++;
    return *out ? 0 : ESP_AE_ERR_MEM_LACK;
}
int esp_ae_sonic_set_speed(esp_ae_sonic_handle_t handle, float speed) {
    assert(handle && speed == 1.0f); return 0;
}
int esp_ae_sonic_set_pitch(esp_ae_sonic_handle_t handle, float pitch) {
    assert(handle); selectedPitch = pitch; return failure == 1 ? -1 : 0;
}
int esp_ae_sonic_process(esp_ae_sonic_handle_t handle, esp_ae_sonic_in_data_t *in, esp_ae_sonic_out_data_t *out) {
    Fake *f = handle;
    if (failure == 2) return -1;
    if (failure == 3) return 0; // No progress must fail instead of hanging the audio clock.
    if (failure == 4) { in->consume_num = in->num + 1; return 0; }
    if (failure == 5) { out->out_num = out->needed_num + 1; return 0; }
    // Alternate partial consumption with output from the internal cache. Delay
    // output by two blocks, exercising Sonic's buffering and unconsumed input.
    unsigned available = f->count > 320 ? f->count - 320 : 0;
    if (!available) {
        in->consume_num = in->num < 137 ? in->num : 137;
        assert(f->count + in->consume_num <= 4096);
        memcpy(f->data + f->count, in->samples, in->consume_num * 2);
        f->count += in->consume_num;
        available = f->count > 320 ? f->count - 320 : 0;
    }
    out->out_num = available < out->needed_num ? available : out->needed_num;
    memcpy(out->samples, f->data, out->out_num * 2);
    f->count -= out->out_num;
    memmove(f->data, f->data + out->out_num, f->count * 2);
    return 0;
}
void esp_ae_sonic_close(esp_ae_sonic_handle_t handle) { closes++; free(handle); }
int esp_ae_sonic_reset(esp_ae_sonic_handle_t handle) {
    if (failure == 6) return -1;
    ((Fake *)handle)->count = 0;
    return 0;
}

typedef struct { unsigned position, limit, received; } Source;
static size_t readSource(void *context, int16_t *samples, size_t count) {
    Source *s = context;
    if (count > s->limit - s->position) count = s->limit - s->position;
    for (size_t i = 0; i < count; i++) samples[i] = 1 + s->position++ % 10000;
    s->received += count;
    return count;
}
int main(void) {
    LivePitch *p = NULL;
    assert(!livePitchOpen(&p, 0) && !p && !opens);
    assert(livePitchOpen(&p, 7) && !p && !opens);
    assert(!livePitchOpen(&p, 6));
    float up = selectedPitch;
    livePitchClose(p);
    assert(!livePitchOpen(&p, -6));
    assert(fabsf(up * selectedPitch - 1.0f) < 0.0001f);
    assert(fabsf(up / selectedPitch - 2.0f) < 0.0001f);
    Source source = {.limit = 2000};
    int16_t output[160];
    unsigned position = 0, received = 0;
    bool missing = false;
    for (unsigned block = 0; block < 30; block++) {
        LivePitchResult result;
        assert(!livePitchRender(p, readSource, &source, output, 160, &result));
        received += result.received; missing |= result.missing;
        for (unsigned i = 0; i < 160; i++, position++)
            assert(output[i] == (int16_t)(position < source.limit ? 1 + position % 10000 : 0));
    }
    assert(missing && received == source.received && received == source.limit);
    // Reset a live processor with both internal cache and partial input. Its
    // next output must contain only the next source, without closing Sonic.
    source = (Source){.limit = 2000};
    LivePitchResult resetResult;
    assert(!livePitchRender(p, readSource, &source, output, 160, &resetResult));
    assert(!livePitchReset(p));
    source = (Source){0};
    assert(!livePitchRender(p, readSource, &source, output, 160, &resetResult));
    for (unsigned i = 0; i < 160; i++) assert(output[i] == 0);
    failure = 6;
    assert(livePitchReset(p));
    failure = 0;
    assert(!livePitchReset(NULL));
    // No earlier session's buffered samples may survive closing/reopening.
    livePitchClose(p);
    assert(!livePitchOpen(&p, 2));
    source = (Source){0};
    LivePitchResult result;
    assert(!livePitchRender(p, readSource, &source, output, 160, &result));
    for (unsigned i = 0; i < 160; i++) assert(output[i] == 0);
    for (failure = 2; failure <= 5; failure++)
        assert(livePitchRender(p, readSource, &source, output, 160, &result) != 0);
    livePitchClose(p);
    failure = 1;
    assert(livePitchOpen(&p, 3) && !p);
    assert(opens == closes);
    livePitchClose(NULL);
    return 0;
}
