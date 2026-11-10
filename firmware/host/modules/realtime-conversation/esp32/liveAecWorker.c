// SPDX-License-Identifier: Apache-2.0
#include "liveAecWorker.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_heap_caps.h"
#include "esp_err.h"
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#define SLOTS 4
struct LiveAecWorker {
    aec_handle_t *aec;
    LiveAecEmit emit;
    void *context;
    int16_t *samples;
    size_t count;
    atomic_uint head, tail;
    atomic_bool stopping, done;
    bool started;
};

static void aecTask(void *context)
{
    LiveAecWorker *w = context;
    while (!atomic_load(&w->stopping)) {
        unsigned tail = atomic_load_explicit(&w->tail, memory_order_relaxed);
        if (tail == atomic_load_explicit(&w->head, memory_order_acquire)) {
            vTaskDelay(1);
            continue;
        }
        int16_t *mic = w->samples + tail * w->count * 3;
        int16_t *ref = mic + w->count, *clean = ref + w->count;
        aec_process(w->aec, mic, ref, clean);
        w->emit(w->context, mic, ref, clean, w->count);
        atomic_store_explicit(&w->tail, (tail + 1) % SLOTS, memory_order_release);
    }
    atomic_store(&w->done, true);
    vTaskDelete(NULL);
}

int liveAecWorkerOpen(LiveAecWorker **out, aec_handle_t *aec, size_t count,
                     LiveAecEmit emit, void *context)
{
    *out = NULL;
    // ESP-SR requires each PCM plane to be 16-byte aligned.
    if (!aec || !emit || !count || count > 2048 || count % 8) return ESP_ERR_INVALID_ARG;
    LiveAecWorker *w = heap_caps_calloc(1, sizeof(*w), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!w) return ESP_ERR_NO_MEM;
    w->aec = aec; w->emit = emit; w->context = context; w->count = count;
    w->samples = heap_caps_aligned_calloc(16, SLOTS * count * 3, sizeof(int16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!w->samples) { liveAecWorkerClose(w); return ESP_ERR_NO_MEM; }
    // Moddable's main/XS task has priority 4. Keep full-duplex AEC below it;
    // the priority-20 I2S task only queues paired mic/reference frames.
    if (xTaskCreatePinnedToCore(aecTask, "live_aec", 8192, w, 3, NULL, 0) != pdPASS) {
        liveAecWorkerClose(w);
        return ESP_ERR_NO_MEM;
    }
    w->started = true;
    *out = w;
    return 0;
}

bool liveAecWorkerSubmit(LiveAecWorker *w, const int16_t *mic, const int16_t *ref)
{
    unsigned head = atomic_load_explicit(&w->head, memory_order_relaxed);
    unsigned next = (head + 1) % SLOTS;
    if (next == atomic_load_explicit(&w->tail, memory_order_acquire)) return false;
    int16_t *slot = w->samples + head * w->count * 3;
    memcpy(slot, mic, w->count * sizeof(int16_t));
    memcpy(slot + w->count, ref, w->count * sizeof(int16_t));
    atomic_store_explicit(&w->head, next, memory_order_release);
    return true;
}

void liveAecWorkerClose(LiveAecWorker *w)
{
    if (!w) return;
    atomic_store(&w->stopping, true);
    while (w->started && !atomic_load(&w->done)) vTaskDelay(1);
    free(w->samples);
    free(w);
}
