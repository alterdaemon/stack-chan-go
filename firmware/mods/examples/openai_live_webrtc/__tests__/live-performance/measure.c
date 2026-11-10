// Device-only measurements. No task, timer, flash access or saved preferences.
#include "xsHost.h"
#include "xsmc.h"
#include "esp_timer.h"
#include <stdatomic.h>
#include <stdlib.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static atomic_uint ioMax[2], ioCount[2], aecMax, aecCount;
static atomic_uint spiRequests, spiBytes;
void stackchanProbeSPIRequest(unsigned bytes) {
    atomic_fetch_add(&spiRequests, 1);
    atomic_fetch_add(&spiBytes, bytes);
}
static int64_t ioLast[2], uiLast;
static unsigned uiMax, uiCount;
static int64_t frameAt;
static unsigned frameMax;
static TaskHandle_t spiTask;
static atomic_uint mainReady, mainBlocked, spiReady, spiBlocked;
static _Atomic(TaskHandle_t) watched[7];
static atomic_uint running[8];
void stackchanUIProgress(void *mainTask) {
    TaskHandle_t current = xTaskGetCurrentTaskHandleForCore(1);
    unsigned i;
    for (i = 0; i < 7 && current != atomic_load(&watched[i]); i++) {}
    atomic_fetch_add(&running[i], 1);
    eTaskState state = eTaskGetState(mainTask);
    if (state == eReady) atomic_fetch_add(&mainReady, 1);
    if (state == eBlocked) atomic_fetch_add(&mainBlocked, 1);
    if (spiTask) {
        state = eTaskGetState(spiTask);
        if (state == eReady) atomic_fetch_add(&spiReady, 1);
        if (state == eBlocked) atomic_fetch_add(&spiBlocked, 1);
    }
}
static const int16_t *input;
static unsigned inputCount, inputOffset;
static int64_t inputAt;
static atomic_bool injecting;
static atomic_bool syntheticMic;
void xs_live_probe_synthetic_mic(xsMachine *the) { atomic_store(&syntheticMic, xsmcToBoolean(xsArg(0))); }
static atomic_uint injectedSamples, inputPeak, sentPeak, sentSamples, probeUntil;
void stackchanAudioReset(void) {
    for (int i = 0; i < 2; i++) { ioLast[i] = 0; atomic_store(&ioMax[i], 0); atomic_store(&ioCount[i], 0); }
    atomic_store(&aecMax, 0); atomic_store(&aecCount, 0);
    atomic_store(&injecting, false);
    atomic_store(&injectedSamples, 0); atomic_store(&inputPeak, 0);
    atomic_store(&sentPeak, 0); atomic_store(&sentSamples, 0); atomic_store(&probeUntil, 0);
}
void stackchanAudioProgress(unsigned direction, int64_t at) {
    if (direction > 1) return;
    atomic_fetch_add(&ioCount[direction], 1);
    unsigned gap = ioLast[direction] ? at - ioLast[direction] : 0;
    ioLast[direction] = at;
    if (gap > atomic_load(&ioMax[direction])) atomic_store(&ioMax[direction], gap);
}
void stackchanProbeAEC(unsigned elapsed) {
    if (elapsed > atomic_load(&aecMax)) atomic_store(&aecMax, elapsed);
    atomic_fetch_add(&aecCount, 1);
}
void xs_io_reset(xsMachine *the) {
    uiLast = 0; uiMax = uiCount = 0;
    frameAt = 0; frameMax = 0;
    atomic_store(&spiRequests, 0); atomic_store(&spiBytes, 0);
    atomic_store(&mainReady, 0); atomic_store(&mainBlocked, 0);
    atomic_store(&spiReady, 0); atomic_store(&spiBlocked, 0);
    for (unsigned i = 0; i < 8; i++) atomic_store(&running[i], 0);
    for (int i = 0; i < 2; i++) { atomic_store(&ioMax[i], 0); atomic_store(&ioCount[i], 0); }
    atomic_store(&aecMax, 0); atomic_store(&aecCount, 0);
}
void xs_live_probe_input(xsMachine *the) {
    if (atomic_load(&injecting)) return;
    void *data; xsUnsignedValue bytes;
    xsmcGetBufferReadable(xsArg(0), &data, &bytes);
    input = data; inputCount = bytes / 2; inputOffset = 0;
    inputAt = (xsmcArgc > 1 && xsmcToBoolean(xsArg(1))) ? esp_timer_get_time() : -1;
    // Default: start two seconds after playback; optional immediate injection tests silence VAD.
    atomic_store(&injecting, true);
}
// Device test only: add a known voice clip before AEC, with real playback
// reference and real encoding/networking. This is not an acoustic mic test.
void stackchanProbeInput(int16_t *samples, unsigned count, unsigned playbackLevel) {
    if (atomic_load(&syntheticMic)) for (unsigned i = 0; i < count; i++) samples[i * 2] = 0;
    if (!atomic_load(&injecting)) return;
    int64_t now = esp_timer_get_time();
    if (inputAt < 0) {
        if (playbackLevel > 200) inputAt = now + 2000000;
        return;
    }
    if (now < inputAt) return;
    if (!inputOffset) atomic_store(&probeUntil, (unsigned)(now / 1000) + inputCount / 16 + 2000);
    for (unsigned i = 0; i < count && inputOffset < inputCount; i++) {
        int sample = input[inputOffset++];
        if (abs(sample) > atomic_load(&inputPeak)) atomic_store(&inputPeak, abs(sample));
        atomic_fetch_add(&injectedSamples, 1);
        int value = samples[i * 2] + sample;
        samples[i * 2] = value > 32767 ? 32767 : value < -32768 ? -32768 : value;
    }
    if (inputOffset == inputCount) atomic_store(&injecting, false);
}
void stackchanProbeCaptureOutput(const int16_t *samples, unsigned count) {
    unsigned until = atomic_load(&probeUntil), now = esp_timer_get_time() / 1000;
    if (!until || (int32_t)(until - now) <= 0) return;
    unsigned peak = atomic_load(&sentPeak);
    for (unsigned i = 0; i < count; i++) if (abs(samples[i]) > peak) peak = abs(samples[i]);
    atomic_store(&sentPeak, peak); atomic_fetch_add(&sentSamples, count);
}
void xs_io_mark(xsMachine *the) {
    int64_t now = esp_timer_get_time();
    int kind = xsmcToInteger(xsArg(0));
    if (kind == 1) { frameAt = now; return; }
    if (kind == 2) {
        if (frameAt && now - frameAt > frameMax) frameMax = now - frameAt;
        frameAt = 0; return;
    }
    if (uiLast && now - uiLast > uiMax) uiMax = now - uiLast;
    uiLast = now; uiCount++;
}
void xs_io_stats(xsMachine *the) {
    xsmcVars(1); xsmcSetNewObject(xsResult);
#define SET(name, value) xsmcSetInteger(xsVar(0), value); xsmcSet(xsResult, xsID(name), xsVar(0))
    SET("uiCore", xPortGetCoreID()); SET("uiAffinity", xTaskGetCoreID(xTaskGetCurrentTaskHandle()));
    SET("uiPriority", uxTaskPriorityGet(NULL));
    SET("frameMaxUs", frameMax);
    SET("spiRequests", atomic_load(&spiRequests)); SET("spiBytes", atomic_load(&spiBytes));
    SET("mainReady", atomic_load(&mainReady)); SET("mainBlocked", atomic_load(&mainBlocked));
    SET("spiReady", atomic_load(&spiReady)); SET("spiBlocked", atomic_load(&spiBlocked));
    SET("spiAffinity", spiTask ? xTaskGetCoreID(spiTask) : -2);
    SET("spiPriority", spiTask ? uxTaskPriorityGet(spiTask) : 0);
    SET("runMain", atomic_load(&running[0])); SET("runI2S", atomic_load(&running[1]));
    SET("runEncoder", atomic_load(&running[2])); SET("runSend", atomic_load(&running[3]));
    SET("runPeer", atomic_load(&running[4])); SET("runDecoder", atomic_load(&running[5]));
    SET("runRenderer", atomic_load(&running[6])); SET("runOther", atomic_load(&running[7]));
    SET("ioWrites", atomic_load(&ioCount[0])); SET("ioReads", atomic_load(&ioCount[1]));
    SET("uiMaxUs", uiMax); SET("uiTicks", uiCount);
    SET("writeMaxUs", atomic_load(&ioMax[0])); SET("readMaxUs", atomic_load(&ioMax[1]));
    SET("aecMaxUs", atomic_load(&aecMax)); SET("aecCalls", atomic_load(&aecCount));
    SET("injectedSamples", atomic_load(&injectedSamples)); SET("inputPeak", atomic_load(&inputPeak));
    SET("sentPeak", atomic_load(&sentPeak)); SET("sentSamples", atomic_load(&sentSamples));
#undef SET
}

void xs_live_probe_measure(xsMachine *the) { spiTask = xTaskGetHandle("spiLoop"); xs_io_reset(the); }
void xs_live_probe_budget(xsMachine *the) {
    unsigned boost = xsmcToInteger(xsArg(0)), spi = xsmcToInteger(xsArg(1));
    unsigned idle = xsmcToInteger(xsArg(2)), touch = xsmcToInteger(xsArg(3));
    if (boost < 6 || boost > 21 || spi <= boost || spi > 22 || !idle || idle > touch || touch > 12000)
        xsRangeError("invalid probe budget");
    extern void stackchanProbeUIBudget(unsigned boost, unsigned spi, unsigned idle, unsigned touch);
    stackchanProbeUIBudget(boost, spi, idle, touch);
}
void xs_live_probe_tasks(xsMachine *the) {
    const char *names[] = {"main", "live_audio", "aenc_0", "pc_send", "pc_task", "Adec", "ARender"};
    for (unsigned i = 0; i < 7; i++) atomic_store(&watched[i], xTaskGetHandle(names[i]));
}
