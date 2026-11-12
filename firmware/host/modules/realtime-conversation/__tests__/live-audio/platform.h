#ifndef LIVE_AUDIO_TEST_PLATFORM_H
#define LIVE_AUDIO_TEST_PLATFORM_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {} xsMachine;
#define xsmcVars(...) ((void)0)
#define xsmcSetNewObject(...) ((void)0)
#define xsmcSetInteger(...) ((void)0)
#define xsmcSet(...) ((void)0)
typedef int portMUX_TYPE;
#define portMUX_INITIALIZER_UNLOCKED 0
#define portENTER_CRITICAL(lock) ((void)(lock))
#define portEXIT_CRITICAL(lock) ((void)(lock))
typedef unsigned UBaseType_t;
typedef struct {} StaticStreamBuffer_t;
typedef struct Stream *StreamBufferHandle_t;
#define pdMS_TO_TICKS(ms) (ms)
#define pdPASS 1
size_t xStreamBufferReceive(StreamBufferHandle_t, void *, size_t, unsigned);
size_t xStreamBufferSend(StreamBufferHandle_t, const void *, size_t, unsigned);
size_t xStreamBufferSpacesAvailable(StreamBufferHandle_t);
size_t xStreamBufferBytesAvailable(StreamBufferHandle_t);
StreamBufferHandle_t xStreamBufferCreateStatic(size_t, size_t, uint8_t *, StaticStreamBuffer_t *);
void vStreamBufferDelete(StreamBufferHandle_t);
void vTaskDelay(unsigned);
void vTaskDelete(void *);
UBaseType_t uxTaskPriorityGet(void *);
void vTaskPrioritySet(void *, UBaseType_t);
int xTaskCreatePinnedToCore(void (*)(void *), const char *, unsigned, void *, unsigned, void *, int);

typedef int esp_err_t;
#define ESP_ERR_NO_MEM 1
#define ESP_ERR_INVALID_SIZE 2
#define MALLOC_CAP_SPIRAM 1
#define MALLOC_CAP_8BIT 2
void *heap_caps_malloc(size_t, unsigned);
void *heap_caps_aligned_calloc(size_t, size_t, size_t, unsigned);
int64_t esp_timer_get_time(void);

// The test uses a shared duplex bus, as the CoreS3 manifests require.
#define MODDEF_AUDIOOUT_I2S_NUM 1
#define MODDEF_AUDIOIN_I2S_NUM 1
#define MODDEF_AUDIOOUT_I2S_BCK_PIN 34
#define MODDEF_AUDIOIN_I2S_BCK_PIN 34
#define MODDEF_AUDIOOUT_I2S_LR_PIN 33
#define MODDEF_AUDIOIN_I2S_LR_PIN 33
#define MODDEF_AUDIOOUT_I2S_MCK_PIN 0
#define MODDEF_AUDIOIN_I2S_MCK_PIN 0
#define MODDEF_AUDIOOUT_I2S_DATAOUT_PIN 13
#define MODDEF_AUDIOIN_I2S_DATAIN 14
#define MODDEF_AUDIOIN_I2S_FORMAT_I2S 1

typedef void *i2s_chan_handle_t;
typedef struct { unsigned dma_desc_num, dma_frame_num; bool auto_clear; } i2s_chan_config_t;
#define I2S_CHANNEL_DEFAULT_CONFIG(...) ((i2s_chan_config_t){0})
#define I2S_STD_CLK_DEFAULT_CONFIG(...) 0
#define I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(...) 0
typedef struct {
    int clk_cfg, slot_cfg;
    struct { int mclk, bclk, ws, dout, din; } gpio_cfg;
} i2s_std_config_t;
int i2s_channel_write(i2s_chan_handle_t, const void *, size_t, size_t *, uint32_t);
int i2s_channel_read(i2s_chan_handle_t, void *, size_t, size_t *, uint32_t);
int i2s_new_channel(const i2s_chan_config_t *, i2s_chan_handle_t *, i2s_chan_handle_t *);
int i2s_channel_init_std_mode(i2s_chan_handle_t, const i2s_std_config_t *);
int i2s_channel_enable(i2s_chan_handle_t);
int i2s_channel_disable(i2s_chan_handle_t);
int i2s_del_channel(i2s_chan_handle_t);

