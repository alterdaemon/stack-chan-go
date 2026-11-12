// Copyright (c) 2026 Shinya Ishikawa
// SPDX-License-Identifier: Apache-2.0

#include "xsHost.h"
#include "mc.defines.h"
#include "xsmc.h"
#include "mc.defines.h"
#include "esp_timer.h"
#include "io-performance.h"
#include "esp_webrtc.h"
#include "liveAudio.h"
#include "../../debug-log/debug-log.h"
#include "livePitch.h"
#include "liveEcho.h"
#include "liveCodec.h"
#include "driver/i2s_std.h"
#include "esp_heap_caps.h"
#include "audio_render.h"
#include "esp_aec.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/stream_buffer.h"
#include <stdlib.h>
#include <string.h>

/* Ordinary CoreS3 and M5StackChan CoreS3 share the AW88298/ES7210 duplex
 * bus, initialized by the SDK's CoreS3 setup. Use the selected board's pins
 * so the native transport and normal playback/recording cannot diverge. */
_Static_assert(MODDEF_AUDIOOUT_I2S_NUM == MODDEF_AUDIOIN_I2S_NUM,
	"WebRTC requires a shared CoreS3 I2S controller");
_Static_assert(MODDEF_AUDIOOUT_I2S_BCK_PIN == MODDEF_AUDIOIN_I2S_BCK_PIN &&
	MODDEF_AUDIOOUT_I2S_LR_PIN == MODDEF_AUDIOIN_I2S_LR_PIN &&
	MODDEF_AUDIOOUT_I2S_MCK_PIN == MODDEF_AUDIOIN_I2S_MCK_PIN,
	"WebRTC requires shared CoreS3 I2S clocks");
_Static_assert(MODDEF_AUDIOIN_I2S_FORMAT_I2S == 1,
	"WebRTC requires the CoreS3 ES7210 Philips I2S format");

static esp_err_t measuredWrite(i2s_chan_handle_t handle, const void *data, size_t size, size_t *written, uint32_t timeout) {
  esp_err_t err = i2s_channel_write(handle, data, size, written, timeout);
  if (!err && *written) stackchanAudioProgress(0, esp_timer_get_time());
  return err;
}
static esp_err_t measuredRead(i2s_chan_handle_t handle, void *data, size_t size, size_t *received, uint32_t timeout) {
  esp_err_t err = i2s_channel_read(handle, data, size, received, timeout);
  if (!err && *received) stackchanAudioProgress(1, esp_timer_get_time());
  return err;
}
// Stream buffers are copied by the CPU, never handed to I2S DMA. FreeRTOS's
// dynamic allocator would place all 25.6 KB in internal RAM. Keep only its
// control blocks internal, and put sample storage in PSRAM.


static struct {
  StaticStreamBuffer_t control;
  uint8_t *data;
  StreamBufferHandle_t handle;
} streams[2];
static StreamBufferHandle_t audioStreamCreate(size_t size, size_t trigger) {
  for (int i = 0; i < 2; i++) if (!streams[i].handle) {
    streams[i].data = heap_caps_malloc(size + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!streams[i].data) return NULL;
    // Static creation uses the supplied byte count, including its empty slot.
    streams[i].handle = xStreamBufferCreateStatic(size + 1, trigger, streams[i].data, &streams[i].control);
    if (!streams[i].handle) {free(streams[i].data); streams[i].data = NULL;}
    return streams[i].handle;
  }
  return NULL;
}
static void audioStreamDelete(StreamBufferHandle_t handle) {
  vStreamBufferDelete(handle);
  for (int i = 0; i < 2; i++) if (streams[i].handle == handle) {
    free(streams[i].data); streams[i].data = NULL; streams[i].handle = NULL;
    break;
  }
}

static portMUX_TYPE audioLock = portMUX_INITIALIZER_UNLOCKED;
static LiveAudio *activeAudio;
static atomic_bool quiesceAudio;
static atomic_uint diagnosticSpeaker = 1024, diagnosticCapture = 1024, diagnosticNlp = AEC_NLP_LEVEL_AGGR;
int stackchanAudioDebugSet(unsigned parameter, unsigned value) {
    switch (parameter) {
      case DEBUG_TUNE_RESET:
        atomic_store(&diagnosticSpeaker, 1024); atomic_store(&diagnosticCapture, 1024);
        atomic_store(&diagnosticNlp, AEC_NLP_LEVEL_AGGR); return 0;
      case DEBUG_TUNE_SPEAKER:
        if (value > 1024) return -1;
        atomic_store(&diagnosticSpeaker, value); return 0;
      case DEBUG_TUNE_CAPTURE:
        if (value < 45 || value > 1024) return -1;
        atomic_store(&diagnosticCapture, value); return 0;
      case DEBUG_TUNE_NLP:
        if (value > 2) return -1;
        atomic_store(&diagnosticNlp, value); return 0;
      default: return -1;
    }
}
unsigned stackchanAudioDebugGet(unsigned parameter) {
    return parameter == DEBUG_TUNE_SPEAKER ? atomic_load(&diagnosticSpeaker) :
      parameter == DEBUG_TUNE_CAPTURE ? atomic_load(&diagnosticCapture) : atomic_load(&diagnosticNlp);
}
extern esp_err_t stackchanMediaAdapter(void);
extern int stackchanInstallOpusPolicy(void);
extern void stackchanOpusDecodeRate(unsigned rate);

