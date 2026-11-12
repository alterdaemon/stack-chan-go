// Copyright (c) 2026 Shinya Ishikawa
// SPDX-License-Identifier: Apache-2.0
#include <stdbool.h>
#include <math.h>
#include "liveCodec.h"
#include "soc/soc_caps.h"

static int readRegister(LiveCodec *codec, uint8_t reg, uint8_t *value)
{
    return i2c_master_transmit_receive(codec->device, &reg, 1, value, 1, 100);
}

static int writeRegister(LiveCodec *codec, uint8_t reg, uint8_t value)
{
    uint8_t data[] = {reg, value};
    int error = i2c_master_transmit(codec->device, data, sizeof(data), 100);
    uint8_t actual;
    if (!error) error = readRegister(codec, reg, &actual);
    if (!error && actual != value) error = ESP_ERR_INVALID_RESPONSE;
    return error;
}

static int restoreRegister(LiveCodec *codec, uint8_t reg, uint8_t value)
{
    int error = ESP_OK;
    for (unsigned attempt = 0; attempt < 3; attempt++) {
        error = writeRegister(codec, reg, value);
        if (!error) break;
    }
    return error;
}

int liveCodecClose(LiveCodec *codec)
{
    if (!codec->device) return 0;
    int error = 0;
    if (codec->saved) for (unsigned i = 0; i < 2; i++) {
        int result = restoreRegister(codec, 0x43 + i, codec->savedGain[i]);
        if (!error) error = result;
    }
    int result = i2c_master_bus_rm_device(codec->device);
    if (!result) { codec->device = NULL; codec->saved = false; }
    return error ? error : result;
}

int liveCodecOpen(LiveCodec *codec, unsigned gainDb)
{
    if (gainDb > 33 || gainDb % 3) return ESP_ERR_INVALID_STATE;
    i2c_master_bus_handle_t selected = NULL;
    // The SDK's SMBus instance owns the codec. Share its serialized IDF bus;
    // never reset that bus or replace the SDK instance.
    for (unsigned port = 0; port < SOC_I2C_NUM; port++) {
        i2c_master_bus_handle_t bus = NULL;
        if (i2c_master_get_bus_handle(port, &bus) || !bus || i2c_master_probe(bus, 0x40, 100)) continue;
        if (selected) return ESP_ERR_INVALID_STATE;
        selected = bus;
    }
    if (!selected) return ESP_ERR_NOT_FOUND;
    i2c_device_config_t config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = 0x40, .scl_speed_hz = 400000,
    };
    int error = i2c_master_bus_add_device(selected, &config, &codec->device);
    if (error) return error;
    uint8_t mode, format;
    error = readRegister(codec, 0x08, &mode);
    if (!error) error = readRegister(codec, 0x11, &format);
    for (unsigned i = 0; i < 2 && !error; i++) error = readRegister(codec, 0x43 + i, codec->savedGain + i);
    if (!error && (mode != 0x10 || format != 0x60 ||
        (codec->savedGain[0] & 0xf0) != 0x10 || (codec->savedGain[1] & 0xf0) != 0x10)) error = ESP_ERR_INVALID_STATE;
    if (!error) {
        codec->saved = true;
        int originalDb = (codec->savedGain[0] & 0x0f) * 3;
        codec->captureGainQ10 = lroundf(1024 * powf(10.0f, (originalDb - (int)gainDb) / 20.0f));
        // Retain the candidate's ADC headroom; digital restoration happens
        // after echo cancellation rather than clipping the microphone input.
        for (unsigned i = 0; i < 2 && !error; i++)
            error = writeRegister(codec, 0x43 + i, (codec->savedGain[i] & 0xf0) | (gainDb / 3));
    }
    if (error) liveCodecClose(codec);
    return error;
}
