#include "../../debug-log.c"
#include <assert.h>

static void *produce(void *arg) {
    for (unsigned i = 0; i < 10000; i++) stackchanDebugNative(DEBUG_INTERRUPT, i, 0, 0);
    return NULL;
}
int main(void) {
    stackchanDebugNative(DEBUG_INTERRUPT, 1, 0, 0);
    assert(count == 0 && sequence == 0);
    testEnable = true;
    xs_device_debug_enable(NULL);
    pthread_t threads[4];
    for (unsigned i = 0; i < 4; i++) assert(pthread_create(&threads[i], NULL, produce, NULL) == 0);
    for (unsigned i = 0; i < 4; i++) assert(pthread_join(threads[i], NULL) == 0);
    assert(count == DEBUG_NATIVE_COUNT);
    assert(sequence == 40000 && dropped == 40000 - DEBUG_NATIVE_COUNT);
    for (unsigned i = 1; i < count; i++) {
        assert(records[i].seq > records[i-1].seq);
        assert(records[i].ms >= records[i-1].ms);
    }
    testEnable = false;
    xs_device_debug_enable(NULL);
    assert(count == 0 && dropped == 0);
    stackchanDebugNative(DEBUG_INTERRUPT, 1, 0, 0);
    assert(count == 0 && sequence == 40000);
    return 0;
}