/* The board codec is configured before capture. This module owns BOTH I2S
 * directions for the entire session; do not open device.audio at the same time.
 * Three 10 ms DMA buffers separate a submitted sample from the capture clock.
 * AEC receives the software-volume-adjusted samples, including silence. */
#define LIVE_RATE 16000
#define BLOCK (LIVE_RATE / 100)
#define DMA_BLOCKS 3
#define CAPTURE_BYTES 6400
#define PLAYBACK_BYTES (LIVE_RATE * 2 / 5)
#define LIVE_YIELD_AUDIBLE_MS 1500

struct LiveAudio {
	esp_capture_audio_src_if_t source;
	esp_capture_handle_t capture;
	av_render_handle_t player;
	audio_render_handle_t render;
	i2s_chan_handle_t tx, rx;
	StreamBufferHandle_t input, output;

	aec_handle_t *aec;
    LiveEcho echo;
    LiveCodec codec;
    LivePitch *pitch;
	bool bargeIn, realtime;
    UBaseType_t dspPriority;
	atomic_bool stopping, done, reading, muted, quiesced;
    atomic_bool yieldOutput, discardOutput, renderActive;
    atomic_uint interruptRequest, interruptFlushed, interruptDrained, resumeRequest;
	atomic_uint volume, captured, rendered, underruns, overruns, sourceSamples;
	atomic_uint requestedRate, requestedChannels, sourceFrameBytes;
	atomic_uint micLevel, cleanLevel, referenceLevel, playbackLevel;
	atomic_uint outputIdleMs, silenceMs, maxSilenceMs;
	atomic_uint audibleMs;
	atomic_int error;
	bool taskStarted, txEnabled, rxEnabled;
	uint32_t pts;
	int chunk;
    unsigned appliedNlp;
	int16_t *aecFrame;
	size_t cleanOffset;
	_Atomic(const char *) stage;
	int16_t *buffers;
};

static void captureStats(LiveAudio *a, const int16_t *mic, const int16_t *ref, int16_t *clean)
{
	unsigned m = 0, r = 0, c = 0;
	for (int j = 0; j < a->chunk; j++) { m += abs(mic[j]); r += abs(ref[j]); c += abs(clean[j]); }
	atomic_store(&a->micLevel, m / a->chunk);
	atomic_store(&a->referenceLevel, r / a->chunk);
	atomic_store(&a->cleanLevel, c / a->chunk);
	if (atomic_load(&a->muted)) memset(clean, 0, a->chunk * 2);
	atomic_fetch_add(&a->captured, a->chunk);
}

static size_t readInput(LiveAudio *a, uint8_t *data, size_t size)
{
	size_t offset = 0;
	while (offset < size && atomic_load(&a->reading) && !atomic_load(&a->stopping))
		offset += xStreamBufferReceive(a->input, data + offset, size - offset, pdMS_TO_TICKS(50));
	return offset;
}

static esp_capture_err_t sourceOpen(esp_capture_audio_src_if_t *s) { return ESP_CAPTURE_ERR_OK; }
static esp_capture_err_t sourceCodecs(esp_capture_audio_src_if_t *s, const esp_capture_format_id_t **codecs, uint8_t *count)
{
	static const esp_capture_format_id_t pcm = ESP_CAPTURE_FMT_ID_PCM;
	*codecs = &pcm; *count = 1;
	return ESP_CAPTURE_ERR_OK;
}
static esp_capture_err_t sourceNegotiate(esp_capture_audio_src_if_t *s, esp_capture_audio_info_t *in, esp_capture_audio_info_t *out)
{
	LiveAudio *a = (LiveAudio *)s;
	atomic_store(&a->requestedRate, in->sample_rate); atomic_store(&a->requestedChannels, in->channel);
	if (in->format_id != ESP_CAPTURE_FMT_ID_PCM) return ESP_CAPTURE_ERR_NOT_SUPPORTED;
	*out = (esp_capture_audio_info_t){.format_id = ESP_CAPTURE_FMT_ID_PCM, .sample_rate = 16000, .channel = 1, .bits_per_sample = 16};
	return ESP_CAPTURE_ERR_OK;
}
static esp_capture_err_t sourceStart(esp_capture_audio_src_if_t *s)
{
	LiveAudio *a = (LiveAudio *)s;
	a->pts = 0;
	a->cleanOffset = a->chunk * 2;
    liveEchoReset(&a->echo);
	atomic_store(&a->reading, true);
	return ESP_CAPTURE_ERR_OK;
}
/* Optional application DSP/test source. Runs on the native capture task, never
 * the JS event loop. Implementations must be bounded and non-blocking. */
