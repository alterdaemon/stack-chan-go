#include "../io-performance.c"
#include <assert.h>

static int argument;
static unsigned priority, allocations, schedules;
static int64_t now;
static struct Timer { esp_timer_create_args_t args; unsigned delay; bool armed; } timer;
static int mainHandle;
static int spiHandle;
static unsigned spiTaskPriority = 10;
static bool disableOnRearm;
int testArgument(void) { return argument; }
TaskHandle_t xTaskGetCurrentTaskHandle(void) { return &mainHandle; }
TaskHandle_t xTaskGetHandle(const char *name) { assert(!strcmp(name, "spiLoop")); return &spiHandle; }
UBaseType_t uxTaskPriorityGet(TaskHandle_t task) { assert(task == &spiHandle); return spiTaskPriority; }
const char *pcTaskGetName(TaskHandle_t task) { return "main"; }
void vTaskPrioritySet(TaskHandle_t task, UBaseType_t value) {
  if (task == &spiHandle) spiTaskPriority = value;
  else { assert(!task || task == &mainHandle); priority = value; }
}
int64_t esp_timer_get_time(void) { return now; }
int esp_timer_create(const esp_timer_create_args_t *args, esp_timer_handle_t *out) {
  assert(!allocations++); timer.args = *args; *out = &timer; return ESP_OK;
}
int esp_timer_start_once(esp_timer_handle_t handle, uint64_t delay) {
  assert(handle == &timer && !timer.armed && delay);
  timer.armed = true; timer.delay = delay; schedules++;
  if (disableOnRearm) atomic_store(&uiEnabled, false);
  return ESP_OK;
}
int esp_timer_stop(esp_timer_handle_t handle) { assert(handle == &timer); timer.armed = false; return ESP_OK; }
int esp_timer_stop_blocking(esp_timer_handle_t handle, unsigned timeout) {
  assert(handle == &timer && timeout); timer.armed = false; return ESP_OK;
}
int esp_timer_delete(esp_timer_handle_t handle) {
  assert(handle == &timer && !timer.armed && allocations == 1); allocations--; return ESP_OK;
}
static void fire(void) {
  assert(timer.armed); now += timer.delay; timer.armed = false; timer.args.callback(NULL);
}
static void enable(bool value) { argument = value; xs_io_live_ui(NULL); }
static void touch(bool value) { argument = value; xs_io_touch(NULL); }
int main(void) {
  argument = 6; xs_io_main_priority(NULL);
  touch(true); enable(false);
  assert(priority == 6 && !allocations && !schedules);
  enable(true); assert(allocations == 1 && spiTaskPriority > priority);
  // Existing decoder priority is 15; I2S is 20. UI can preempt rendering's
  // competitors while I2S remains eligible, and its SPI dependency can run.
  fire(); assert(priority > 15 && priority <= 20 && priority < spiTaskPriority);
  unsigned idle = timer.delay;
  fire(); assert(priority == 6);
  unsigned period = idle + timer.delay;
  touch(true); fire(); assert(priority > 6 && timer.delay > idle);
  unsigned active = timer.delay;
  assert(active < period);
  fire(); assert(priority == 6 && timer.delay + active == period);
  // No JS release callback: the native deadline still ends the longer window.
  now += 1000000;
  unsigned before = schedules;
  fire(); assert(priority > 6 && timer.delay == idle && schedules == before + 1);
  enable(false); assert(priority == 6 && spiTaskPriority == 10 && !allocations && !timer.armed);
  for (unsigned i = 0; i < 20; i++) {
    enable(true); fire(); touch(true); enable(false);
    assert(priority == 6 && spiTaskPriority == 10 && !allocations && !timer.armed);
  }
  // The touch deadline works across the millisecond counter wrap.
  enable(true); now = ((int64_t)UINT32_MAX - 100) * 1000;
  touch(true); fire(); assert(timer.delay == active);
  fire(); touch(false); fire(); assert(timer.delay == idle);
  enable(false);
  // Shutdown races a callback between its enabled check and timer rearm.
  enable(true); disableOnRearm = true; fire();
  assert(priority == 6 && !timer.armed);
  disableOnRearm = false; enable(false); assert(!allocations);
  argument = 4; xs_io_main_priority(NULL); touch(true); enable(false);
  assert(priority == 4 && !allocations && !timer.armed);
}
