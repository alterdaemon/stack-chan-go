#!/usr/bin/env python3
"""Generate isolated R14 diagnostic variants; never modify the installed SDK."""
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[7]
OUT = ROOT / 'internal/diagnostics/r14-complete'
OUT.mkdir(parents=True, exist_ok=True)
identities = {}

def output(name, text):
    path = OUT / name
    if not path.exists() or path.read_text() != text:
        path.write_text(text)



def source(relative):
    path = ROOT / relative
    data = path.read_bytes()
    identities[relative] = hashlib.sha256(data).hexdigest()
    return data.decode()


def replace(text, old, new, count=1):
    assert text.count(old) == count, (old, text.count(old), count)
    return text.replace(old, new)


audio = source('firmware/host/modules/realtime-conversation/esp32/liveAudio.c')
audio = audio.replace('#include "livePitch.h"', '#include "livePitch.h"\n#include "r14-config.h"')
audio = replace(audio, '#define BLOCK 480', '#define BLOCK (r14Rate / 100)')
audio = replace(audio, '#define DMA_BLOCKS 3', '#define DMA_BLOCKS r14DMA')
audio = replace(audio, '#define PLAYBACK_BYTES 19200', '#define PLAYBACK_BYTES (r14Rate * 2 / 5)')
audio = audio.replace('== 48000', '== r14Rate').replace('.sample_rate = 48000', '.sample_rate = r14Rate')
audio = audio.replace('.src_rate = 48000', '.src_rate = r14Rate').replace('I2S_STD_CLK_DEFAULT_CONFIG(48000)', 'I2S_STD_CLK_DEFAULT_CONFIG(r14Rate)')
audio = replace(audio, 'if (err) { atomic_store(&a->error, err); break; }', 'if (err) { a->stage = "resampler_process"; atomic_store(&a->error, err); break; }')
audio = replace(audio, ' / 96 + DMA_BLOCKS * 10', ' / (r14Rate / 500) + DMA_BLOCKS * 10')
audio = replace(audio, 'int16_t *buffers;', 'int16_t *buffers;\n    bool probeInternal, probeStream;\n    unsigned probePriming, probeOutFrames;')
audio = replace(audio, 'int16_t *reference = converted + BLOCK * 2;', 'int16_t *reference = converted + a->probeOutFrames * 2;')
audio = replace(audio, 'uint32_t count = BLOCK;', 'uint32_t count = a->probeOutFrames;')
audio = replace(audio, 'if (bargeIn) a->aecFrame = a->buffers + BLOCK * (8 + DMA_BLOCKS) + a->chunk * 2;', '''if (bargeIn) {
        a->aecFrame = a->buffers + BLOCK * (8 + DMA_BLOCKS) + a->chunk * 2;
        if (r14Internal) {
            int16_t *internal = heap_caps_aligned_calloc(16, a->chunk * 3, 2, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
            if (!internal) return ESP_ERR_NO_MEM;
            a->aecFrame = internal;
            a->probeInternal = true;
        }
    }''')
# Avoid retaining duplicate planes in the SRAM experiment.
audio = replace(audio, 'a->chunk * (bargeIn ? 5 : 3)', 'a->chunk * (bargeIn ? (r14Internal ? 2 : 5) : 3)')
start, end = audio.index('\ta->buffers = heap_caps_aligned_calloc'), audio.index('\ti2s_chan_config_t channel')
buffer_at = audio.index('\tesp_ae_rate_cvt_cfg_t rate', start, end)
buffers, resampler = audio[start:buffer_at], audio[buffer_at:end]
buffers = replace(buffers, 'BLOCK * (8 + DMA_BLOCKS)', 'probeBase', count=2)
audio = audio[:start] + resampler + '''    uint32_t capacity = 0;
    a->stage = "resampler_capacity";
    err = esp_ae_rate_cvt_get_max_out_sample_num(a->resampler, BLOCK, &capacity);
    if (err) return err;
    if (!capacity || capacity > 960) return ESP_ERR_INVALID_SIZE;
    a->probeOutFrames = capacity > BLOCK ? (capacity + 3) & ~3u : BLOCK;
    size_t probeBase = BLOCK * (6 + DMA_BLOCKS) + a->probeOutFrames * 2;
    a->stage = "audio_buffers";
''' + buffers + audio[end:]
audio = replace(audio, '\tfree(a->buffers);', '\tif (a->probeInternal) free(a->aecFrame);\n\tfree(a->buffers);')
audio = replace(audio, '  activeAudio = a;', '  activeAudio = a;\n  r14LocalAudio = a;')
audio = replace(audio, '  if (activeAudio == a) activeAudio = NULL;', '  if (activeAudio == a) activeAudio = NULL;\n  if (r14LocalAudio == a) r14LocalAudio = NULL;')
audio = replace(audio, 'unsigned m = 0, r = 0, c = 0;', '''unsigned m = 0, r = 0, c = 0;
    if (r14MeterEvery > 1 && (++r14MeterFrame % r14MeterEvery)) {
        if (atomic_load(&a->muted)) memset(clean, 0, a->chunk * 2);
        atomic_fetch_add(&a->captured, a->chunk);
        return;
    }''')
