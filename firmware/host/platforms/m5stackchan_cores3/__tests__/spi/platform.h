#pragma once
#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <sched.h>
#include <stdatomic.h>
#define IRAM_ATTR
#define BIT0 1
#define BIT1 2
#define MALLOC_CAP_DMA 0
#define SPI_DMA_CH_AUTO 0
#define SPI_DEVICE_NO_DUMMY 0
#define ESP_OK 0
#define XT_STACK_EXTRA_CLIB 0
#define pdFALSE 0
#define pdTRUE 1
#define portMAX_DELAY 0xffffffff
#define eSetValueWithOverwrite 0
#define c_memset memset
#define taskYIELD() sched_yield()
#define portYIELD_FROM_ISR() ((void)0)
typedef int esp_err_t;
typedef int BaseType_t;
typedef void *TaskHandle_t;
typedef pthread_mutex_t *SemaphoreHandle_t;
typedef unsigned EventBits_t;
typedef struct Events *EventGroupHandle_t;
typedef struct { unsigned flags, cmd, addr, length, rxlength; void *user; const void *tx_buffer; void *rx_buffer; } spi_transaction_t;
typedef void *spi_device_handle_t;
typedef struct { int miso_io_num, mosi_io_num, sclk_io_num, quadwp_io_num, quadhd_io_num, max_transfer_sz; } spi_bus_config_t;
typedef struct { int clock_speed_hz, mode, spics_io_num, queue_size; void (*pre_cb)(spi_transaction_t *), (*post_cb)(spi_transaction_t *); int input_delay_ns, flags; } spi_device_interface_config_t;
typedef struct modSPIConfigurationRecord *modSPIConfiguration;
struct modSPIConfigurationRecord { spi_device_handle_t spi_dev; int cs_pin, spiPort, sync, miso_delay, hz; void (*doChipSelect)(uint8_t, modSPIConfiguration); int mode, clock_pin, mosi_pin, miso_pin; };
void modSPIFlush(void);
void modSPIActivateConfiguration(modSPIConfiguration);
void xSemaphoreTake(SemaphoreHandle_t, unsigned);
void xSemaphoreGive(SemaphoreHandle_t);
SemaphoreHandle_t xSemaphoreCreateMutex(void);
void vSemaphoreDelete(SemaphoreHandle_t);
EventGroupHandle_t xEventGroupCreate(void);
void vEventGroupDelete(EventGroupHandle_t);
unsigned xEventGroupClearBits(EventGroupHandle_t, unsigned);
unsigned xEventGroupSetBits(EventGroupHandle_t, unsigned);
unsigned xEventGroupWaitBits(EventGroupHandle_t, unsigned, int, int, unsigned);
int xTaskCreate(void (*)(void *), const char *, unsigned, void *, unsigned, TaskHandle_t *);
void vTaskDelete(TaskHandle_t);
void xTaskNotify(TaskHandle_t, uintptr_t, unsigned);
void xTaskNotifyFromISR(TaskHandle_t, uintptr_t, unsigned, int *);
void xTaskNotifyWait(unsigned, unsigned, uint32_t *, unsigned);
int spi_bus_initialize(int, spi_bus_config_t *, int);
int spi_bus_free(int);
int spi_bus_add_device(int, spi_device_interface_config_t *, spi_device_handle_t *);
int spi_bus_remove_device(spi_device_handle_t);
int spi_device_transmit(spi_device_handle_t, spi_transaction_t *);
int spi_device_queue_trans(spi_device_handle_t, spi_transaction_t *, unsigned);
int spi_device_get_trans_result(spi_device_handle_t, spi_transaction_t **, unsigned);
void *heap_caps_malloc(size_t, unsigned);
void modLog(const char *);
