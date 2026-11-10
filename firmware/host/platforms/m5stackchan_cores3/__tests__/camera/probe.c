#include "xsHost.h"
#include "xsmc.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static unsigned blockedWrites;

void xs_r14_block_preference(xsMachine *the)
{
	++blockedWrites;
	xsUnknownError("diagnostic_preference_write_blocked");
}

void xs_r14_blocked_preferences(xsMachine *the)
{
	xsmcSetInteger(xsResult, blockedWrites);
}

void xs_camera_probe_sample(xsMachine *the)
{
	xsmcVars(1);
	xsmcSetNewObject(xsResult);
#define SET(name, value) xsmcSetNumber(xsVar(0), (double)(value)); xsmcSet(xsResult, xsID(name), xsVar(0))
	SET("atUs", esp_timer_get_time());
	SET("internalFree", heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
	SET("internalLargest", heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
	SET("psramFree", heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
	TaskHandle_t worker = xTaskGetHandle("camera");
	TaskHandle_t hal = xTaskGetHandle("cam_task");
	SET("worker", worker != NULL);
	SET("hal", hal != NULL);
	TaskStatus_t stats;
	if (worker) {
		vTaskGetInfo(worker, &stats, pdFALSE, eInvalid);
		SET("workerUs", stats.ulRunTimeCounter);
	}
	if (hal) {
		vTaskGetInfo(hal, &stats, pdFALSE, eInvalid);
		SET("halUs", stats.ulRunTimeCounter);
	}
#undef SET
}
