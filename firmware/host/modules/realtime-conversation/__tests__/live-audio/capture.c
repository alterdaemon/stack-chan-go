#include "../../esp32/liveAudio.c"
#include <assert.h>
#include <pthread.h>

struct Stream {
    bool playback;
    uint8_t data[CAPTURE_BYTES * 2];
    size_t capacity, head, count;
};
struct LivePitch { int semitones; };
static LiveAudio *session;
static pthread_t consumer, clockThread;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t changed = PTHREAD_COND_INITIALIZER;
static atomic_uint blocks, writes, dspCalls, submitted, priorityChanges;
static unsigned permittedBlocks;
static _Thread_local unsigned taskPriority;
static const unsigned uiPriority = 6, ioPriority = 20, sourcePriority = 15;
static bool delayDsp, delayedPlayback;
static bool realtimeAudio;

UBaseType_t uxTaskPriorityGet(void *task) { assert(!task); return taskPriority; }
void vTaskPrioritySet(void *task, UBaseType_t priority) {
    assert(!task && pthread_equal(pthread_self(), consumer));
    taskPriority = priority;
    atomic_fetch_add(&priorityChanges, 1);
}
void vTaskDelete(void *task) { assert(!task); }
int64_t esp_timer_get_time(void) { return atomic_load(&blocks) * 10000; }
void stackchanAudioProgress(unsigned direction, int64_t at) { (void)direction; (void)at; }
void av_render_flush(av_render_handle_t player) { assert(false); }

