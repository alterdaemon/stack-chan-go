#include "../../spi/modSPI.c"
#include <unistd.h>
#include <setjmp.h>
struct Events { pthread_mutex_t lock; pthread_cond_t changed; unsigned bits; };
static atomic_uint entered, completed;
static bool completeBeforeWait;
void xSemaphoreTake(SemaphoreHandle_t m, unsigned timeout) { assert(!pthread_mutex_lock(m)); }
void xSemaphoreGive(SemaphoreHandle_t m) { assert(!pthread_mutex_unlock(m)); }
unsigned xEventGroupClearBits(EventGroupHandle_t e, unsigned bits) { pthread_mutex_lock(&e->lock); e->bits &= ~bits; pthread_mutex_unlock(&e->lock); return e->bits; }
unsigned xEventGroupSetBits(EventGroupHandle_t e, unsigned bits) { pthread_mutex_lock(&e->lock); e->bits |= bits; pthread_cond_broadcast(&e->changed); pthread_mutex_unlock(&e->lock); return bits; }
static void progress(unsigned pending, int data) {
    xSemaphoreTake(gSPIMutex, 0); gTransactionsPending = pending; gSPIDataCount = data;
    updateSPIProgress(); xSemaphoreGive(gSPIMutex);
}
unsigned xEventGroupWaitBits(EventGroupHandle_t e, unsigned bits, int clear, int all, unsigned wait) {
    assert(!clear && all && wait == portMAX_DELAY);
    if (completeBeforeWait) { completeBeforeWait = false; progress(0, -1); }
    pthread_mutex_lock(&e->lock);
    atomic_fetch_add(&entered, 1);
    while ((e->bits & bits) != bits) pthread_cond_wait(&e->changed, &e->lock);
    pthread_mutex_unlock(&e->lock);
    return bits;
}
static jmp_buf service;
static bool serviceOnce;
static unsigned completions, wireBytes;
static uint8_t wire[8192];
void xTaskNotify(TaskHandle_t task, uintptr_t value, unsigned mode) {}
void xTaskNotifyWait(unsigned a, unsigned b, uint32_t *state, unsigned wait) {
    if (!serviceOnce) longjmp(service, 1);
    serviceOnce = false;
    *state = 0;
}
int spi_device_get_trans_result(spi_device_handle_t device, spi_transaction_t **t, unsigned wait) {
    if (!completions) return 1;
    completions--; *t = NULL; return ESP_OK;
}
int spi_device_queue_trans(spi_device_handle_t device, spi_transaction_t *t, unsigned wait) {
    assert(wireBytes + t->length / 8 <= sizeof(wire));
    memcpy(wire + wireBytes, t->tx_buffer, t->length / 8);
    wireBytes += t->length / 8;
    return 0;
}
static void serviceSPI(unsigned completed) {
    completions = completed; serviceOnce = true;
    if (!setjmp(service)) spiLoop(NULL);
}
void *heap_caps_malloc(size_t bytes, unsigned caps) { return malloc(bytes); }
void modLog(const char *s) { assert(false); }
int spi_device_transmit(spi_device_handle_t d, spi_transaction_t *t) { return 0; }
static void *flush(void *unused) { modSPIFlush(); atomic_fetch_add(&completed, 1); return NULL; }
static uint8_t nextData[8];
static void *writeAfterCapacity(void *config) {
    modSPITxCommon(config, nextData, sizeof(nextData), modSpiLoadBufferAsIs);
    atomic_fetch_add(&completed, 1);
    return NULL;
}
static void awaitEntry(unsigned expected) { while (atomic_load(&entered) < expected) sched_yield(); }
int main(void) {
    pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
    struct Events events = {.lock = PTHREAD_MUTEX_INITIALIZER, .changed = PTHREAD_COND_INITIALIZER};
    gSPIMutex = &mutex; gSPIProgress = &events;
    // Already completed; no blocking call. Completion before registration persists.
    progress(0, -1); modSPIFlush(); assert(!atomic_load(&entered));
    progress(1, -1); completeBeforeWait = true; modSPIFlush(); assert(atomic_load(&entered) == 1);
    // Two waiters retain progress while the SPI dependency is deliberately held.
    for (unsigned run = 0; run < 50; run++) {
        unsigned before = atomic_load(&entered), done = atomic_load(&completed);
        progress(3, 1024);
        pthread_t a, b; assert(!pthread_create(&a, NULL, flush, NULL)); assert(!pthread_create(&b, NULL, flush, NULL));
        awaitEntry(before + 2);
        assert(atomic_load(&completed) == done);
        progress(2, 0); // capacity is available, but flush must still wait
        assert(atomic_load(&completed) == done);
        progress(0, -1);
        assert(!pthread_join(a, NULL)); assert(!pthread_join(b, NULL));
        assert(atomic_load(&completed) == done + 2);
        // Capacity admits a following async write before every DMA slot drains.
        struct modSPIConfigurationRecord config = {0}; uint8_t data[8] = {0};
        gConfig = &config; progress(2, -1);
        modSPITxCommon(&config, data, sizeof(data), modSpiLoadBufferAsIs);
        assert(gSPIData == data && gSPIDataCount == sizeof(data));
        assert(!(events.bits & (SPI_CAPACITY | SPI_IDLE)));
        progress(0, -1);
    }
    // Capacity wait must stay blocked until both a slot and the preceding
    // source buffer are available; a flush waiter needs the stronger predicate.
    struct modSPIConfigurationRecord nextConfig = {0};
    gConfig = &nextConfig;
    unsigned enteredBefore = atomic_load(&entered), completedBefore = atomic_load(&completed);
    progress(kTransactions, -1);
    pthread_t writer;
    assert(!pthread_create(&writer, NULL, writeAfterCapacity, &nextConfig));
    awaitEntry(enteredBefore + 1);
    assert(atomic_load(&completed) == completedBefore);
    progress(kTransactions - 1, 128);
    assert(atomic_load(&completed) == completedBefore);
    progress(kTransactions - 1, -1);
    assert(!pthread_join(writer, NULL));
    assert(atomic_load(&completed) == completedBefore + 1);
    assert(gSPIData == nextData && gSPIDataCount == sizeof(nextData));
    // Run the actual SPI producer/drainer with deliberately delayed DMA.
    uint8_t payload[4096];
    for (unsigned i = 0; i < sizeof(payload); i++) payload[i] = (i * 37u) ^ (i >> 5);
    struct modSPIConfigurationRecord config = {0};
    gConfig = &config; progress(0, -1);
    for (unsigned i = 0; i < kTransactions; i++) gSPITransactionBuffer[i] = malloc(SPI_BUFFER_SIZE);
    modSPITx(&config, payload, sizeof(payload));
    serviceSPI(0);
    assert(gTransactionsPending == kTransactions && gSPIDataCount > 0);
    assert(wireBytes == kTransactions * SPI_BUFFER_SIZE);
    serviceSPI(1);
    assert(gTransactionsPending == kTransactions && gSPIDataCount == -1);
    assert(!(events.bits & SPI_CAPACITY));
    serviceSPI(kTransactions);
    assert((events.bits & (SPI_CAPACITY | SPI_IDLE)) == (SPI_CAPACITY | SPI_IDLE));
    modSPIFlush();
    assert(wireBytes == sizeof(payload) && !memcmp(wire, payload, sizeof(payload)));
    for (unsigned i = 0; i < kTransactions; i++) free(gSPITransactionBuffer[i]);
    return 0;
}
