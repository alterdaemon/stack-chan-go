#ifndef OPUS_POLICY_TEST_PLATFORM_H
#define OPUS_POLICY_TEST_PLATFORM_H
#include <stdint.h>
typedef int esp_audio_err_t;
#define ESP_AUDIO_TYPE_OPUS 1
#define ESP_AUDIO_ERR_OK 0
#define ESP_AUDIO_ERR_INVALID_PARAMETER 1
#define ESP_OPUS_ENC_APPLICATION_LOWDELAY 2
typedef struct { int sample_rate, channel, complexity, bitrate, application_mode; } esp_opus_enc_config_t;
typedef struct { int sample_rate, channel; } esp_opus_dec_cfg_t;
typedef struct { esp_audio_err_t (*open)(void *, uint32_t, void **); } esp_audio_enc_ops_t;
typedef esp_audio_enc_ops_t esp_audio_dec_ops_t;
const esp_audio_enc_ops_t *esp_audio_enc_get_ops(int);
const esp_audio_dec_ops_t *esp_audio_dec_get_ops(int);
int esp_audio_enc_register(int, const esp_audio_enc_ops_t *);
int esp_audio_dec_register(int, const esp_audio_dec_ops_t *);
void esp_audio_enc_unregister(int);
void esp_audio_dec_unregister(int);
#endif
