#include "../../esp32/liveAudio.c"
#include <assert.h>
#include <pthread.h>

struct Stream { uint8_t data[PLAYBACK_BYTES * 4]; size_t capacity, head, count; };
struct LivePitch { int cached; };
static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t changed = PTHREAD_COND_INITIALIZER;
static _Thread_local unsigned role;
static unsigned cycles, permitted, flushCalls, resetCalls;
static bool writerDone, flushDone;
static int16_t played[1600];
static LiveAudio *session;

static void permit(unsigned target) {
    pthread_mutex_lock(&mutex);
    permitted = target;
    pthread_cond_broadcast(&changed);
    while (cycles < target) pthread_cond_wait(&changed, &mutex);
    pthread_mutex_unlock(&mutex);
}
size_t xStreamBufferReceive(StreamBufferHandle_t s, void *out, size_t bytes, unsigned wait) {
    assert(role == 20 && !wait);
    pthread_mutex_lock(&mutex);
    if (bytes > s->count) bytes = s->count;
    for (size_t i = 0; i < bytes; i++) ((uint8_t *)out)[i] = s->data[(s->head + i) % s->capacity];
    s->head = (s->head + bytes) % s->capacity; s->count -= bytes;
    pthread_cond_broadcast(&changed);
    pthread_mutex_unlock(&mutex);
    return bytes;
}
size_t xStreamBufferSend(StreamBufferHandle_t s, const void *in, size_t bytes, unsigned wait) {
    pthread_mutex_lock(&mutex);
    while (wait && s->count == s->capacity && !atomic_load(&session->discardOutput))
        pthread_cond_wait(&changed, &mutex);
    if (bytes > s->capacity - s->count) bytes = s->capacity - s->count;
    for (size_t i = 0; i < bytes; i++) s->data[(s->head + s->count + i) % s->capacity] = ((const uint8_t *)in)[i];
    s->count += bytes;
    pthread_mutex_unlock(&mutex);
    return bytes;
}
size_t xStreamBufferSpacesAvailable(StreamBufferHandle_t s) { return s->capacity - s->count; }
int livePitchReset(LivePitch *p) { assert(role == 20); resetCalls++; if (p) p->cached = 0; return 0; }
int livePitchRender(LivePitch *p, LivePitchRead read, void *ctx, int16_t *out, size_t n, LivePitchResult *r) {
    size_t got = read(ctx, out, n);
    memset(out + got, 0, (n - got) * 2);
    if (p->cached) { out[0] = p->cached; p->cached = 0; }
    *r = (LivePitchResult){.received = got, .missing = got < n};
    return 0;
}
int i2s_channel_write(i2s_chan_handle_t h, const void *data, size_t bytes, size_t *written, uint32_t timeout) {
    assert(role == 20 && bytes == BLOCK * 4);
    pthread_mutex_lock(&mutex);
    assert(cycles < 1600); played[cycles] = ((const int16_t *)data)[0];
    pthread_mutex_unlock(&mutex);
    *written = bytes; return 0;
}
int i2s_channel_read(i2s_chan_handle_t h, void *data, size_t bytes, size_t *received, uint32_t timeout) {
    pthread_mutex_lock(&mutex);
    while (cycles >= permitted && !atomic_load(&session->stopping)) pthread_cond_wait(&changed, &mutex);
    cycles++;
    memset(data, 0, bytes); *received = bytes;
    pthread_cond_broadcast(&changed);
    pthread_mutex_unlock(&mutex);
    return 0;
}
int esp_ae_rate_cvt_process(esp_ae_rate_cvt_handle_t h, int16_t *in, uint32_t n, int16_t *out, uint32_t *got) {
    *got = n / 3; memset(out, 0, *got * 4); return 0;
}
int64_t esp_timer_get_time(void) { return 0; }
void stackchanAudioProgress(unsigned direction, int64_t at) {}
void vTaskDelete(void *task) {}
int av_render_flush(av_render_handle_t player) {
    assert(role == 18 && player);
    pthread_mutex_lock(&mutex);
    flushCalls++;
    pthread_cond_broadcast(&changed);
    unsigned target = cycles + 7;
    while ((!writerDone || cycles < target) && !atomic_load(&session->stopping)) pthread_cond_wait(&changed, &mutex);
    pthread_mutex_unlock(&mutex);
    return 0;
}
static void *clockTask(void *p) { role = 20; audioTask(p); return NULL; }
static void *renderer(void *p) {
    role = 15;
    int16_t old[BLOCK * 30];
    for (unsigned i = 0; i < sizeof(old) / 2; i++) old[i] = 400;
    av_render_audio_frame_t frame = {.data = (uint8_t *)old, .size = sizeof(old)};
    assert(!renderWrite(p, &frame));
    pthread_mutex_lock(&mutex); writerDone = true; pthread_cond_broadcast(&changed); pthread_mutex_unlock(&mutex);
    return NULL;
}
static void *peer(void *p) {
    role = 18;
    assert(!liveAudioFlushOutput(p));
    pthread_mutex_lock(&mutex); flushDone = true; pthread_cond_broadcast(&changed); pthread_mutex_unlock(&mutex);
    return NULL;
}
static void interruptAndFlush(LiveAudio *a) {
    unsigned next = flushCalls + 1;
    assert(liveAudioRequestInterrupt());
    pthread_t owner;
    assert(!pthread_create(&owner, NULL, peer, a));
    pthread_mutex_lock(&mutex);
    while (flushCalls < next) pthread_cond_wait(&changed, &mutex);
    pthread_mutex_unlock(&mutex);
    permit(cycles + 15);
    assert(!pthread_join(owner, NULL));
    permit(cycles + 2);
    assert(!atomic_load(&a->discardOutput) && atomic_load(&a->yieldOutput));
}
static unsigned continuousSpeech(LiveAudio *a, unsigned blocks) {
    int16_t samples[BLOCK * 5];
    for (unsigned i = 0; i < BLOCK * 5; i++) samples[i] = 800;
    av_render_audio_frame_t frame = {.data = (uint8_t *)samples, .size = sizeof(samples)};
    unsigned start = cycles;
    assert(!renderWrite(a, &frame));
    for (unsigned i = 0; i < blocks; i++) {
        permit(start + i + 1);
        if (i + 1 < blocks) { frame.size = BLOCK * 2; assert(!renderWrite(a, &frame)); }
    }
    return start;
}
static void recoveredWithinCap(unsigned start) {
    unsigned first = start;
    while (first < cycles && played[first] == 0) first++;
    // One pre-submitted I2S block may precede the first new PCM read.
    assert(first >= start + 148 && first <= start + 151);
    for (unsigned i = first; i < cycles; i++) assert(played[i] == 400);
}
static void restartClock(LiveAudio *a, pthread_t *clock, bool realtime) {
    atomic_store(&a->stopping, true);
    pthread_mutex_lock(&mutex); pthread_cond_broadcast(&changed); pthread_mutex_unlock(&mutex);
    assert(!pthread_join(*clock, NULL));
    // Mode is fixed before task creation, as it is in liveAudioOpen.
    a->realtime = realtime;
    atomic_store(&a->stopping, false); atomic_store(&a->done, false);
    assert(!pthread_create(clock, NULL, clockTask, a));
}
int main(void) {
    struct Stream input = {.capacity = sizeof(input.data)}, output = {.capacity = PLAYBACK_BYTES / 2};
    struct LivePitch pitch = {.cached = 123};
    aec_handle_t aec = {.count = 160};
    LiveAudio a = {.input = &input, .output = &output, .pitch = &pitch, .aec = &aec,
        .chunk = 160, .player = (void *)1, .bargeIn = true};
    size_t count = BLOCK * (8 + DMA_BLOCKS) + a.chunk * 5;
    a.buffers = calloc(count, 2); assert(a.buffers);
    atomic_store(&a.volume, 512); atomic_store(&a.reading, true);
    session = activeAudio = &a;
    // No decoded renderer task: request/flush must not call av_render_flush.
    assert(liveAudioRequestInterrupt());
    assert(!liveAudioFlushOutput(&a) && !flushCalls);
    atomic_store(&a.interruptRequest, 0); atomic_store(&a.interruptFlushed, 0);
    atomic_store(&a.yieldOutput, false); atomic_store(&a.discardOutput, false);
    a.bargeIn = false; assert(!liveAudioRequestInterrupt()); a.bargeIn = true;
    atomic_store(&a.muted, true); assert(!liveAudioRequestInterrupt()); atomic_store(&a.muted, false);
    pthread_t clock, writer, owner;
    assert(!pthread_create(&writer, NULL, renderer, &a));
    // Wait for the real render callback to fill and block on the small stream.
    pthread_mutex_lock(&mutex);
    while (!output.count) { pthread_mutex_unlock(&mutex); sched_yield(); pthread_mutex_lock(&mutex); }
    pthread_mutex_unlock(&mutex);
    assert(!pthread_create(&clock, NULL, clockTask, &a));
    permit(3);
    assert(played[1] == 200 && played[2] == 200);
    assert(liveAudioRequestInterrupt());
    assert(!pthread_create(&owner, NULL, peer, &a));
    pthread_mutex_lock(&mutex);
    while (!flushCalls) pthread_cond_wait(&changed, &mutex);
    pthread_mutex_unlock(&mutex);
    permit(20);
    assert(!pthread_join(writer, NULL));
    assert(!pthread_join(owner, NULL));
    permit(25);
    assert(flushDone && flushCalls == 1 && resetCalls == 2);
    assert(atomic_load(&a.interruptFlushed) == 1 && atomic_load(&a.interruptDrained) == 1);
    for (unsigned i = 5; i < 25; i++) assert(played[i] == 0);
    assert(pitch.cached == 0 && input.count > 0); // Capture progressed during blocking flush.
    // Late old PCM remains silent. A new response explicitly resumes without
    // waiting for encoded silence or closing/reopening the audio session.
    int16_t samples[BLOCK]; for (unsigned i = 0; i < BLOCK; i++) samples[i] = 400;
    av_render_audio_frame_t frame = {.data = (uint8_t *)samples, .size = sizeof(samples)};
    assert(!renderWrite(&a, &frame)); permit(30);
    for (unsigned i = 25; i < 30; i++) assert(played[i] == 0);
    for (unsigned i = 0; i < BLOCK; i++) samples[i] = 800;
    assert(!renderWrite(&a, &frame)); liveAudioResumeOutput(); permit(35);
    bool fresh = false; for (unsigned i = 30; i < 35; i++) fresh |= played[i] == 400;
    assert(fresh);
    // A second interruption must also flush/reset. A stopped stream has no
    // encoded silence: quiet clock blocks recover it without reopening capture.
    assert(liveAudioRequestInterrupt());
    assert(!pthread_create(&owner, NULL, peer, &a));
    pthread_mutex_lock(&mutex);
    while (flushCalls < 2) pthread_cond_wait(&changed, &mutex);
    pthread_mutex_unlock(&mutex);
    permit(50); assert(!pthread_join(owner, NULL));
    for (unsigned i = 0; i < BLOCK; i++) samples[i] = 400;
    assert(!renderWrite(&a, &frame)); permit(55);
    for (unsigned i = 37; i < 55; i++) assert(played[i] == 0);
    permit(110);
    assert(!atomic_load(&a.yieldOutput) && flushCalls == 2 && resetCalls == 4);
    for (unsigned i = 0; i < BLOCK; i++) samples[i] = 800;
    assert(!renderWrite(&a, &frame)); permit(115);
    fresh = false; for (unsigned i = 110; i < 115; i++) fresh |= played[i] == 400;
    assert(fresh);
    // Continued model output must not stay suppressed for the whole answer.
    interruptAndFlush(&a);
    unsigned start = continuousSpeech(&a, 180);
    recoveredWithinCap(start);
    assert(!atomic_load(&a.yieldOutput));
    // A newer interruption gets its own budget; the prior audible count
    // must not reopen playback partway through the new suppression period.
    interruptAndFlush(&a);
    start = continuousSpeech(&a, 80);
    for (unsigned i = start; i < cycles; i++) assert(played[i] == 0);
    interruptAndFlush(&a);
    start = continuousSpeech(&a, 180);
    recoveredWithinCap(start);
    // Realtime keeps suppressing an old response beyond the Live cap.
    restartClock(&a, &clock, true);
    interruptAndFlush(&a);
    start = continuousSpeech(&a, 180);
    for (unsigned i = start; i < cycles; i++) assert(played[i] == 0);
    assert(atomic_load(&a.yieldOutput));
    liveAudioResumeOutput();
    start = continuousSpeech(&a, 10);
    fresh = false; for (unsigned i = start; i < cycles; i++) fresh |= played[i] == 400;
    assert(fresh);
    // Live fallback cannot override close/quiescence, even once its cap ends.
    restartClock(&a, &clock, false);
    interruptAndFlush(&a);
    atomic_store(&a.quiesced, true);
    start = continuousSpeech(&a, 180);
    for (unsigned i = start; i < cycles; i++) assert(played[i] == 0);
    assert(!atomic_load(&a.yieldOutput) && atomic_load(&a.quiesced));
    atomic_store(&a.stopping, true);
    pthread_mutex_lock(&mutex); pthread_cond_broadcast(&changed); pthread_mutex_unlock(&mutex);
    assert(!pthread_join(clock, NULL));
    assert(!liveAudioRequestInterrupt()); assert(!liveAudioFlushOutput(&a));
    activeAudio = NULL; free(a.buffers);
    return 0;
}
