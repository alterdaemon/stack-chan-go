// SPDX-License-Identifier: Apache-2.0
#ifndef MOD_LIVE_AEC_WORKER_H
#define MOD_LIVE_AEC_WORKER_H
#include "esp_aec.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct LiveAecWorker LiveAecWorker;
typedef void (*LiveAecEmit)(void *context, const int16_t *mic, const int16_t *ref,
                            int16_t *clean, size_t count);
// The caller owns aec and must keep it alive until Close returns.
int liveAecWorkerOpen(LiveAecWorker **out, aec_handle_t *aec, size_t count,
                     LiveAecEmit emit, void *context);
// Audio-clock producer: copies a paired frame, never waits or runs AEC.
// A full queue rejects the new frame without overwriting one in processing.
bool liveAecWorkerSubmit(LiveAecWorker *worker, const int16_t *mic, const int16_t *ref);
void liveAecWorkerClose(LiveAecWorker *worker);
#endif
