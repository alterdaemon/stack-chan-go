// R14 experiments only. Bounded counters, no persisted state or timing-path logs.
#include "r14-config.h"
#include "xsHost.h"
#include "xsmc.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <string.h>
#include <stdlib.h>

unsigned r14Rate = 48000, r14DMA = 3, r14Internal, r14MeterEvery = 1, r14MeterFrame;
unsigned r14Priming, r14StallUs, r14StallEvery, r14FeedSample;
atomic_bool r14Tail;
void *r14LocalAudio;
atomic_uint r14SPIBytes;
static atomic_uint rxEvents, rxOverflows, txEvents, txOverflows;
static atomic_uint allocations, allocatedBytes, frees;
static atomic_bool countAllocations;
static atomic_uint blockedPreferences;
static unsigned ticks;
static atomic_uint maxTickGap, received, outputHash, emptyReads, maxQueue, firstRead;
static int64_t lastTick;
static int callbackError;
static bool localHeapMinimum;

void xs_r14_block_preference(xsMachine *the) {
    atomic_fetch_add(&blockedPreferences, 1);
    xsUnknownError("diagnostic_preference_write_blocked");
}
void xs_r14_blocked_preferences(xsMachine *the) {
    xsmcSetInteger(xsResult, atomic_load(&blockedPreferences));
}