audio = replace(audio, '\t\t/* Non-blocking dequeue:', '''        r14AudioTick(a->tx, a->rx);
\t\t/* Non-blocking dequeue:''')
audio = replace(audio, 'got = xStreamBufferReceive(a->output, tx, BLOCK * 2, 0);', '''size_t available = xStreamBufferBytesAvailable(a->output);
            if (!a->probePriming && r14Priming &&
                available < r14Rate * 2 * r14Priming / 1000 && !r14Tail) {
                got = 0;
            } else {
                a->probePriming = 1;
                got = xStreamBufferReceive(a->output, tx, BLOCK * 2, 0);
            }
            r14OutputRead(available, got, tx, BLOCK * 2);''')
audio = replace(audio, 'a->stage = "i2s_enable_rx";', '''a->stage = "probe_i2s_callbacks";
    r14RegisterAudio(a->tx, a->rx);
    a->stage = "i2s_enable_rx";''')
audio += '''
// Calls the actual statistics implementation, preserving mute and accounting.
void xs_r14_meter_bench(xsMachine *the) {
    int every = xsmcToInteger(xsArg(0));
    LiveAudio a = {.chunk = 512};
    int16_t data[1536];
    for (unsigned i = 0; i < 1536; i++) data[i] = (int16_t)(i * 137);
    r14MeterEvery = every; r14MeterFrame = 0;
    TaskStatus_t before, after;
    vTaskDelay(1);
    vTaskGetInfo(NULL, &before, pdFALSE, eInvalid);
    int64_t began = esp_timer_get_time();
    for (unsigned i = 0; i < 4000; i++) captureStats(&a, data, data + 512, data + 1024);
    int64_t elapsed = esp_timer_get_time() - began;
    vTaskDelay(1);
    vTaskGetInfo(NULL, &after, pdFALSE, eInvalid);
    r14MeterEvery = 1;
    if (atomic_load(&a.captured) != 4000 * 512) xsUnknownError("meter accounting");
    xsmcVars(1); xsmcSetNewObject(xsResult);
    xsmcSetNumber(xsVar(0), elapsed); xsmcSet(xsResult, xsID("elapsedUs"), xsVar(0));
    xsmcSetNumber(xsVar(0), after.ulRunTimeCounter - before.ulRunTimeCounter); xsmcSet(xsResult, xsID("cpuUs"), xsVar(0));
}
void xs_r14_local_open(xsMachine *the) {
    esp_webrtc_media_provider_t provider = {0};
    LiveAudio *a = NULL;
    int err = liveAudioOpen(&a, &provider, xsmcToBoolean(xsArg(0)), xsmcToInteger(xsArg(1)), true);
    if (err) { liveAudioClose(a); xsUnknownError("local open %d", err); }
    r14LocalAudio = a;
    sourceStart(&a->source);
}
void xs_r14_local_feed(xsMachine *the) {
    LiveAudio *a = r14LocalAudio;
    if (!a) xsUnknownError("local audio not open");
    int16_t data[480];
    if (!a->probeStream) {
        av_render_audio_info_t info = {.codec = AV_RENDER_AUDIO_CODEC_PCM, .sample_rate = r14Rate, .channel = 1, .bits_per_sample = 16};
        int err = av_render_add_audio_stream(a->player, &info);
        if (err) xsUnknownError("local PCM stream %d", err);
        a->probeStream = true;
    }
    unsigned start = r14FeedSample;
    for (unsigned i = 0; i < BLOCK; i++) {
        int amplitude = ((r14FeedSample / (r14Rate / 10)) % 10) * 400;
        data[i] = ((r14FeedSample++ % (r14Rate / 220)) < (r14Rate / 440)) ? amplitude : -amplitude;
    }
    av_render_audio_data_t frame = {.data = (uint8_t *)data, .size = BLOCK * 2, .pts = start / (r14Rate / 1000)};
    int err = av_render_add_audio_data(a->player, &frame);
    if (err) xsUnknownError("local PCM feed %d", err);
    xsmcSetInteger(xsResult, BLOCK * 2);
}
void xs_r14_local_packet(xsMachine *the) {
    LiveAudio *a = r14LocalAudio;
    if (!a) xsUnknownError("local audio not open");
    if (!a->probeStream) {
        av_render_audio_info_t info = {.codec = AV_RENDER_AUDIO_CODEC_OPUS, .sample_rate = 48000, .channel = 2, .bits_per_sample = 16};
        int err = av_render_add_audio_stream(a->player, &info);
        if (err) xsUnknownError("local Opus stream %d", err);
        a->probeStream = true;
    }
    void *data; xsUnsignedValue bytes;
    xsmcGetBufferReadable(xsArg(0), &data, &bytes);
    unsigned offset = xsmcToInteger(xsArg(1)), size = xsmcToInteger(xsArg(2));
    if (offset > bytes || !size || size > bytes - offset || size > 1275) xsRangeError("Opus fixture bounds");
    av_render_audio_data_t frame = {.data = (uint8_t *)data + offset, .size = size, .pts = xsmcToInteger(xsArg(3))};
    int err = av_render_add_audio_data(a->player, &frame);
    if (err) xsUnknownError("local Opus feed %d", err);
}
void xs_r14_local_read(xsMachine *the) {
    LiveAudio *a = r14LocalAudio;
    if (!a) xsUnknownError("local audio not open");
    int16_t data[320];
    size_t available = xStreamBufferBytesAvailable(a->input);
    // Never block the XS event loop waiting for a capture chunk.
    if (available < (a->aec ? a->chunk * 4 : sizeof(data))) { xsmcSetInteger(xsResult, 0); return; }
    esp_capture_stream_frame_t frame = {.data = (uint8_t *)data, .size = sizeof(data)};
    int err = sourceRead(&a->source, &frame);
    if (err) xsUnknownError("local capture %d", err);
    xsmcSetInteger(xsResult, frame.size);
}
void xs_r14_local_close(xsMachine *the) {
    LiveAudio *a = r14LocalAudio;
    r14LocalAudio = NULL;
    if (a) liveAudioClose(a);
}
'''
output('liveAudio.c', audio)

