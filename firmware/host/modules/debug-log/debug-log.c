// SPDX-License-Identifier: Apache-2.0
#include "xsmc.h"
#include "xsHost.h"
#include "esp_timer.h"
#include "esp_app_desc.h"
#include "esp_system.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "debug-log.h"
#include <stdatomic.h>
#include <stdbool.h>
#include <math.h>

#define DEBUG_NATIVE_COUNT 32
typedef struct { double ms; unsigned seq, event, request; int value, result; } DebugEvent;
static DebugEvent records[DEBUG_NATIVE_COUNT];
static portMUX_TYPE debugLock = portMUX_INITIALIZER_UNLOCKED;
static atomic_bool enabled;
static unsigned head, count, sequence, dropped;

void xs_device_debug_available(xsMachine *the) {
#ifdef mxDebug
    xsmcSetBoolean(xsResult, false);
#else
    xsmcSetBoolean(xsResult, true);
#endif
}

void stackchanDebugNative(unsigned event, unsigned request, int value, int result) {
    if (!atomic_load(&enabled)) return;
    portENTER_CRITICAL(&debugLock);
    if (atomic_load(&enabled)) {
        unsigned seq = ++sequence;
        if (count == DEBUG_NATIVE_COUNT) dropped++;
        else {
            records[(head + count) % DEBUG_NATIVE_COUNT] = (DebugEvent){
                esp_timer_get_time() / 1000.0, seq, event, request, value, result};
            count++;
        }
    }
    portEXIT_CRITICAL(&debugLock);
}
void xs_device_debug_tune(xsMachine *the) {
    unsigned parameter = xsmcToInteger(xsArg(0)), value = xsmcToInteger(xsArg(1));
    if (!atomic_load(&enabled)) xsUnknownError("Diagnostics are disabled");
    if (!stackchanAudioDebugSet || stackchanAudioDebugSet(parameter, value)) xsUnknownError("Invalid audio trial");
}
void xs_device_debug_enable(xsMachine *the) {
    bool value = xsmcToBoolean(xsArg(0));
    portENTER_CRITICAL(&debugLock);
    atomic_store(&enabled, value);
    head = count = dropped = 0;
    portEXIT_CRITICAL(&debugLock);
    if (!value && stackchanAudioDebugSet) stackchanAudioDebugSet(DEBUG_TUNE_RESET, 0);
}
void xs_device_debug_now(xsMachine *the) { xsmcSetNumber(xsResult, esp_timer_get_time() / 1000.0); }
void xs_device_debug_stamp(xsMachine *the) {
    portENTER_CRITICAL(&debugLock);
    unsigned seq = ++sequence;
    double ms = esp_timer_get_time() / 1000.0;
    portEXIT_CRITICAL(&debugLock);
    xsmcVars(1);
    xsmcSetNewObject(xsResult);
    xsmcSetNumber(xsVar(0), ms); xsmcSet(xsResult, xsID("ms"), xsVar(0));
    xsmcSetNumber(xsVar(0), seq); xsmcSet(xsResult, xsID("seq"), xsVar(0));
}
void xs_device_debug_read(xsMachine *the) {
    DebugEvent event;
    portENTER_CRITICAL(&debugLock);
    bool present = count != 0;
    if (present) { event = records[head]; head = (head + 1) % DEBUG_NATIVE_COUNT; count--; }
    portEXIT_CRITICAL(&debugLock);
    if (!present) return;
    xsmcVars(1); xsmcSetNewObject(xsResult);
#define FIELD(name, value) xsmcSetNumber(xsVar(0), value); xsmcSet(xsResult, xsID(name), xsVar(0))
    FIELD("ms", event.ms); FIELD("seq", event.seq); FIELD("code", event.event);
    FIELD("request", event.request); FIELD("value", event.value); FIELD("result", event.result);
#undef FIELD
}
void xs_device_debug_info(xsMachine *the) {
    const esp_app_desc_t *app = esp_app_get_description();
    char hash[65];
    const char digits[] = "0123456789abcdef";
    for (unsigned i = 0; i < 32; i++) { hash[i*2] = digits[app->app_elf_sha256[i] >> 4]; hash[i*2+1] = digits[app->app_elf_sha256[i] & 15]; }
    hash[64] = 0;
    xsmcVars(1); xsmcSetNewObject(xsResult);
#define NUMBER(name, value) xsmcSetNumber(xsVar(0), value); xsmcSet(xsResult, xsID(name), xsVar(0))
    NUMBER("freeHeap", heap_caps_get_free_size(MALLOC_CAP_8BIT));
    NUMBER("freeInternalHeap", heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    NUMBER("minimumHeap", heap_caps_get_minimum_free_size(MALLOC_CAP_8BIT));
    NUMBER("resetReason", esp_reset_reason());
    portENTER_CRITICAL(&debugLock); unsigned lost = dropped; portEXIT_CRITICAL(&debugLock);
    NUMBER("nativeDropped", lost);
    if (stackchanAudioDebugGet) {
      NUMBER("speaker", stackchanAudioDebugGet(DEBUG_TUNE_SPEAKER) / 1024.0);
      NUMBER("captureDb", 20 * log10(stackchanAudioDebugGet(DEBUG_TUNE_CAPTURE) / 1024.0));
      NUMBER("nlp", stackchanAudioDebugGet(DEBUG_TUNE_NLP));
    }
#undef NUMBER
    xsmcSetString(xsVar(0), hash); xsmcSet(xsResult, xsID("app_sha256"), xsVar(0));
    xsmcSetString(xsVar(0), app->idf_ver); xsmcSet(xsResult, xsID("sdk"), xsVar(0));
}
