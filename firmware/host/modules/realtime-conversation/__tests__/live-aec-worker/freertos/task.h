#include <stddef.h>
int xTaskCreatePinnedToCore(void (*body)(void *), const char *name, unsigned stack,
                          void *context, unsigned priority, void *handle, int core);
void vTaskDelay(unsigned ticks);
void vTaskDelete(void *task);