size_t xStreamBufferReceive(StreamBufferHandle_t stream, void *data, size_t bytes, unsigned wait) {
    if (stream->playback) {
        assert(taskPriority == ioPriority && !wait);
        for (size_t i = 0; i < bytes / 2; i++) ((int16_t *)data)[i] = 400;
        return bytes;
    }
    assert(taskPriority == sourcePriority && pthread_equal(pthread_self(), consumer));
    pthread_mutex_lock(&lock);
    while (!stream->count && !atomic_load(&session->stopping)) {
        permittedBlocks = atomic_load(&blocks) + 4;
        pthread_cond_broadcast(&changed);
        pthread_cond_wait(&changed, &lock);
    }
    if (bytes > stream->count) bytes = stream->count;
    for (size_t i = 0; i < bytes; i++) ((uint8_t *)data)[i] = stream->data[(stream->head + i) % stream->capacity];
    stream->head = (stream->head + bytes) % stream->capacity;
    stream->count -= bytes;
    pthread_mutex_unlock(&lock);
    return bytes;
}
size_t xStreamBufferSpacesAvailable(StreamBufferHandle_t stream) {
    pthread_mutex_lock(&lock);
    size_t available = stream->capacity - stream->count;
    pthread_mutex_unlock(&lock);
    return available;
}
size_t xStreamBufferSend(StreamBufferHandle_t stream, const void *data, size_t bytes, unsigned wait) {
    assert(taskPriority == ioPriority && !stream->playback && !wait);
    assert(bytes == session->chunk * (session->bargeIn ? 4 : 2));
    pthread_mutex_lock(&lock);
    assert(bytes <= stream->capacity - stream->count);
    for (size_t i = 0; i < bytes; i++)
        stream->data[(stream->head + stream->count + i) % stream->capacity] = ((const uint8_t *)data)[i];
    stream->count += bytes;
    atomic_fetch_add(&submitted, session->chunk);
    pthread_cond_broadcast(&changed);
    pthread_mutex_unlock(&lock);
    return bytes;
}
int i2s_channel_write(i2s_chan_handle_t channel, const void *data, size_t bytes,
                      size_t *written, uint32_t timeout) {
    assert(taskPriority == ioPriority && bytes == BLOCK * 4);
    const int16_t *samples = data;
    for (unsigned i = 0; i < BLOCK * 2; i++) assert(samples[i] == (atomic_load(&session->quiesced) ? 0 : (session->pitch ? 100 : 200)));
    pthread_mutex_lock(&lock);
    atomic_fetch_add(&writes, 1);
    pthread_cond_broadcast(&changed);
    pthread_mutex_unlock(&lock);
    *written = bytes;
    return 0;
}
int i2s_channel_read(i2s_chan_handle_t channel, void *data, size_t bytes,
                     size_t *received, uint32_t timeout) {
    assert(taskPriority == ioPriority && bytes == BLOCK * 4);
    pthread_mutex_lock(&lock);
    while (atomic_load(&blocks) >= permittedBlocks && !atomic_load(&session->stopping))
        pthread_cond_wait(&changed, &lock);
    unsigned block = atomic_fetch_add(&blocks, 1);
    for (unsigned i = 0; i < BLOCK; i++) {
        int16_t sample = 1000 + ((block * BLOCK + i) / 3) % 113;
        ((int16_t *)data)[i * 2] = ((int16_t *)data)[i * 2 + 1] = sample;
    }
    *received = bytes;
    pthread_cond_broadcast(&changed);
    pthread_mutex_unlock(&lock);
    return 0;
}
int esp_ae_rate_cvt_process(esp_ae_rate_cvt_handle_t handle, int16_t *input,
                          uint32_t count, int16_t *output, uint32_t *produced) {
    assert(taskPriority == ioPriority);
    *produced = count / 3;
    for (unsigned i = 0; i < *produced; i++) {
        output[i * 2] = input[i * 6];
        output[i * 2 + 1] = input[i * 6 + 1];
    }
    return 0;
}
int livePitchRender(LivePitch *pitch, LivePitchRead read, void *context,
                    int16_t *output, size_t count, LivePitchResult *result) {
    assert(taskPriority == ioPriority && pitch->semitones);
    size_t received = read(context, output, count);
    for (unsigned i = 0; i < count; i++) output[i] /= 2;
    *result = (LivePitchResult){.received = received, .missing = received < count};
    return 0;
}
void aec_process(const aec_handle_t *aec, int16_t *mic, int16_t *ref, int16_t *clean) {
    assert(pthread_equal(pthread_self(), consumer));
    assert(taskPriority == session->dspPriority);
    if (realtimeAudio) assert(taskPriority > uiPriority && taskPriority < sourcePriority);
    else assert(taskPriority == uiPriority);
    assert(!((uintptr_t)mic % 16) && !((uintptr_t)ref % 16) && !((uintptr_t)clean % 16));
    if (delayDsp && !atomic_load(&dspCalls)) {
        // The mouth meter must already follow I2S before capture DSP finishes.
        assert(atomic_load(&session->playbackLevel) == (atomic_load(&session->quiesced) ? 0 : (session->pitch ? 100 : 200)));
        assert(!atomic_load(&session->referenceLevel));
        // Hold DSP while the independent I2S task advances 100 ms of virtual
        // audio. The bounded FIFO must retain every paired microphone frame.
        pthread_mutex_lock(&lock);
        unsigned start = atomic_load(&writes), target = atomic_load(&blocks) + 10;
        permittedBlocks = target;
        pthread_cond_broadcast(&changed);
        while (atomic_load(&blocks) < target || atomic_load(&writes) < start + 10)
            pthread_cond_wait(&changed, &lock);
        assert(atomic_load(&writes) >= start + 10);
        delayedPlayback = true;
        pthread_mutex_unlock(&lock);
    }
    unsigned start = atomic_load(&dspCalls) * aec->count;
    for (unsigned i = 0; i < aec->count; i++) {
        assert(mic[i] == 1000 + (start + i) % 113);
        int reference = atomic_load(&session->quiesced) || start + i < DMA_BLOCKS * BLOCK / 3 ? 0 : (session->pitch ? 100 : 200);
        assert(ref[i] == reference);
        clean[i] = mic[i] - ref[i];
    }
    atomic_fetch_add(&dspCalls, 1);
}
static void *runClock(void *context) {
    taskPriority = ioPriority;
    audioTask(context);
    return NULL;
}
static void run(bool interruption, int semitones, bool mute, bool delay, bool quiesce) {
    struct Stream input = {.capacity = CAPTURE_BYTES * (interruption ? 2 : 1)};
    struct Stream output = {.playback = true};
    struct LivePitch pitch = {.semitones = semitones};
    aec_handle_t aec = {.count = 512};
    LiveAudio audio = {.input = &input, .output = &output,
        .aec = interruption ? &aec : NULL, .pitch = semitones ? &pitch : NULL,
        .bargeIn = interruption, .chunk = interruption ? aec.count : 160,
        .dspPriority = realtimeAudio ? uiPriority + 1 : uiPriority};
    size_t samples = BLOCK * (8 + DMA_BLOCKS) + audio.chunk * (interruption ? 5 : 3);
    audio.buffers = aligned_alloc(16, samples * sizeof(int16_t));
    assert(audio.buffers);
    memset(audio.buffers, 0, samples * sizeof(int16_t));
    if (interruption) audio.aecFrame = audio.buffers + BLOCK * (8 + DMA_BLOCKS) + audio.chunk * 2;
    atomic_store(&audio.volume, 512);
    atomic_store(&audio.muted, mute);
    session = &audio;
    consumer = pthread_self();
    delayDsp = delay;
    delayedPlayback = false;
    taskPriority = sourcePriority;
    permittedBlocks = 0;
    atomic_store(&blocks, 0); atomic_store(&writes, 0); atomic_store(&dspCalls, 0);
    atomic_store(&submitted, 0); atomic_store(&priorityChanges, 0);
    assert(!sourceStart(&audio.source));
    atomic_store(&quiesceAudio, quiesce);
    liveAudioMute(&audio, mute);
    assert(atomic_load(&audio.quiesced) == quiesce);
    assert(atomic_load(&audio.reading) && !atomic_load(&audio.stopping));
    assert(!pthread_create(&clockThread, NULL, runClock, &audio));
    unsigned total = 0;
    for (unsigned call = 0; call < 160; call++) {
        // Opus-sized requests straddle AEC frames. Retain and return the tail.
        int16_t captured[480];
        // Include the 20 ms / 320-sample read observed on the real device.
        unsigned count = call < 80 ? (call % 2 ? 480 : 160) : 320;
        esp_capture_stream_frame_t frame = {.data = (uint8_t *)captured, .size = count * 2};
        assert(!sourceRead(&audio.source, &frame));
        assert(taskPriority == sourcePriority && frame.pts == total / 16);
        for (unsigned i = 0; i < count; i++) {
            unsigned index = total + i;
            int reference = quiesce || index < DMA_BLOCKS * BLOCK / 3 ? 0 : (semitones ? 100 : 200);
            int expected = interruption && !mute && !quiesce ? 1000 + index % 113 - reference : 0;
            assert(captured[i] == expected);
        }
        total += count;
    }
    liveAudioStop(&audio);
    pthread_mutex_lock(&lock);
    pthread_cond_broadcast(&changed);
    pthread_mutex_unlock(&lock);
    assert(!pthread_join(clockThread, NULL));
    assert(atomic_load(&audio.done) && !atomic_load(&audio.error));
    assert(!atomic_load(&audio.overruns));
    assert(atomic_load(&submitted) >= total && atomic_load(&audio.sourceSamples) == total);
    assert(atomic_load(&dspCalls) == (interruption && !quiesce ? total / aec.count : 0));
    assert(atomic_load(&priorityChanges) == atomic_load(&dspCalls) * 2);
    assert(delayedPlayback == (interruption && delay && !quiesce));
    assert(sourceRead(&audio.source, &(esp_capture_stream_frame_t){.data = input.data, .size = 320})
        == ESP_CAPTURE_ERR_NOT_SUPPORTED);
    free(audio.buffers);
}
int main(void) {
  for (unsigned mode = 0; mode < 2; mode++) {
    realtimeAudio = mode != 0;
    for (int pitch = -6; pitch <= 6; pitch++) {
        run(false, pitch, false, false, false);
        run(true, pitch, false, true, false);
        run(false, pitch, false, false, true);
        run(true, pitch, false, true, true);
    }
    run(true, 0, true, true, false);
    run(true, 3, true, true, false);
  }
    return 0;
}
