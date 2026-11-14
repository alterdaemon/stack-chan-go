// SPDX-License-Identifier: Apache-2.0
#include "esp_attr.h"
#include "esp_system.h"
#include "esp_private/panic_internal.h"
#include "soc/soc.h"
#include "esp_debug_helpers.h"
#include "esp_cpu_utils.h"
#include "xtensa_context.h"
#include <string.h>

/* Only code addresses, never stack/register contents. RTC RAM survives a panic
 * reboot; no flash partition or persisted user data is touched. */
static RTC_NOINIT_ATTR struct {
    uint32_t armed, magic, pc, core, exception;
    uint32_t callers[8];
    uint8_t image[32];
} saved;
static uint32_t previous[11];
static bool initialized;
#define PANIC_MAGIC 0x53435043u

void stackchanDebugPanicInfo(const uint8_t image[32], uint32_t output[11]) {
    if (!initialized) {
        if (esp_reset_reason() == ESP_RST_PANIC && saved.magic == PANIC_MAGIC &&
            !memcmp(saved.image, image, 32)) {
            previous[0] = saved.pc; previous[1] = saved.core; previous[2] = saved.exception;
            memcpy(previous + 3, saved.callers, sizeof(saved.callers));
        }
        saved.armed = saved.magic = 0;
        initialized = true;
    }
    memcpy(output, previous, sizeof(previous));
}
void stackchanDebugPanicArm(bool enabled, const uint8_t image[32]) {
    uint32_t ignored[11];
    stackchanDebugPanicInfo(image, ignored);
    saved.armed = 0;
    if (enabled) {
        memcpy(saved.image, image, 32);
        saved.magic = 0;
        saved.armed = PANIC_MAGIC;
    }
}
void __real_esp_panic_handler(panic_info_t *info);
static uint32_t IRAM_ATTR codeAddress(uintptr_t pc) {
    return ((pc >= SOC_IROM_LOW && pc < SOC_IROM_HIGH) ||
            (pc >= SOC_IRAM_LOW && pc < SOC_IRAM_HIGH)) ? pc : 0;
}
void IRAM_ATTR __wrap_esp_panic_handler(panic_info_t *info) {
    if (saved.armed == PANIC_MAGIC && info) {
        saved.armed = 0;
        uintptr_t pc = (uintptr_t)info->addr;
        saved.pc = codeAddress(pc);
        saved.core = info->core;
        saved.exception = info->exception;
        for (unsigned i = 0; i < 8; i++) saved.callers[i] = 0;
        // The SDK panic printer uses this same validated Xtensa unwind path.
        // Retain only eight executable PCs, never stack pointers or contents.
        if (info->frame) {
            const XtExcFrame *xt = info->frame;
            esp_backtrace_frame_t frame = {.pc = xt->pc, .sp = xt->a1, .next_pc = xt->a0, .exc_frame = xt};
            if (saved.pc && esp_stack_ptr_is_sane(frame.sp)) {
                for (unsigned i = 0; i < 8 && frame.next_pc; i++) {
                    if (!esp_backtrace_get_next_frame(&frame)) break;
                    uint32_t address = codeAddress(esp_cpu_process_stack_pc(frame.pc));
                    if (!address) break;
                    saved.callers[i] = address;
                }
            }
        }
        saved.magic = PANIC_MAGIC;
    }
    __real_esp_panic_handler(info);
}
