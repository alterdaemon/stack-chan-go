#include <assert.h>
#include "../../panic/panic.c"
static unsigned forwarded;
void __real_esp_panic_handler(panic_info_t *info) { forwarded++; }
int main(void) {
    uint8_t image[32] = {1}, other[32] = {2};
    uint32_t out[3];
    panic_info_t info = {.addr = (void *)0x42012345, .core = 1, .exception = 4};
    __wrap_esp_panic_handler(&info);
    assert(forwarded == 1 && saved.magic == 0);
    stackchanDebugPanicArm(true, image);
    __wrap_esp_panic_handler(&info);
    assert(forwarded == 2 && saved.pc == 0x42012345 && saved.armed == 0);
    testReset = ESP_RST_PANIC; initialized = false;
    stackchanDebugPanicInfo(image, out);
    assert(out[0] == 0x42012345 && out[1] == 1 && out[2] == 4);
    assert(saved.armed == 0 && saved.magic == 0);
    stackchanDebugPanicArm(true, image);
    stackchanDebugPanicArm(false, image);
    __wrap_esp_panic_handler(&info);
    assert(forwarded == 3 && saved.magic == 0);
    stackchanDebugPanicArm(true, image);
    info.addr = (void *)0x3c012345; // PSRAM data is never exported.
    __wrap_esp_panic_handler(&info);
    assert(forwarded == 4 && saved.pc == 0);
    info.addr = (void *)0x42012345;
    stackchanDebugPanicArm(true, image);
    __wrap_esp_panic_handler(&info);
    initialized = false; memset(previous, 0, sizeof(previous));
    stackchanDebugPanicInfo(other, out);
    assert(out[0] == 0); // Cannot symbolize another image's stale address.
    return 0;
}
