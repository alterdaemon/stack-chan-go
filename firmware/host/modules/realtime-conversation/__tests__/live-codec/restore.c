#include "../../esp32/liveCodec.h"
#include <assert.h>
#include <string.h>
static uint8_t registers[256], original[256];
static unsigned calls, failAt, devices, writes;
static bool failAfterWrite;
static int touch(void) { return ++calls == failAt ? 17 : 0; }
static void setup(void) {
    assert(!devices);
    memset(registers, 0, sizeof(registers));
    registers[0x08] = 0x10; registers[0x11] = 0x60;
    registers[0x43] = 0x1b; registers[0x44] = 0x19;
    memcpy(original, registers, sizeof(original));
    calls = writes = failAt = 0; failAfterWrite = false;
}
static void restored(void) { assert(!devices && !memcmp(registers, original, sizeof(original))); }
int i2c_master_get_bus_handle(unsigned port, i2c_master_bus_handle_t *bus) { *bus = port ? NULL : registers; return 0; }
int i2c_master_probe(i2c_master_bus_handle_t bus, unsigned address, unsigned wait) {
    (void)wait; assert(bus == registers && address == 0x40); return 0;
}
int i2c_master_bus_add_device(i2c_master_bus_handle_t bus, const i2c_device_config_t *cfg, i2c_master_dev_handle_t *out) {
    assert(bus == registers && cfg->device_address == 0x40 && !devices);
    int error = touch();
    if (!error) { *out = registers; devices++; }
    return error;
}
int i2c_master_bus_rm_device(i2c_master_dev_handle_t device) {
    assert(device == registers && devices == 1); devices--; return 0;
}
int i2c_master_transmit_receive(i2c_master_dev_handle_t device, const uint8_t *reg, size_t n, uint8_t *value, size_t m, unsigned wait) {
    (void)wait; assert(device == registers && devices && n == 1 && m == 1);
    int error = touch(); if (!error) *value = registers[*reg]; return error;
}
int i2c_master_transmit(i2c_master_dev_handle_t device, const uint8_t *data, size_t n, unsigned wait) {
    (void)wait; assert(device == registers && devices && n == 2);
    assert(data[0] == 0x43 || data[0] == 0x44);
    int error = touch(); if (!error || failAfterWrite) { registers[data[0]] = data[1]; writes++; }
    return error;
}
int main(void) {
    setup(); LiveCodec codec = {0};
    assert(!liveCodecOpen(&codec, 6)); unsigned openCalls = calls;
    assert(devices == 1 && registers[0x43] == 0x12 && registers[0x44] == 0x12);
    assert(codec.captureGainQ10 > 22 * 1024 && codec.captureGainQ10 < 23 * 1024);
    calls = 0; assert(!liveCodecClose(&codec)); unsigned closeCalls = calls; restored();
    for (unsigned after = 0; after < 2; after++) for (unsigned fault = 1; fault <= openCalls; fault++) {
        setup(); codec = (LiveCodec){0}; failAt = fault; failAfterWrite = after;
        assert(liveCodecOpen(&codec, 6)); failAt = 0;
        assert(!liveCodecClose(&codec)); restored(); assert(!liveCodecClose(&codec));
    }
    for (unsigned fault = 1; fault <= closeCalls; fault++) {
        setup(); codec = (LiveCodec){0}; assert(!liveCodecOpen(&codec, 6));
        calls = 0; failAt = fault; assert(!liveCodecClose(&codec)); restored();
    }
    setup(); registers[0x11] = 0xff; codec = (LiveCodec){0};
    assert(liveCodecOpen(&codec, 6) == ESP_ERR_INVALID_STATE && !writes && !devices);
    return 0;
}