__attribute__((weak)) void liveAudioTransformCapture(int16_t *samples, size_t count) {}
static esp_capture_err_t sourceRead(esp_capture_audio_src_if_t *s, esp_capture_stream_frame_t *frame)
{
	LiveAudio *a = (LiveAudio *)s;
	int offset = 0;
	atomic_store(&a->sourceFrameBytes, frame->size);
	if (a->aec) {
		int16_t *mic = a->aecFrame, *ref = mic + a->chunk, *clean = ref + a->chunk;
		while (offset < frame->size && atomic_load(&a->reading) && !atomic_load(&a->stopping)) {
			if (a->cleanOffset == a->chunk * 2) {
				// Paired, planar frames arrive through the existing input FIFO.
				if (readInput(a, (uint8_t *)mic, a->chunk * 4) != a->chunk * 4)
					return ESP_CAPTURE_ERR_NOT_SUPPORTED;
                unsigned nlp = atomic_load(&diagnosticNlp);
                if (nlp != a->appliedNlp) {
                    aec_set_nlp_level(a->aec, nlp);
                    a->appliedNlp = nlp;
                }
                bool echoActive = liveEchoNeedsAEC(&a->echo, ref, a->chunk);
				if (atomic_load(&a->quiesced)) {
					// Close keeps the source clock and FIFO drain alive, but only
					// forwards silence. Its AEC state will be released after teardown.
					memset(clean, 0, a->chunk * 2);
                } else if (!echoActive) {
                    memcpy(clean, mic, a->chunk * sizeof(int16_t));
                } else {
					// Capture DSP precedes HTTPS and normal XS work.
					// I2S remains independent and never waits for this processing.
					UBaseType_t priority = uxTaskPriorityGet(NULL);
					vTaskPrioritySet(NULL, a->dspPriority);
#ifdef MODDEF_STACKCHAN_LIVE_PROBE
					int64_t began = esp_timer_get_time();
#endif
					aec_process(a->aec, mic, ref, clean);
#ifdef MODDEF_STACKCHAN_LIVE_PROBE
					extern void stackchanProbeAEC(unsigned elapsed);
					stackchanProbeAEC(esp_timer_get_time() - began);
#endif
					vTaskPrioritySet(NULL, priority);
				}
                if (!atomic_load(&a->quiesced)) {
                    unsigned gain = a->codec.captureGainQ10 ? a->codec.captureGainQ10 : 1024;
                    // Realtime VAD otherwise hears amplified residual speaker
                    // speech as a new turn. Retain full gain while listening.
                    if (a->realtime && echoActive) gain = gain * 408 / 1024;
                    liveEchoListeningLevel(clean, a->chunk,
                        (uint64_t)gain * atomic_load(&diagnosticCapture) / 1024);
                }
				captureStats(a, mic, ref, clean);
				a->cleanOffset = 0;
			}
			size_t count = a->chunk * 2 - a->cleanOffset;
			if (count > frame->size - offset) count = frame->size - offset;
			memcpy(frame->data + offset, (uint8_t *)clean + a->cleanOffset, count);
			a->cleanOffset += count;
			offset += count;
		}
	} else offset = readInput(a, frame->data, frame->size);
	if (offset != frame->size) return ESP_CAPTURE_ERR_NOT_SUPPORTED;
    bool gated = atomic_load(&a->muted) || atomic_load(&a->quiesced) || (!a->bargeIn && atomic_load(&a->outputIdleMs) < 500);
    if (gated) memset(frame->data, 0, frame->size);
	else {
        if (!a->aec) liveEchoListeningLevel((int16_t *)frame->data, frame->size / 2, atomic_load(&diagnosticCapture));
        liveAudioTransformCapture((int16_t *)frame->data, frame->size / 2);
    }
#ifdef MODDEF_STACKCHAN_LIVE_PROBE
    extern void stackchanProbeCaptureOutput(const int16_t *samples, unsigned count);
    stackchanProbeCaptureOutput((int16_t *)frame->data, frame->size / 2);
#endif
	atomic_fetch_add(&a->sourceSamples, frame->size / 2);
	frame->pts = a->pts / 16;
	a->pts += frame->size / 2;
	return ESP_CAPTURE_ERR_OK;
}
static esp_capture_err_t sourceStop(esp_capture_audio_src_if_t *s)
{
	atomic_store(&((LiveAudio *)s)->reading, false);
	return ESP_CAPTURE_ERR_OK;
}
static audio_render_handle_t renderInit(void *cfg, int size) { return *(LiveAudio **)cfg; }
static int renderOpen(audio_render_handle_t h, av_render_audio_frame_info_t *info)
{
	return (info->sample_rate == LIVE_RATE && info->channel == 1 && info->bits_per_sample == 16) ? 0 : -1;
}
static int renderWrite(audio_render_handle_t h, av_render_audio_frame_t *frame)
{
	LiveAudio *a = h;
	atomic_store(&a->renderActive, true);
	int offset = 0;
	while (offset < frame->size && !atomic_load(&a->stopping)) {
        // The renderer must finish its write while the peer waits in flush.
        if (atomic_load(&a->discardOutput)) return 0;
		offset += xStreamBufferSend(a->output, frame->data + offset, frame->size - offset, pdMS_TO_TICKS(50));
	}
	return offset == frame->size ? 0 : -1;
}
static int renderLatency(audio_render_handle_t h, uint32_t *ms)
{
	LiveAudio *a = h;
	*ms = xStreamBufferBytesAvailable(a->output) / (LIVE_RATE / 500) + DMA_BLOCKS * 10;
	return 0;
}
static int renderInfo(audio_render_handle_t h, av_render_audio_frame_info_t *info)
{
	*info = (av_render_audio_frame_info_t){.sample_rate = LIVE_RATE, .channel = 1, .bits_per_sample = 16};
	return 0;
}
static int renderClose(audio_render_handle_t h) { return 0; }
static void renderDeinit(audio_render_handle_t h) {}