pitch = source('firmware/host/modules/realtime-conversation/esp32/livePitch.c')
pitch = pitch.replace('#include "livePitch.h"', '#include "livePitch.h"\n#include "r14-config.h"')
pitch = replace(pitch, '#define PITCH_BLOCK 480', '#define PITCH_BLOCK (r14Rate / 100)')
pitch = replace(pitch, 'input[PITCH_BLOCK]', 'input[480]')
pitch = replace(pitch, '.sample_rate = 48000', '.sample_rate = r14Rate')
output('livePitch.c', pitch)

opus = source('firmware/host/platforms/m5stackchan_cores3/opus-policy.c')
opus = '#include "r14-config.h"\n' + opus
opus = replace(opus, 'config.channel = 1;', 'config.channel = 1;\n  config.sample_rate = r14Rate;')
output('opus-policy.c', opus)

session = source('firmware/mods/examples/openai_live_webrtc/session.js')
session = replace(session, 'this.amp.sampleRate = 48000', "this.amp.sampleRate = native('xs_r14_rate')()")
output('session.js', session)

mod = source('firmware/mods/examples/openai_live_webrtc/mod.js')
mod = replace(mod, '}, 100)', '}, globalThis.r14MouthInterval ?? 100)')
mod = replace(mod, 'const level = levels.levels().playbackLevel ?? 0', '''globalThis.r14MouthCallbacks = (globalThis.r14MouthCallbacks ?? 0) + 1
          const level = levels.levels().playbackLevel ?? 0''')
output('mod.js', mod)

worker = source('firmware/host/modules/realtime-conversation/http-worker.js')
worker = replace(worker, 'const response = await requestHttps(request, platform, setCancel)', '''const response = request.host === 'r14-fixture.invalid'
        ? await new Promise((resolve, reject) => {
            const timer = Timer.set(() => resolve({
              status: 200,
              body: ArrayBuffer.fromString(JSON.stringify({
                status: 'completed',
                output: [
                  { type: 'web_search_call', status: 'completed' },
                  { type: 'message', content: [{
                    type: 'output_text', text: 'R14 fixture answer.',
                    annotations: [{ type: 'url_citation', url: 'https://docs.espressif.com/', title: 'Fixture' }],
                  }] },
                ],
              })),
            }), request.path === '/fast' ? 20 : 2000)
            setCancel(() => {
              Timer.clear(timer)
              reject(new Error('fixture_cancelled'))
            })
          })
        : await requestHttps(request, platform, setCancel)''')
output('http-worker.js', worker)

spi = source('firmware/host/platforms/m5stackchan_cores3/spi/modSPI.c')
spi = '#include "r14-config.h"\n' + spi
spi = replace(spi, 'trans->length = bitsOut;', 'trans->length = bitsOut;\n    atomic_fetch_add(&r14SPIBytes, (bitsOut + 7) / 8);')
output('modSPI.c', spi)

for name in ['r14-config.h', 'complete.c', 'decoder-bench.c']:
    output(name, (Path(__file__).parent / name).read_text())
(OUT / 'source-identities.json').write_text(json.dumps(identities, indent=2) + '\n')
followup = os.environ.get('STACKCHAN_R14_FOLLOWUP', '')
assert followup in ('', '1', 'provider', 'priming-cancel')
output('run-options.js', 'export default ' + json.dumps({
    'only': {'': '', '1': 'P08,P08-cancel,P10,P12-delay', 'provider': 'provider',
             'priming-cancel': 'P08-cancel,provider'}[followup],
    'workerReplay': followup == '1',
    'providerFresh': followup in ('provider', 'priming-cancel'),
    'providerLiveOnly': followup == 'priming-cancel',
}) + '\n')
print('Generated isolated diagnostic variants:', ', '.join(identities))
