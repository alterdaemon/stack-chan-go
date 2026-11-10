// CoreS3 runtime controls. Measurement hooks are no-ops in normal builds.
#include "xsHost.h"
#include "mc.defines.h"
#include "xsmc.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "io-performance.h"
#include "esp_timer.h"
#include <stdatomic.h>
#include <stdbool.h>
#include <string.h>

// Only full-duplex LIVE enables these windows. The timer runs outside XS, so
// touch detection can recover and the boost expires even while JS is delayed.
#define UI_PERIOD_US 20000
#define UI_IDLE_US 4000
#define UI_TOUCH_US 8000
// modSPIFlush busy-yields while spiLoop drains the display. Boosting XS above
// that dependency can stop rendering progress. SPI normally waits for DMA.
// XS shares I2S priority, allowing the clock to run on every scheduler tick;
// codecs/RTP get the rest of each window, plus time when XS is blocked.
// No task changes cores. Off restores the original priorities.
#define UI_BOOST_PRIORITY 20
#define UI_SPI_PRIORITY 21
static TaskHandle_t mainTask;
static UBaseType_t mainPriority;
static TaskHandle_t spiTask;
static UBaseType_t spiPriority;
static esp_timer_handle_t uiTimer;
static atomic_bool uiEnabled;
static atomic_uint touchUntil;
static bool uiWindow;
static unsigned uiWindowUs;
#ifdef MODDEF_STACKCHAN_LIVE_PROBE
static atomic_uint probeBoost = UI_BOOST_PRIORITY, probeSPI = UI_SPI_PRIORITY;
static atomic_uint probeIdle = UI_IDLE_US, probeTouch = UI_TOUCH_US;
void stackchanProbeUIBudget(unsigned boost, unsigned spi, unsigned idle, unsigned touch) {
  atomic_store(&probeBoost, boost); atomic_store(&probeSPI, spi);
  atomic_store(&probeIdle, idle); atomic_store(&probeTouch, touch);
  if (spiTask && atomic_load(&uiEnabled)) vTaskPrioritySet(spiTask, spi);
}
#define LIVE_UI_BOOST atomic_load(&probeBoost)
#define LIVE_UI_SPI atomic_load(&probeSPI)
#define LIVE_UI_IDLE atomic_load(&probeIdle)
#define LIVE_UI_TOUCH atomic_load(&probeTouch)
#else
#define LIVE_UI_BOOST UI_BOOST_PRIORITY
#define LIVE_UI_SPI UI_SPI_PRIORITY
#define LIVE_UI_IDLE UI_IDLE_US
#define LIVE_UI_TOUCH UI_TOUCH_US
#endif
__attribute__((weak)) void stackchanUIProgress(void *task) {}

static void restoreUIPriorities(void) {
  vTaskPrioritySet(mainTask, mainPriority);
  if (spiTask) vTaskPrioritySet(spiTask, spiPriority);
}

static void uiTick(void *unused) {
  if (!atomic_load(&uiEnabled)) {
    restoreUIPriorities();
    return;
  }
  stackchanUIProgress(mainTask);
  uiWindow = !uiWindow;
  if (uiWindow) {
    unsigned now = esp_timer_get_time() / 1000;
    unsigned deadline = atomic_load(&touchUntil);
    uiWindowUs = deadline && (int32_t)(deadline - now) > 0 ? LIVE_UI_TOUCH : LIVE_UI_IDLE;
  }
  vTaskPrioritySet(mainTask, uiWindow ? LIVE_UI_BOOST : mainPriority);
  if (atomic_load(&uiEnabled)) {
    if (esp_timer_start_once(uiTimer, uiWindow ? uiWindowUs : UI_PERIOD_US - uiWindowUs) == ESP_OK) {
      if (atomic_load(&uiEnabled)) return;
      // Shutdown may have disarmed the timer while this callback was rearming.
      // stop_blocking waits for this callback, so finish without another alarm.
      esp_timer_stop(uiTimer);
    }
    atomic_store(&uiEnabled, false);
  }
  restoreUIPriorities();
}

void xs_io_live_ui(xsMachine *the) {
  bool enabled = xsmcToBoolean(xsArg(0));
  if (enabled == atomic_load(&uiEnabled) && (enabled || !uiTimer)) return;
  if (enabled && !mainTask) xsUnknownError("main thread not initialized");
  atomic_store(&uiEnabled, false);
  if (uiTimer) {
    // No callback may still access the timer when its storage is deleted.
    if (esp_timer_stop_blocking(uiTimer, pdMS_TO_TICKS(20)) != ESP_OK) {
      restoreUIPriorities();
      xsUnknownError("UI timer stop failed");
    }
    esp_timer_delete(uiTimer);
    uiTimer = NULL;
  }
  atomic_store(&touchUntil, 0);
  restoreUIPriorities();
  if (enabled) {
    spiTask = xTaskGetHandle("spiLoop");
    if (!spiTask) return; // No display dependency means no UI policy to install.
    spiPriority = uxTaskPriorityGet(spiTask);
    const esp_timer_create_args_t args = {.callback = uiTick, .name = "live_ui"};
    if (esp_timer_create(&args, &uiTimer) != ESP_OK) xsUnknownError("UI timer allocation failed");
    uiWindow = false;
    vTaskPrioritySet(spiTask, LIVE_UI_SPI);
    atomic_store(&uiEnabled, true);
    if (esp_timer_start_once(uiTimer, 1000) != ESP_OK) {
      atomic_store(&uiEnabled, false);
      restoreUIPriorities();
      esp_timer_delete(uiTimer);
      uiTimer = NULL;
      xsUnknownError("UI timer start failed");
    }
  }
}

void xs_io_touch(xsMachine *the) {
  if (!atomic_load(&uiEnabled)) return;
  // A missed release cannot leave the longer interaction window latched.
  atomic_store(&touchUntil, xsmcToBoolean(xsArg(0)) ? (unsigned)(esp_timer_get_time() / 1000) + 250 : 0);
}

void xs_io_main_priority(xsMachine *the) {
  int priority = xsmcToInteger(xsArg(0));
  if (priority != 4 && priority != 6) xsRangeError("supported main priorities: 4, 6");
  if (strcmp(pcTaskGetName(NULL), "main")) xsUnknownError("main thread required");
  mainTask = xTaskGetCurrentTaskHandle();
  mainPriority = priority;
  vTaskPrioritySet(NULL, priority);
}
// Existing MODs can call these hooks without requiring a measurement build.
__attribute__((weak)) void xs_io_reset(xsMachine *the) {}
__attribute__((weak)) void xs_io_mark(xsMachine *the) {}
__attribute__((weak)) void xs_io_stats(xsMachine *the) {}
__attribute__((weak)) void stackchanAudioReset(void) {}
__attribute__((weak)) void stackchanAudioProgress(unsigned direction, int64_t now) {}