static size_t pitchRead(void *context, int16_t *samples, size_t count)
{
    LiveAudio *a = context;
    return xStreamBufferReceive(a->output, samples, count * sizeof(int16_t), 0) / sizeof(int16_t);
}

static void audioTask(void *ctx)
{
	LiveAudio *a = ctx;
	int16_t *tx = a->buffers, *rx = tx + BLOCK * 2;
	int16_t *pair = rx + BLOCK * 2, *converted = pair + BLOCK * 2;
	int16_t *reference = converted + BLOCK * 2;
	int16_t *mic = reference + BLOCK * DMA_BLOCKS;
	int16_t *ref = mic + a->chunk, *clean = ref + a->chunk;
	int accumulated = 0, delay = 0;
	unsigned idle = 1000, gap = 0, yieldedQuiet = 0, yieldedAudible = 0;
	bool gapActive = false;
	while (!atomic_load(&a->stopping)) {
        unsigned request = atomic_load(&a->interruptRequest);
        if (request != atomic_load(&a->interruptDrained)) {
            // Only this task reads output. Writers drop during invalidation;
            // bound draining even if an already-blocked write finishes late.
            size_t remaining = PLAYBACK_BYTES;
            while (remaining) {
                size_t count = remaining < BLOCK * 2 ? remaining : BLOCK * 2;
                size_t dropped = xStreamBufferReceive(a->output, tx, count, 0);
                if (!dropped) break;
                remaining -= dropped;
            }
            int reset = livePitchReset(a->pitch);
            if (reset) { a->stage = "pitch_reset"; atomic_store(&a->error, reset); break; }
            yieldedQuiet = 0;
            yieldedAudible = 0;
            atomic_store(&a->interruptDrained, request);
        }
        if (atomic_load(&a->discardOutput) && request == atomic_load(&a->interruptFlushed)) {
            // Flush finished after its writer stopped. Drain once more before
            // accepting new decoded frames; a previous write may have unblocked.
            size_t remaining = PLAYBACK_BYTES;
            while (remaining) {
                size_t count = remaining < BLOCK * 2 ? remaining : BLOCK * 2;
                size_t dropped = xStreamBufferReceive(a->output, tx, count, 0);
                if (!dropped) break;
                remaining -= dropped;
            }
            int reset = livePitchReset(a->pitch);
            if (reset) { a->stage = "pitch_reset"; atomic_store(&a->error, reset); break; }
            portENTER_CRITICAL(&audioLock);
            if (request == atomic_load(&a->interruptRequest)) atomic_store(&a->discardOutput, false);
            portEXIT_CRITICAL(&audioLock);
        }
        portENTER_CRITICAL(&audioLock);
        if (request && request == atomic_load(&a->resumeRequest) &&
            request == atomic_load(&a->interruptFlushed) && request == atomic_load(&a->interruptRequest)) {
            if (atomic_exchange(&a->yieldOutput, false)) stackchanDebugTransition(DEBUG_OUTPUT_RECOVER, request, 0, 0);
        }
        portEXIT_CRITICAL(&audioLock);
		/* Non-blocking dequeue: the clock must keep running between utterances. */
        size_t got;
        bool missing;
        if (a->pitch) {
            LivePitchResult result;
            int err = livePitchRender(a->pitch, pitchRead, a, tx, BLOCK, &result);
            if (err) { a->stage = "pitch_process"; atomic_store(&a->error, err); break; }
            got = result.received * sizeof(int16_t);
            missing = result.missing;
        } else {
            got = xStreamBufferReceive(a->output, tx, BLOCK * 2, 0);
            missing = got < BLOCK * 2;
            memset((uint8_t *)tx + got, 0, BLOCK * 2 - got);
        }
		if (missing && idle < 500) {
			if (!gapActive) atomic_fetch_add(&a->underruns, 1);
			gapActive = true; gap += 10;
			atomic_fetch_add(&a->silenceMs, 10);
			if (gap > atomic_load(&a->maxSilenceMs)) atomic_store(&a->maxSilenceMs, gap);
		} else { gapActive = false; gap = 0; }
		bool audible = false;
		for (size_t i = 0; i < BLOCK; i++) if (abs(tx[i]) > 32) { audible = true; break; }
		/* Missing packets are not evidence of silence. Only received PCM
		 * can reopen the S3 microphone after playback. */
		if (audible) idle = 0;
		else if (!missing && idle < 10000) idle += 10;
		atomic_store(&a->outputIdleMs, idle);
        // Missing packets count only for cancelled-tail recovery, never for
        // Off's microphone gate. A new response can explicitly resume sooner.
        if (atomic_load(&a->yieldOutput) && !atomic_load(&a->discardOutput)) {
            yieldedQuiet = audible ? 0 : yieldedQuiet + 10;
            // Live has no output-turn boundary: continued model speech must
            // not stay muted indefinitely. Realtime retains explicit recovery.
            if (audible && !a->realtime) yieldedAudible += 10;
            if (yieldedQuiet >= 500 || (!a->realtime && yieldedAudible >= LIVE_YIELD_AUDIBLE_MS)) {
                portENTER_CRITICAL(&audioLock);
                if (request == atomic_load(&a->interruptRequest) && atomic_exchange(&a->yieldOutput, false))
                    stackchanDebugTransition(DEBUG_OUTPUT_RECOVER, request, 1, 0);
                portEXIT_CRITICAL(&audioLock);
            }
        }
		unsigned volume = atomic_load(&a->volume);
        volume = volume * atomic_load(&diagnosticSpeaker) / 1024;
        unsigned playbackLevel = 0;
        bool quiesced = atomic_load(&a->quiesced) || atomic_load(&a->yieldOutput);
		for (int i = BLOCK - 1; i >= 0; i--) {
			int16_t sample = quiesced ? 0 : (int32_t)tx[i] * volume / 1024;
            playbackLevel += abs(sample);
			tx[i * 2] = tx[i * 2 + 1] = sample;
		}
		size_t written = 0, received = 0;
		int err = measuredWrite(a->tx, tx, BLOCK * 4, &written, 200);
		if (!err) err = measuredRead(a->rx, rx, BLOCK * 4, &received, 200);
		if (err || received != BLOCK * 4 || written != BLOCK * 4) {
			a->stage = written != BLOCK * 4 ? "i2s_write" : "i2s_read";
			atomic_store(&a->error, err ? err : ESP_ERR_INVALID_SIZE);
			break;
		}
        atomic_store(&a->playbackLevel, playbackLevel / BLOCK);
        if (playbackLevel && !quiesced) atomic_fetch_add(&a->audibleMs, 10);
		for (int i = 0; i < BLOCK; i++) {
			pair[i * 2] = rx[i * 2];
			pair[i * 2 + 1] = reference[delay];
			reference[delay] = tx[i * 2];
			delay = (delay + 1) % (BLOCK * DMA_BLOCKS);
		}
		uint32_t count = BLOCK;
		memcpy(converted, pair, BLOCK * 4);
#ifdef MODDEF_STACKCHAN_LIVE_PROBE
        extern void stackchanProbeInput(int16_t *samples, unsigned count, unsigned playbackLevel);
        stackchanProbeInput(converted, count, playbackLevel);
#endif
		atomic_fetch_add(&a->rendered, got / 2);
		for (uint32_t i = 0; i < count; i++) {
			mic[accumulated] = converted[i * 2];
			ref[accumulated++] = converted[i * 2 + 1];
			if (accumulated != a->chunk) continue;
			if (a->aec) {
				// Hand the paired frame to AUD_SRC. Keep the speaker clock running
				// even while capture DSP yields CPU time to the interface.
				if (atomic_load(&a->reading)) {
					if (xStreamBufferSpacesAvailable(a->input) >= a->chunk * 4)
						xStreamBufferSend(a->input, mic, a->chunk * 4, 0);
					else atomic_fetch_add(&a->overruns, 1);
				}
			} else {
				memcpy(clean, mic, a->chunk * 2);
				// Default mode preserves the existing half-duplex input gate.
				if (idle < 500) memset(clean, 0, a->chunk * 2);
				captureStats(a, mic, ref, clean);
				if (atomic_load(&a->reading)) {
					if (xStreamBufferSpacesAvailable(a->input) >= a->chunk * 2)
						xStreamBufferSend(a->input, clean, a->chunk * 2, 0);
					else atomic_fetch_add(&a->overruns, 1);
				}
			}
			accumulated = 0;
		}
	}
	atomic_store(&a->done, true);
	vTaskDelete(NULL);
}

