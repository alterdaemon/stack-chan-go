// SPDX-License-Identifier: Apache-2.0
#include "esp_attr.h"
#include "esp_system.h"
#include "esp_private/panic_internal.h"
#include "soc/soc.h"
#include <string.h>

/* Only code addresses, never stack/register contents. RTC RAM survives a panic
 * reboot; no flash partition or persisted user data is touched. */
static RTC_NOINIT_ATTR struct {
    uint32_t armed, magic, pc, core, exception;
    uint8_t image[32];
} saved;
static uint32_t previous[3];
static bool initialized;
#define PANIC_MAGIC 0x53435043u

void stackchanDebugPanicInfo(const uint8_t image[32], uint32_t output[3]) {
    if (!initialized) {
        if (esp_reset_reason() == ESP_RST_PANIC && saved.magic == PANIC_MAGIC &&
            !memcmp(saved.image, image, 32)) {
            previous[0] = saved.pc; previous[1] = saved.core; previous[2] = saved.exception;
        }
        saved.armed = saved.magic = 0;
        initialized = true;
    }
    memcpy(output, previous, sizeof(previous));
}
void stackchanDebugPanicArm(bool enabled, const uint8_t image[32]) {
    uint32_t ignored[3];
    stackchanDebugPanicInfo(image, ignored);
    saved.armed = 0;
    if (enabled) {
        memcpy(saved.image, image, 32);
        saved.magic = 0;
        saved.armed = PANIC_MAGIC;
    }
}
void __real_esp_panic_handler(panic_info_t *info);
void IRAM_ATTR __wrap_esp_panic_handler(panic_info_t *info) {
    if (saved.armed == PANIC_MAGIC && info) {
        saved.armed = 0;
        uintptr_t pc = (uintptr_t)info->addr;
        saved.pc = ((pc >= SOC_IROM_LOW && pc < SOC_IROM_HIGH) ||
                    (pc >= SOC_IRAM_LOW && pc < SOC_IRAM_HIGH)) ? pc : 0;
        saved.core = info->core;
        saved.exception = info->exception;
        saved.magic = PANIC_MAGIC;
    }
    __real_esp_panic_handler(info);
}
