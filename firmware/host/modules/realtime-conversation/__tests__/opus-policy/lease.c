#include "platform.h"
#include <assert.h>
#include <string.h>
static esp_audio_enc_ops_t encoder;
static esp_audio_dec_ops_t decoder;
static esp_opus_dec_cfg_t opened;
static int decode(void *options, uint32_t size, void **handle) {
    assert(size == sizeof(opened)); opened = *(esp_opus_dec_cfg_t *)options; *handle = &opened; return 0;
}
const esp_audio_enc_ops_t *esp_audio_enc_get_ops(int type) { assert(type == ESP_AUDIO_TYPE_OPUS); return &encoder; }
const esp_audio_dec_ops_t *esp_audio_dec_get_ops(int type) { assert(type == ESP_AUDIO_TYPE_OPUS); return &decoder; }
int esp_audio_enc_register(int type, const esp_audio_enc_ops_t *ops) { assert(type == ESP_AUDIO_TYPE_OPUS); encoder = *ops; return 0; }
int esp_audio_dec_register(int type, const esp_audio_dec_ops_t *ops) { assert(type == ESP_AUDIO_TYPE_OPUS); decoder = *ops; return 0; }
void esp_audio_enc_unregister(int type) { assert(type == ESP_AUDIO_TYPE_OPUS); }
void esp_audio_dec_unregister(int type) { assert(type == ESP_AUDIO_TYPE_OPUS); }
extern int stackchanInstallOpusPolicy(void);
extern void stackchanOpusDecodeRate(unsigned);
static void check(int requested, int expected) {
    esp_opus_dec_cfg_t config = {.sample_rate = requested, .channel = 2}, before = config;
    void *handle = 0;
    assert(!decoder.open(&config, sizeof(config), &handle));
    assert(handle && opened.sample_rate == expected && opened.channel == 1);
    assert(!memcmp(&config, &before, sizeof(config)));
}
int main(void) {
    encoder.open = decode; decoder.open = decode;
    assert(!stackchanInstallOpusPolicy());
    check(48000, 48000); check(24000, 24000);
    stackchanOpusDecodeRate(16000);
    assert(!stackchanInstallOpusPolicy());
    check(48000, 16000); check(24000, 16000);
    stackchanOpusDecodeRate(0);
    check(48000, 48000); check(24000, 24000);
    stackchanOpusDecodeRate(16000); check(48000, 16000);
    stackchanOpusDecodeRate(0); check(48000, 48000);
    return 0;
}
