#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
typedef void *i2c_master_dev_handle_t;
typedef void *i2c_master_bus_handle_t;
typedef struct { unsigned dev_addr_length, device_address, scl_speed_hz; } i2c_device_config_t;
#define I2C_ADDR_BIT_LEN_7 7
#define ESP_OK 0
#define ESP_ERR_INVALID_RESPONSE 1
#define ESP_ERR_INVALID_STATE 2
#define ESP_ERR_NOT_FOUND 3
int i2c_master_get_bus_handle(unsigned, i2c_master_bus_handle_t *);
int i2c_master_probe(i2c_master_bus_handle_t, unsigned, unsigned);
int i2c_master_bus_add_device(i2c_master_bus_handle_t, const i2c_device_config_t *, i2c_master_dev_handle_t *);
int i2c_master_bus_rm_device(i2c_master_dev_handle_t);
int i2c_master_transmit_receive(i2c_master_dev_handle_t, const uint8_t *, size_t, uint8_t *, size_t, unsigned);
int i2c_master_transmit(i2c_master_dev_handle_t, const uint8_t *, size_t, unsigned);
