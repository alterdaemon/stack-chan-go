// R14 diagnostic only. All state stays in RAM; no logs on audio timing paths.
#include "xsHost.h"
#include "xsmc.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_aec.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

extern void stackchanSPISetBlocking(bool enabled);
void xs_r14_spi_mode(xsMachine *the) { stackchanSPISetBlocking(xsmcToBoolean(xsArg(0))); }
static uint32_t taskCPU(TaskHandle_t task) {
    TaskStatus_t status;
    vTaskGetInfo(task, &status, pdFALSE, eInvalid);
    return status.ulRunTimeCounter;
}
void xs_r14_snapshot(xsMachine *the) {
    xsmcVars(1); xsmcSetNewObject(xsResult);
#define SET(name, value) xsmcSetNumber(xsVar(0), (double)(value)); xsmcSet(xsResult, xsID(name), xsVar(0))
    SET("atUs", esp_timer_get_time());
    const char *names[] = {"main", "spiLoop", "live_audio", "AUD_SRC", "aenc_0", "pc_send", "pc_task", "Adec", "ARender", "IDLE0", "IDLE1"};
    for (unsigned i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
        TaskHandle_t task = xTaskGetHandle(names[i]);
        if (task) { SET(names[i], taskCPU(task)); }
    }
    SET("internalFree", heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    SET("internalLargest", heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    SET("internalMinimum", heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    SET("psramFree", heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    SET("mainStack", uxTaskGetStackHighWaterMark(NULL));
#undef SET
}
void xs_r14_aec_bench(xsMachine *the) {
    bool internal = xsmcToBoolean(xsArg(0));
    aec_config_t config = {.mic_num = 1, .ref_num = 1, .out_num = 1,
        .filter_length = 4, .sample_rate = 16000,
        .caps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT,
        .mode = AEC_MODE_FD_LOW_COST, .nlp_level = AEC_NLP_LEVEL_AGGR};
    aec_handle_t *aec = aec_create_from_config(&config);
    if (!aec) xsUnknownError("AEC benchmark allocation failed");
    int chunk = aec_get_chunksize(aec);
    int16_t *planes = heap_caps_aligned_calloc(16, chunk * 3, sizeof(int16_t),
        (internal ? MALLOC_CAP_INTERNAL : MALLOC_CAP_SPIRAM) | MALLOC_CAP_8BIT);
    if (!planes) { aec_destroy(aec); xsUnknownError("AEC benchmark planes failed"); }
    int16_t *mic = planes, *ref = mic + chunk, *clean = ref + chunk;
    // Identical deterministic bounded input and state for every fresh run.
    uint32_t random = 42, checksum = 2166136261u;
    unsigned cpu = 0; int64_t elapsed = 0;
    for (unsigned frame = 0; frame < 48; frame++) {
        for (int i = 0; i < chunk; i++) {
            random = random * 1664525u + 1013904223u;
            ref[i] = ((int)(random >> 16) - 32768) / 8;
            mic[i] = ref[i] / 2 + ((i + frame) % 61) * 17;
        }
        vTaskDelay(1);
        uint32_t before = taskCPU(NULL);
        int64_t at = esp_timer_get_time();
        aec_process(aec, mic, ref, clean);
        int64_t duration = esp_timer_get_time() - at;
        vTaskDelay(1); // commit this task's running slice before reading its CPU counter
        unsigned service = taskCPU(NULL) - before;
        if (frame >= 8) { elapsed += duration; cpu += service; }
        for (int i = 0; i < chunk; i++) checksum = (checksum ^ (uint16_t)clean[i]) * 16777619u;
    }
    free(planes); aec_destroy(aec);
    xsmcVars(1); xsmcSetNewObject(xsResult);
#define SET(name, value) xsmcSetNumber(xsVar(0), (double)(value)); xsmcSet(xsResult, xsID(name), xsVar(0))
    SET("internal", internal); SET("chunk", chunk); SET("frames", 40);
    SET("cpuUs", cpu); SET("elapsedUs", elapsed); SET("checksum", checksum);
#undef SET
}