// ESP-IDF optional heap hooks; this manifest alone enables them.
void esp_heap_trace_alloc_hook(void *ptr, size_t size, uint32_t caps) {
    if (ptr && atomic_load(&countAllocations)) {
        atomic_fetch_add(&allocations, 1);
        atomic_fetch_add(&allocatedBytes, size);
    }
}
void esp_heap_trace_free_hook(void *ptr) {
    if (ptr && atomic_load(&countAllocations)) atomic_fetch_add(&frees, 1);
}
static bool onRX(i2s_chan_handle_t channel, i2s_event_data_t *event, void *ctx) {
    atomic_fetch_add(&rxEvents, 1); return false;
}
static bool onRXOverflow(i2s_chan_handle_t channel, i2s_event_data_t *event, void *ctx) {
    atomic_fetch_add(&rxOverflows, 1); return false;
}
static bool onTX(i2s_chan_handle_t channel, i2s_event_data_t *event, void *ctx) {
    atomic_fetch_add(&txEvents, 1); return false;
}
static bool onTXOverflow(i2s_chan_handle_t channel, i2s_event_data_t *event, void *ctx) {
    atomic_fetch_add(&txOverflows, 1); return false;
}
void r14RegisterAudio(i2s_chan_handle_t tx, i2s_chan_handle_t rx) {
    if (!tx || !rx) return;
    i2s_event_callbacks_t receive = {.on_recv = onRX, .on_recv_q_ovf = onRXOverflow};
    i2s_event_callbacks_t send = {.on_sent = onTX, .on_send_q_ovf = onTXOverflow};
    callbackError = i2s_channel_register_event_callback(rx, &receive, NULL);
    if (!callbackError) callbackError = i2s_channel_register_event_callback(tx, &send, NULL);
}
void r14AudioTick(i2s_chan_handle_t tx, i2s_chan_handle_t rx) {
    int64_t now = esp_timer_get_time();
    unsigned gap = lastTick ? now - lastTick : 0;
    if (gap > atomic_load(&maxTickGap)) atomic_store(&maxTickGap, gap);
    lastTick = now;
    if (r14StallEvery && ++ticks % r14StallEvery == 0)
        vTaskDelay(pdMS_TO_TICKS((r14StallUs + 999) / 1000));
}
void r14OutputRead(unsigned available, unsigned got, const int16_t *samples, unsigned requested) {
    if (available > atomic_load(&maxQueue)) atomic_store(&maxQueue, available);
    if (!got) atomic_fetch_add(&emptyReads, 1);
    if (got && !atomic_load(&firstRead)) atomic_store(&firstRead, esp_timer_get_time());
    unsigned hash = atomic_load(&outputHash);
    for (unsigned i = 0; i < got / 2; i++) hash = (hash ^ (uint16_t)samples[i]) * 16777619u;
    atomic_store(&outputHash, hash);
    atomic_fetch_add(&received, got);
}
void xs_r14_rate(xsMachine *the) { xsmcSetInteger(xsResult, r14Rate); }
void xs_r14_tail(xsMachine *the) { atomic_store(&r14Tail, xsmcToBoolean(xsArg(0))); }
void xs_r14_configure(xsMachine *the) {
    if (r14LocalAudio) xsUnknownError("close local audio before configuration");
    unsigned rate = xsmcToInteger(xsArg(0)), dma = xsmcToInteger(xsArg(1));
    if ((rate != 24000 && rate != 48000) || dma < 3 || dma > 6) xsRangeError("diagnostic configuration");
    r14Rate = rate; r14DMA = dma; r14Internal = xsmcToBoolean(xsArg(2));
    r14MeterEvery = xsmcToInteger(xsArg(3)); r14Priming = xsmcToInteger(xsArg(4));
    r14StallUs = xsmcToInteger(xsArg(5)); r14StallEvery = xsmcToInteger(xsArg(6));
    if (!r14MeterEvery || r14MeterEvery > 10 || r14Priming > 60 || r14StallUs > 60000 || r14StallEvery > 1000)
        xsRangeError("diagnostic bounds");
    r14Tail = false; r14FeedSample = 0; r14MeterFrame = 0;
}
void xs_r14_counters_reset(xsMachine *the) {
    if (localHeapMinimum) heap_caps_monitor_local_minimum_free_size_stop();
    localHeapMinimum = heap_caps_monitor_local_minimum_free_size_start() == 0;
    atomic_store(&countAllocations, false);
    atomic_store(&rxEvents, 0); atomic_store(&txEvents, 0);
    atomic_store(&rxOverflows, 0); atomic_store(&txOverflows, 0);
    atomic_store(&allocations, 0); atomic_store(&allocatedBytes, 0); atomic_store(&frees, 0);
    atomic_store(&r14SPIBytes, 0);
    ticks = maxTickGap = received = emptyReads = maxQueue = 0;
    outputHash = 2166136261u; lastTick = firstRead = 0;
    atomic_store(&countAllocations, true);
}
void xs_r14_counters(xsMachine *the) {
    unsigned allocationCount = atomic_load(&allocations), bytes = atomic_load(&allocatedBytes), freeCount = atomic_load(&frees);
    xsmcVars(1); xsmcSetNewObject(xsResult);
#define SET(name, value) xsmcSetNumber(xsVar(0), (double)(value)); xsmcSet(xsResult, xsID(name), xsVar(0))
    SET("atUs", esp_timer_get_time());
    SET("rxEvents", atomic_load(&rxEvents)); SET("rxQueueOverflows", atomic_load(&rxOverflows));
    SET("txEvents", atomic_load(&txEvents)); SET("txQueueOverflows", atomic_load(&txOverflows));
    SET("callbackError", callbackError); SET("maxTickGapUs", maxTickGap);
    SET("receivedBytes", received); SET("outputHash", outputHash); SET("emptyReads", emptyReads);
    SET("maxQueueBytes", maxQueue); SET("firstDequeuedUs", firstRead);
    SET("allocations", allocationCount); SET("allocatedBytes", bytes); SET("frees", freeCount);
    SET("spiBytes", atomic_load(&r14SPIBytes));
    SET("localHeapMinimum", localHeapMinimum);
#undef SET
}
void xs_r14_tasks(xsMachine *the) {
    // Fixed capacity, outside timed work. No growing task history.
    TaskStatus_t *states = heap_caps_malloc(sizeof(TaskStatus_t) * 48, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!states) xsUnknownError("task snapshot allocation");
    uint32_t total;
    unsigned count = uxTaskGetSystemState(states, 48, &total);
    xsmcVars(2); xsmcSetNewArray(xsResult, count);
    for (unsigned i = 0; i < count; i++) {
        xsmcSetNewObject(xsVar(0));
#define SET(name, value) xsmcSetNumber(xsVar(1), (double)(value)); xsmcSet(xsVar(0), xsID(name), xsVar(1))
        xsmcSetString(xsVar(1), (char *)states[i].pcTaskName); xsmcSet(xsVar(0), xsID("name"), xsVar(1));
        SET("cpuUs", states[i].ulRunTimeCounter); SET("stackFree", states[i].usStackHighWaterMark);
        SET("priority", states[i].uxCurrentPriority);
        xsmcSetIndex(xsResult, i, xsVar(0));
#undef SET
    }
    free(states);
}
