#include <assert.h>
#include "../../panic/panic.c"
static unsigned forwarded;
void __real_esp_panic_handler(panic_info_t *info) { forwarded++; }
int main(void) {
    uint8_t image[32] = {1}, other[32] = {2};
    uint32_t out[11];
    XtExcFrame frame = {.pc = 0x42012345, .a1 = 16, .a0 = 0x42054321};
    panic_info_t info = {.addr = (void *)0x42012345, .core = 1, .exception = 4, .frame = &frame};
    __wrap_esp_panic_handler(&info);
    assert(forwarded == 1 && saved.magic == 0);
    stackchanDebugPanicArm(true, image);
    __wrap_esp_panic_handler(&info);
    assert(forwarded == 2 && saved.pc == 0x42012345 && saved.armed == 0);
    testReset = ESP_RST_PANIC; initialized = false;
    stackchanDebugPanicInfo(image, out);
    assert(out[0] == 0x42012345 && out[1] == 1 && out[2] == 4);
    assert(out[3] == 0x42054321 && out[4] == 0);
    assert(saved.armed == 0 && saved.magic == 0);
    stackchanDebugPanicArm(true, image);
    stackchanDebugPanicArm(false, image);
    __wrap_esp_panic_handler(&info);
    assert(forwarded == 3 && saved.magic == 0);
    stackchanDebugPanicArm(true, image);
    info.addr = (void *)0x3c012345; // PSRAM data is never exported.
    __wrap_esp_panic_handler(&info);
    assert(forwarded == 4 && saved.pc == 0);
    assert(saved.callers[0] == 0);
    info.addr = (void *)0x42012345;
    frame.a0 = 0x3c012345; // Even a plausible frame cannot export a data address.
    stackchanDebugPanicArm(true, image);
    __wrap_esp_panic_handler(&info);
    assert(saved.callers[0] == 0);
    frame.a0 = 0x42054321; frame.a1 = 0;
    stackchanDebugPanicArm(true, image);
    __wrap_esp_panic_handler(&info);
    assert(saved.callers[0] == 0); // Do not unwind an invalid stack pointer.
    info.addr = (void *)0x42012345;
    stackchanDebugPanicArm(true, image);
    __wrap_esp_panic_handler(&info);
    initialized = false; memset(previous, 0, sizeof(previous));
    stackchanDebugPanicInfo(other, out);
    assert(out[0] == 0); // Cannot symbolize another image's stale address.
    return 0;
}