int liveAudioOpen(LiveAudio **out, esp_webrtc_media_provider_t *provider, bool bargeIn, int pitch, bool realtime)
{
  atomic_store(&quiesceAudio, false);
  int err = stackchanMediaAdapter();
  if (!err) err = stackchanInstallOpusPolicy();
  if (err) return err;
  stackchanAudioReset();
	LiveAudio *a = calloc(1, sizeof(*a));
	if (!a) return ESP_ERR_NO_MEM;
	*out = a;
    // Keep capture ahead of HTTPS (7) and XS (6) outside elevated UI windows.
    a->dspPriority = 8;
    a->stage = "pitch_open";
    if ((err = livePitchOpen(&a->pitch, pitch))) return err;
	atomic_store(&a->volume, 512);
	a->source = (esp_capture_audio_src_if_t){.open = sourceOpen, .get_support_codecs = sourceCodecs,
		.negotiate_caps = sourceNegotiate, .start = sourceStart, .read_frame = sourceRead,
		.abort = sourceStop, .stop = sourceStop, .close = sourceStop};
	a->stage = "audio_buffers";
	// On carries mic + reference rather than clean mono: retain the same 200 ms.
	a->input = audioStreamCreate(CAPTURE_BYTES * (bargeIn ? 2 : 1), 1);
	a->output = audioStreamCreate(bargeIn ? PLAYBACK_BYTES / 2 : PLAYBACK_BYTES, 1);
	if (!a->input || !a->output) return ESP_ERR_NO_MEM;
	a->bargeIn = bargeIn;
    a->realtime = realtime;
	a->chunk = 160;
	if (bargeIn) {
        a->stage = "codec_gain";
        if ((err = liveCodecOpen(&a->codec, 6))) return err;
		a->stage = "aec_create";
		aec_config_t config = {.mic_num = 1, .ref_num = 1, .out_num = 1,
			.filter_length = 2, .sample_rate = 16000,
			.caps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT,
			// ESP-SR's default FD level provides stronger residual echo suppression.
			.mode = AEC_MODE_FD_LOW_COST, .nlp_level = atomic_load(&diagnosticNlp)};
        a->appliedNlp = config.nlp_level;
		a->aec = aec_create_from_config(&config);
		if (!a->aec) return ESP_ERR_NO_MEM;
		a->chunk = aec_get_chunksize(a->aec);
		if (a->chunk <= 0 || a->chunk > 2048) return ESP_ERR_INVALID_SIZE;
	}
	atomic_store(&a->outputIdleMs, 1000);
	// On: I2S owns two planes, AUD_SRC owns three. Off retains its three planes.
	a->buffers = heap_caps_aligned_calloc(16, BLOCK * (8 + DMA_BLOCKS) + a->chunk * (bargeIn ? 5 : 3), sizeof(int16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
	if (!a->buffers) return ESP_ERR_NO_MEM;
	if (bargeIn) a->aecFrame = a->buffers + BLOCK * (8 + DMA_BLOCKS) + a->chunk * 2;
	i2s_chan_config_t channel = I2S_CHANNEL_DEFAULT_CONFIG(
		MODDEF_AUDIOOUT_I2S_NUM,
		I2S_ROLE_MASTER);
	channel.dma_desc_num = DMA_BLOCKS;
	channel.dma_frame_num = BLOCK;
	channel.auto_clear = true;
	a->stage = "i2s_new_channel";
	err = i2s_new_channel(&channel, &a->tx, &a->rx);
	if (err) return err;
	i2s_std_config_t config = {
		.clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(LIVE_RATE),
		.slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
		.gpio_cfg = {.mclk = MODDEF_AUDIOOUT_I2S_MCK_PIN,
			.bclk = MODDEF_AUDIOOUT_I2S_BCK_PIN, .ws = MODDEF_AUDIOOUT_I2S_LR_PIN,
			.dout = MODDEF_AUDIOOUT_I2S_DATAOUT_PIN, .din = MODDEF_AUDIOIN_I2S_DATAIN}
	};
	a->stage = "i2s_init_tx";
	if ((err = i2s_channel_init_std_mode(a->tx, &config))) return err;
	a->stage = "i2s_init_rx";
	if ((err = i2s_channel_init_std_mode(a->rx, &config))) return err;
	a->stage = "i2s_enable_rx";
	if ((err = i2s_channel_enable(a->rx))) return err;
	a->rxEnabled = true;
	a->stage = "i2s_enable_tx";
	if ((err = i2s_channel_enable(a->tx))) return err;
	a->txEnabled = true;
	a->stage = "audio_task";
	// I2S and Pitch run here; On's AEC runs synchronously in the capture reader.
	// Full-duplex audio stays on core 1; Off retains its prior core placement.
	if (xTaskCreatePinnedToCore(audioTask, "live_audio", 8192, a, 20, NULL, bargeIn ? 1 : 0) != pdPASS) return ESP_ERR_NO_MEM;
	a->taskStarted = true;
	esp_capture_cfg_t capture = {.sync_mode = ESP_CAPTURE_SYNC_MODE_AUDIO, .audio_src = &a->source};
	a->stage = "capture_open";
	if ((err = esp_capture_open(&capture, &a->capture))) return err;
	audio_render_cfg_t render = {.ops = {.init = renderInit, .open = renderOpen, .write = renderWrite,
		.get_latency = renderLatency, .get_frame_info = renderInfo, .close = renderClose, .deinit = renderDeinit},
		.cfg = &a, .cfg_size = sizeof(a)};
	a->stage = "render_alloc";
	a->render = audio_render_alloc_handle(&render);
	if (!a->render) return ESP_ERR_NO_MEM;
	av_render_cfg_t player = {.audio_render = a->render, .audio_raw_fifo_size = 16384,
        .audio_render_fifo_size = bargeIn ? PLAYBACK_BYTES : 32768};
	a->stage = "render_open";
	a->player = av_render_open(&player);
	if (!a->player) return ESP_ERR_NO_MEM;
	av_render_audio_frame_info_t info;
	renderInfo(a, &info);
	a->stage = "render_format";
	/* av_render 1.1.0 at c865084 assigns aud_fix_info but unconditionally
	 * returns WRONG_STATE. Accept that known return only for this setter. */
	err = av_render_set_fixed_frame_info(a->player, &info);
	if (err && err != ESP_MEDIA_ERR_WRONG_STATE) return err;
    stackchanOpusDecodeRate(LIVE_RATE);
	provider->capture = a->capture;
	provider->player = a->player;
  portENTER_CRITICAL(&audioLock);
  activeAudio = a;
  portEXIT_CRITICAL(&audioLock);
	return 0;
}
void liveAudioStop(LiveAudio *a)
{
	if (!a) return;
  bool first = !atomic_exchange(&a->stopping, true);
	atomic_store(&a->reading, false);
  // A renderer without a decoded frame has no render task to flush.
  if (first) stackchanDebugTransition(DEBUG_AUDIO_STOP, atomic_load(&a->interruptRequest), 0, 0);
  if (first && a->player && atomic_load(&a->renderActive)) {
      stackchanDebugTransition(DEBUG_FLUSH_BEGIN, atomic_load(&a->interruptRequest), 1, 0);
      int flushResult = av_render_flush(a->player);
      stackchanDebugTransition(DEBUG_FLUSH_END, atomic_load(&a->interruptRequest), 1, flushResult);
  }
}
void liveAudioClose(LiveAudio *a)
{
	if (!a) return;
  portENTER_CRITICAL(&audioLock);
  if (activeAudio == a) activeAudio = NULL;
  portEXIT_CRITICAL(&audioLock);
	liveAudioStop(a);
	if (a->capture) esp_capture_close(a->capture);
	if (a->player) av_render_close(a->player);
	if (a->render) audio_render_free_handle(a->render);
    stackchanOpusDecodeRate(0);
	while (a->taskStarted && !atomic_load(&a->done)) vTaskDelay(pdMS_TO_TICKS(10));
    livePitchClose(a->pitch);
	if (a->rxEnabled) i2s_channel_disable(a->rx);
	if (a->txEnabled) i2s_channel_disable(a->tx);
	if (a->rx) i2s_del_channel(a->rx);
	if (a->tx) i2s_del_channel(a->tx);
    if (liveCodecClose(&a->codec)) modLog("Live codec restoration failed");
	if (a->aec) aec_destroy(a->aec);
	if (a->input) audioStreamDelete(a->input);
	if (a->output) audioStreamDelete(a->output);
	free(a->buffers);
	free(a);
}
void liveAudioMute(LiveAudio *a, bool mute) {
  if (a) atomic_store(&a->muted, mute);
  // Keep capture/encoder/RTP alive until session.closed. Stopping the source
  // here used to terminate AUD_SRC before the close handshake had finished.
  if (a && atomic_exchange(&quiesceAudio, false)) atomic_store(&a->quiesced, true);
}
void xs_live_audio_quiesce(xsMachine *the) {
  // Do not wait for the peer task, which can be blocked in signaling. The
  // lifetime lock protects this pointer; only an atomic flag changes here.
  atomic_store(&quiesceAudio, true);
  portENTER_CRITICAL(&audioLock);
  if (activeAudio) atomic_store(&activeAudio->quiesced, true);
  portEXIT_CRITICAL(&audioLock);
}
bool liveAudioRequestInterrupt(void) {
    bool requested = false;
    portENTER_CRITICAL(&audioLock);
    if (activeAudio && activeAudio->bargeIn && !atomic_load(&activeAudio->muted) &&
        !atomic_load(&activeAudio->stopping) && !atomic_load(&activeAudio->quiesced)) {
        atomic_store(&activeAudio->yieldOutput, true);
        atomic_store(&activeAudio->discardOutput, true);
        atomic_fetch_add(&activeAudio->interruptRequest, 1);
        stackchanDebugTransition(DEBUG_INTERRUPT, atomic_load(&activeAudio->interruptRequest), 0, 0);
        requested = true;
    }
    portEXIT_CRITICAL(&audioLock);
    return requested;
}
void liveAudioResumeOutput(void) {
    portENTER_CRITICAL(&audioLock);
    if (activeAudio) {
        atomic_store(&activeAudio->resumeRequest, atomic_load(&activeAudio->interruptRequest));
        stackchanDebugTransition(DEBUG_RESUME, atomic_load(&activeAudio->interruptRequest), 0, 0);
    }
    portEXIT_CRITICAL(&audioLock);
}
int liveAudioFlushOutput(LiveAudio *a) {
    if (!a || atomic_load(&a->stopping)) return 0;
    unsigned request = atomic_load(&a->interruptRequest);
    if (request == atomic_load(&a->interruptFlushed)) return 0;
    stackchanDebugTransition(DEBUG_FLUSH_BEGIN, request, 0, 0);
    int err = 0;
    if (a->player && atomic_load(&a->renderActive)) err = av_render_flush(a->player);
    if (!err) atomic_store(&a->interruptFlushed, request);
    else a->stage = "render_flush";
    stackchanDebugTransition(DEBUG_FLUSH_END, request, 0, err);
    return err;
}
void liveAudioVolume(LiveAudio *a, unsigned volume) { if (a) atomic_store(&a->volume, volume); }
int liveAudioError(LiveAudio *a) { return a ? atomic_load(&a->error) : 0; }
const char *liveAudioStage(LiveAudio *a) { return a ? a->stage : "audio_allocate"; }
void liveAudioStats(LiveAudio *a, LiveAudioStats *s)
{
	if (!a) return;
	*s = (LiveAudioStats){atomic_load(&a->captured), atomic_load(&a->rendered), atomic_load(&a->underruns),
		atomic_load(&a->overruns), atomic_load(&a->micLevel), atomic_load(&a->cleanLevel), atomic_load(&a->referenceLevel), atomic_load(&a->outputIdleMs), atomic_load(&a->silenceMs), atomic_load(&a->maxSilenceMs), atomic_load(&a->sourceSamples), atomic_load(&a->requestedRate), atomic_load(&a->requestedChannels), atomic_load(&a->sourceFrameBytes)};
	s->audibleMs = atomic_load(&a->audibleMs);
    s->playbackLevel = atomic_load(&a->playbackLevel);
    s->interruptions = atomic_load(&a->interruptRequest);
    s->flushedInterruptions = atomic_load(&a->interruptFlushed);
}

void xs_io_audio_levels(xsMachine *the) {
  unsigned level = 0, reference = 0, idle = 10000;
  portENTER_CRITICAL(&audioLock);
  if (activeAudio) {
    level = atomic_load(&activeAudio->playbackLevel);
    reference = atomic_load(&activeAudio->referenceLevel);
    idle = atomic_load(&activeAudio->outputIdleMs);
  }
  portEXIT_CRITICAL(&audioLock);
  xsmcVars(1); xsmcSetNewObject(xsResult);
  xsmcSetInteger(xsVar(0),level); xsmcSet(xsResult,xsID("playbackLevel"),xsVar(0));
  xsmcSetInteger(xsVar(0),reference); xsmcSet(xsResult,xsID("referenceLevel"),xsVar(0));
  xsmcSetInteger(xsVar(0),idle); xsmcSet(xsResult,xsID("outputIdleMs"),xsVar(0));
}
