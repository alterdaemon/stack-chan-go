#include "platform.h"
#include <assert.h>
#include <string.h>
static double scalar;
static unsigned audible;
static bool suppressed;
#undef xsmcSetInteger
#undef xsmcSetNumber
#undef xsmcSetBoolean
#undef xsmcSet
#define xsID(name) name
#define xsmcSetInteger(target, value) (scalar = (value))
#define xsmcSetNumber(target, value) (scalar = (value))
#define xsmcSetBoolean(target, value) (scalar = (value))
static void record(const char *key) {
    if (!strcmp(key, "audibleMs")) audible = scalar;
    if (!strcmp(key, "outputSuppressed")) suppressed = scalar;
}
#define xsmcSet(target, key, value) record(key)
#include "../../esp32/liveAudio.c"

int main(void) {
    xs_io_audio_levels(NULL);
    assert(audible == 0 && suppressed);
    LiveAudio audio = {0};
    activeAudio = &audio;
    atomic_store(&audio.audibleMs, 0xFFFFFFFFu);
    xs_io_audio_levels(NULL);
    assert(audible == 0xFFFFFFFFu && !suppressed);
    atomic_store(&audio.yieldOutput, true);
    xs_io_audio_levels(NULL);
    assert(suppressed);
    atomic_store(&audio.yieldOutput, false);
    atomic_store(&audio.discardOutput, true);
    xs_io_audio_levels(NULL);
    assert(suppressed);
    atomic_store(&audio.discardOutput, false);
    atomic_store(&audio.quiesced, true);
    xs_io_audio_levels(NULL);
    assert(suppressed);
    return 0;
}
