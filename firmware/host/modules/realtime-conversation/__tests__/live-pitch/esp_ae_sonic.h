// Test double for the Sonic interface, not a replacement DSP implementation.
#include <stdint.h>
typedef void *esp_ae_sonic_handle_t;
typedef struct { uint32_t sample_rate; uint8_t channel, bits_per_sample; } esp_ae_sonic_cfg_t;
typedef struct { void *samples; uint32_t num, consume_num; } esp_ae_sonic_in_data_t;
typedef struct { void *samples; uint32_t needed_num, out_num; } esp_ae_sonic_out_data_t;
enum { ESP_AE_ERR_OK = 0, ESP_AE_ERR_FAIL = -1, ESP_AE_ERR_MEM_LACK = -2, ESP_AE_ERR_INVALID_PARAMETER = -3 };
int esp_ae_sonic_open(esp_ae_sonic_cfg_t *, esp_ae_sonic_handle_t *);
int esp_ae_sonic_set_speed(esp_ae_sonic_handle_t, float);
int esp_ae_sonic_set_pitch(esp_ae_sonic_handle_t, float);
int esp_ae_sonic_process(esp_ae_sonic_handle_t, esp_ae_sonic_in_data_t *, esp_ae_sonic_out_data_t *);
void esp_ae_sonic_close(esp_ae_sonic_handle_t);
