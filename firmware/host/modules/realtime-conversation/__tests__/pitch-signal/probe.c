// Offline device signal test: uses the actual Espressif DSP, no API or I2S.
#include "xsHost.h"
#include "xsmc.h"
#include "../../esp32/livePitch.h"
#include "esp_timer.h"
#include <math.h>

typedef struct { unsigned samples; } Tone;
static size_t tone(void *context, int16_t *output, size_t count) {
    Tone *t = context;
    for (size_t i = 0; i < count; i++, t->samples++)
        output[i] = (int16_t)(8000 * sin(2 * 3.141592653589793 * 220 * t->samples / 48000));
    return count;
}
void xs_live_pitch_probe(xsMachine *the) {
    int semitones = xsmcToInteger(xsArg(0));
    LivePitch *p = NULL;
    int err = livePitchOpen(&p, semitones);
    if (err) xsUnknownError("pitch open failed: %d", err);
    Tone source = {0};
    int16_t output[480], previous = 0;
    unsigned crossings = 0;
    int64_t maxUs = 0;
    for (unsigned block = 0; block < 300; block++) {
        LivePitchResult result;
        int64_t start = esp_timer_get_time();
        if (p) err = livePitchRender(p, tone, &source, output, 480, &result);
        else tone(&source, output, 480);
        int64_t elapsed = esp_timer_get_time() - start;
        if (elapsed > maxUs) maxUs = elapsed;
        if (err) break;
        for (unsigned i = 0; i < 480; i++) {
            if (block >= 200 && previous <= 0 && output[i] > 0) crossings++;
            previous = output[i];
        }
    }
    livePitchClose(p);
    if (err) xsUnknownError("pitch render failed: %d", err);
    xsmcVars(1);
    xsmcSetNewObject(xsResult);
    xsmcSetInteger(xsVar(0), crossings); xsmcSet(xsResult, xsID("frequency"), xsVar(0));
    xsmcSetInteger(xsVar(0), source.samples); xsmcSet(xsResult, xsID("inputSamples"), xsVar(0));
    xsmcSetNumber(xsVar(0), maxUs); xsmcSet(xsResult, xsID("maxProcessUs"), xsVar(0));
}