typedef void *esp_ae_rate_cvt_handle_t;
typedef struct { unsigned src_rate, dest_rate, channel, bits_per_sample, complexity, perf_type; } esp_ae_rate_cvt_cfg_t;
#define ESP_AE_RATE_CVT_PERF_TYPE_SPEED 1
int esp_ae_rate_cvt_open(const esp_ae_rate_cvt_cfg_t *, esp_ae_rate_cvt_handle_t *);
int esp_ae_rate_cvt_process(esp_ae_rate_cvt_handle_t, int16_t *, uint32_t, int16_t *, uint32_t *);
void esp_ae_rate_cvt_close(esp_ae_rate_cvt_handle_t);

typedef struct { unsigned count; } aec_handle_t;
typedef struct { unsigned mic_num, ref_num, out_num, filter_length, sample_rate, caps, mode, nlp_level; } aec_config_t;
#define AEC_MODE_FD_LOW_COST 1
#define AEC_NLP_LEVEL_AGGR 1
aec_handle_t *aec_create_from_config(aec_config_t *);
int aec_get_chunksize(aec_handle_t *);
void aec_process(const aec_handle_t *, int16_t *, int16_t *, int16_t *);
void aec_destroy(aec_handle_t *);

typedef int esp_capture_err_t;
typedef int esp_capture_format_id_t;
#define ESP_CAPTURE_ERR_OK 0
#define ESP_CAPTURE_ERR_NOT_SUPPORTED 1
#define ESP_CAPTURE_FMT_ID_PCM 1
#define ESP_CAPTURE_SYNC_MODE_AUDIO 1
typedef struct { unsigned format_id, sample_rate, channel, bits_per_sample; } esp_capture_audio_info_t;
typedef struct { uint8_t *data; unsigned size, pts; } esp_capture_stream_frame_t;
typedef struct esp_capture_audio_src_if_t esp_capture_audio_src_if_t;
struct esp_capture_audio_src_if_t {
    int (*open)(esp_capture_audio_src_if_t *);
    int (*get_support_codecs)(esp_capture_audio_src_if_t *, const int **, uint8_t *);
    int (*negotiate_caps)(esp_capture_audio_src_if_t *, esp_capture_audio_info_t *, esp_capture_audio_info_t *);
    int (*start)(esp_capture_audio_src_if_t *);
    int (*read_frame)(esp_capture_audio_src_if_t *, esp_capture_stream_frame_t *);
    int (*abort)(esp_capture_audio_src_if_t *);
    int (*stop)(esp_capture_audio_src_if_t *);
    int (*close)(esp_capture_audio_src_if_t *);
};
typedef void *esp_capture_handle_t;
typedef struct { int sync_mode; esp_capture_audio_src_if_t *audio_src; } esp_capture_cfg_t;
int esp_capture_open(esp_capture_cfg_t *, esp_capture_handle_t *);
void esp_capture_close(esp_capture_handle_t);

typedef void *audio_render_handle_t;
typedef void *av_render_handle_t;
typedef struct { unsigned sample_rate, channel, bits_per_sample; } av_render_audio_frame_info_t;
typedef struct { uint8_t *data; unsigned size; } av_render_audio_frame_t;
typedef struct {
    struct {
        audio_render_handle_t (*init)(void *, int);
        int (*open)(audio_render_handle_t, av_render_audio_frame_info_t *);
        int (*write)(audio_render_handle_t, av_render_audio_frame_t *);
        int (*get_latency)(audio_render_handle_t, uint32_t *);
        int (*get_frame_info)(audio_render_handle_t, av_render_audio_frame_info_t *);
        int (*close)(audio_render_handle_t);
        void (*deinit)(audio_render_handle_t);
    } ops;
    void *cfg;
    size_t cfg_size;
} audio_render_cfg_t;
typedef struct { audio_render_handle_t audio_render; unsigned audio_raw_fifo_size, audio_render_fifo_size; bool allow_drop_data; } av_render_cfg_t;
#define ESP_MEDIA_ERR_WRONG_STATE 1
audio_render_handle_t audio_render_alloc_handle(audio_render_cfg_t *);
av_render_handle_t av_render_open(av_render_cfg_t *);
int av_render_set_fixed_frame_info(av_render_handle_t, av_render_audio_frame_info_t *);
int av_render_flush(av_render_handle_t);
void av_render_close(av_render_handle_t);
void audio_render_free_handle(audio_render_handle_t);
typedef struct { esp_capture_handle_t capture; av_render_handle_t player; } esp_webrtc_media_provider_t;
#endif
