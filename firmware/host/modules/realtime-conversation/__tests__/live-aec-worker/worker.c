#define _POSIX_C_SOURCE 200809L
#include "liveAecWorker.h"
#include <assert.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static pthread_t mainThread, task;
static void (*taskBody)(void *);
static void *taskContext;
static atomic_bool allowProcess, entered;
static atomic_uint emitted;
static unsigned lastFrame;
static int failTask, failAllocation;

void vTaskDelay(unsigned ticks) {
    struct timespec delay = {.tv_nsec = ticks * 1000000};
    nanosleep(&delay, NULL);
}
void vTaskDelete(void *unused) { assert(!unused); pthread_exit(NULL); }
static void *run(void *unused) { (void)unused; taskBody(taskContext); return NULL; }
int xTaskCreatePinnedToCore(void (*body)(void *), const char *name, unsigned stack,
                           void *context, unsigned priority, void *handle, int core) {
    (void)name; (void)stack; (void)handle; (void)core;
    // Processing must be preemptible by the independently configured XS/UI task.
    assert(priority < 4);
    if (failTask) return 0;
    taskBody = body; taskContext = context;
    assert(!pthread_create(&task, NULL, run, NULL));
    return 1;
}
void *heap_caps_calloc(size_t count, size_t size, unsigned caps) {
    (void)caps;
    if (failAllocation && !--failAllocation) return NULL;
    return calloc(count, size);
}
void *heap_caps_aligned_calloc(size_t align, size_t count, size_t size, unsigned caps) {
    (void)caps;
    if (failAllocation && !--failAllocation) return NULL;
    void *p = NULL;
    assert(!posix_memalign(&p, align, count * size));
    memset(p, 0, count * size);
    return p;
}
void aec_process(const aec_handle_t *aec, int16_t *mic, int16_t *ref, int16_t *clean) {
    assert(!pthread_equal(mainThread, pthread_self()));
    assert(!((uintptr_t)mic % 16) && !((uintptr_t)ref % 16) && !((uintptr_t)clean % 16));
    atomic_store(&entered, true);
    while (!atomic_load(&allowProcess)) vTaskDelay(1);
    for (unsigned i = 0; i < aec->count; i++) clean[i] = mic[i] - ref[i];
}
static void emit(void *context, const int16_t *mic, const int16_t *ref, int16_t *clean, size_t count) {
    assert(context == &lastFrame);
    assert((unsigned)ref[0] == ++lastFrame);
    for (unsigned i = 0; i < count; i++) assert(mic[i] - ref[i] == 100 && clean[i] == 100);
    atomic_fetch_add(&emitted, 1);
}
static void waitFor(atomic_uint *value, unsigned expected) {
    for (unsigned i = 0; i < 2000 && atomic_load(value) < expected; i++) vTaskDelay(1);
    assert(atomic_load(value) == expected);
}
static bool submit(LiveAecWorker *w, int frame) {
    int16_t mic[16], ref[16];
    for (unsigned i = 0; i < 16; i++) { mic[i] = 100 + frame; ref[i] = frame; }
    return liveAecWorkerSubmit(w, mic, ref);
}
int main(void) {
    mainThread = pthread_self();
    aec_handle_t aec = {.count = 16};
    LiveAecWorker *w = NULL;
    assert(liveAecWorkerOpen(&w, &aec, 7, emit, &lastFrame) && !w);
    for (failAllocation = 1; failAllocation <= 2;) {
        int failure = failAllocation;
        assert(liveAecWorkerOpen(&w, &aec, 16, emit, &lastFrame) && !w);
        failAllocation = failure + 1;
    }
    failAllocation = 0; failTask = 1;
    assert(liveAecWorkerOpen(&w, &aec, 16, emit, &lastFrame) && !w);
    failTask = 0;
    assert(!liveAecWorkerOpen(&w, &aec, 16, emit, &lastFrame));
    assert(submit(w, 1));
    for (unsigned i = 0; i < 2000 && !atomic_load(&entered); i++) vTaskDelay(1);
    assert(atomic_load(&entered));
    // The DSP is deliberately blocked. The audio-clock producer still returns,
    // preserves paired input copies, and rejects overflow without waiting.
    assert(submit(w, 2));
    assert(submit(w, 3));
    assert(!submit(w, 4));
    assert(!atomic_load(&emitted));
    atomic_store(&allowProcess, true);
    waitFor(&emitted, 3);
    bool accepted = false;
    for (unsigned i = 0; i < 2000 && !(accepted = submit(w, 4)); i++) vTaskDelay(1);
    assert(accepted);
    waitFor(&emitted, 4);
    liveAecWorkerClose(w);
    assert(!pthread_join(task, NULL));
    // New sessions cannot publish old queued audio or use released state.
    atomic_store(&emitted, 0); lastFrame = 0;
    assert(!liveAecWorkerOpen(&w, &aec, 16, emit, &lastFrame));
    assert(submit(w, 1));
    waitFor(&emitted, 1);
    liveAecWorkerClose(w);
    assert(!pthread_join(task, NULL));
    liveAecWorkerClose(NULL);
    return 0;
}
