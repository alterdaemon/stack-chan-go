/*
 * Copyright (c) 2024-2025  Moddable Tech, Inc.
 *
 *   This file is part of the Moddable SDK Runtime.
 *
 *   The Moddable SDK Runtime is free software: you can redistribute it and/or modify
 *   it under the terms of the GNU Lesser General Public License as published by
 *   the Free Software Foundation, either version 3 of the License, or
 *   (at your option) any later version.
 *
 *   The Moddable SDK Runtime is distributed in the hope that it will be useful,
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *   GNU Lesser General Public License for more details.
 *
 *   You should have received a copy of the GNU Lesser General Public License
 *   along with the Moddable SDK Runtime.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

#include "xsmc.h"
#include "mc.xs.h"
#include "mc.defines.h"
#include "xsHost.h"
#include "modTimer.h"
#include <stdatomic.h>

#include "builtinCommon.h"
#include "_i2c.h"

#include "esp_camera.h"
#include "sensor.h"

#include "commodettoBitmapFormat.h"
#include "commodettoPocoBlit.h"

#ifndef MODDEF_CAMERA_POWERDOWN
	#define MODDEF_CAMERA_POWERDOWN -1
#endif
#ifndef MODDEF_CAMERA_RESET
	#define MODDEF_CAMERA_RESET -1
#endif
#ifndef MODDEF_CAMERA_I2C_PORT
	#if CONFIG_SCCB_HARDWARE_I2C_PORT1
		#define MODDEF_CAMERA_I2C_PORT	1
	#else
		#define MODDEF_CAMERA_I2C_PORT	0
	#endif
#endif
#ifndef MODDEF_CAMERA_XCLK_FREQ_HZ
	#define MODDEF_CAMERA_XCLK_FREQ_HZ (24000000)
#endif
#ifndef MODDEF_CAMERA_JPEG_QUALITY
	#define MODDEF_CAMERA_JPEG_QUALITY (12)
#endif

static void xs_camera_mark(xsMachine *the, void *it, xsMarkRoot markRoot);
void xs_camera_destructor(void *data);

static const xsHostHooks ICACHE_RODATA_ATTR xsCameraHooks = {
	xs_camera_destructor,
	xs_camera_mark,
	NULL
};

enum CameraFrameState {
	kCameraStateFree = 0,
	kCameraStatePreparing,
	kCameraStateReady,
	kCameraStateClient,
};
typedef enum CameraFrameState CameraFrameState;

struct CameraFrameRecord {
	void					*data;
	uint32_t				dataLength;
	xsSlot					*hostBuffer;
	camera_fb_t				*fb;
	uint32_t				id;
	CameraFrameState		state;
};
typedef struct CameraFrameRecord CameraFrameRecord;
typedef struct CameraFrameRecord *CameraFrame;

#define kCameraFrameCount (3)

struct CameraRecord {
	xsMachine	*the;
	xsSlot		object;
	xsSlot		*onReadable;

	uint32_t	width;
	uint32_t	height;

	SemaphoreHandle_t mutex;
	SemaphoreHandle_t acknowledged;
	TaskHandle_t task;
	modTimer readableTimer;
	bool running;
	uint32_t notifiedFrameID;

	uint8_t		swap16;
	uint8_t		format;
	uint8_t		isJPEG;
	int			imageType;

	xsSlot		*hostBufferPrototype;

	uint32_t	frameID;
	CameraFrameRecord	frames[kCameraFrameCount];

	uint8_t				sensorInitialized;
	camera_status_t		sensorHas;		// 0 if not supported; 1 otherwise
};
typedef struct CameraRecord CameraRecord;
typedef struct CameraRecord *Camera;

struct FramesizeRecord {
	uint8_t		id;
	uint16_t	width;
	uint16_t	height;
};
typedef struct FramesizeRecord FramesizeRecord;
typedef struct FramesizeRecord *Framesize;

// ordered by width, then by height
static FramesizeRecord FrameSizes[] = {
    FRAMESIZE_96X96,   96, 96,
    FRAMESIZE_128X128, 128, 128,
    FRAMESIZE_QQVGA,   160, 120,
    FRAMESIZE_QCIF,    176, 144,
    FRAMESIZE_HQVGA,   240, 176,
    FRAMESIZE_240X240, 240, 240,
    FRAMESIZE_QVGA,    320, 240,
    FRAMESIZE_320X320, 320, 320,
    FRAMESIZE_CIF,     400, 296,
    FRAMESIZE_HVGA,    480, 320,
    FRAMESIZE_VGA,     640, 480,
    FRAMESIZE_P_HD,    720, 1280,
    FRAMESIZE_SVGA,    800, 600,
    FRAMESIZE_P_3MP,   864, 1536,
    FRAMESIZE_XGA,     1024, 768,
    FRAMESIZE_P_FHD,   1080, 1920,
    FRAMESIZE_HD,      1280, 720,
    FRAMESIZE_SXGA,    1280, 1024,
    FRAMESIZE_UXGA,    1600, 1200,
    FRAMESIZE_FHD,     1920, 1080,
    FRAMESIZE_QXGA,    2048, 1536,
    FRAMESIZE_QHD,     2560, 1440,
    FRAMESIZE_WQXGA,   2560, 1600,
    FRAMESIZE_QSXGA,   2560, 1920,
    FRAMESIZE_INVALID, 0, 0
};

static const camera_config_t cameraDefaults = {
	.pin_pwdn = MODDEF_CAMERA_POWERDOWN,
	.pin_reset = MODDEF_CAMERA_RESET,
	.pin_xclk = MODDEF_CAMERA_XCLK,
	.pin_sccb_sda = MODDEF_CAMERA_SDA,
	.pin_sccb_scl = MODDEF_CAMERA_SCL,

	.pin_d0 = MODDEF_CAMERA_D0,
	.pin_d1 = MODDEF_CAMERA_D1,
	.pin_d2 = MODDEF_CAMERA_D2,
	.pin_d3 = MODDEF_CAMERA_D3,
	.pin_d4 = MODDEF_CAMERA_D4,
	.pin_d5 = MODDEF_CAMERA_D5,
	.pin_d6 = MODDEF_CAMERA_D6,
	.pin_d7 = MODDEF_CAMERA_D7,
	.pin_vsync = MODDEF_CAMERA_VSYNC,
	.pin_href = MODDEF_CAMERA_HREF,
	.pin_pclk = MODDEF_CAMERA_PCLK,

	.xclk_freq_hz = MODDEF_CAMERA_XCLK_FREQ_HZ,
	.ledc_timer = LEDC_TIMER_0,
	.ledc_channel = LEDC_CHANNEL_0,

	.pixel_format = PIXFORMAT_RGB565,
	.frame_size = FRAMESIZE_VGA,

	.jpeg_quality = MODDEF_CAMERA_JPEG_QUALITY,
	.fb_count = 3,
	.fb_location = CAMERA_FB_IN_PSRAM,
	.grab_mode = CAMERA_GRAB_LATEST,		// vs. CAMERA_GRAB_WHEN_EMPTY
	.sccb_i2c_port = MODDEF_CAMERA_I2C_PORT
};

enum {
	kCaptureStart = 1,
	kCaptureStop = 2,
	kCaptureClose = 4,
	kCaptureBufferReturned = 8
};

static atomic_bool cameraInUse;

static CameraFrame oldestReadyFrame(Camera camera)
{
	CameraFrame frame = NULL;
	for (int i = 0; i < kCameraFrameCount; i++) {
		CameraFrame candidate = &camera->frames[i];
		if ((kCameraStateReady == candidate->state) && (!frame || (frame->id > candidate->id)))
			frame = candidate;
	}
	return frame;
}

// The timer belongs to XS. The worker never waits for space in its message queue.
static void notifyReadable(modTimer timer, void *refcon, int refconSize)
{
	Camera camera = *(Camera *)refcon;
	xSemaphoreTake(camera->mutex, portMAX_DELAY);
	CameraFrame frame = oldestReadyFrame(camera);
	uint32_t length = 0;
	if (frame && (camera->notifiedFrameID != camera->frameID)) {
		camera->notifiedFrameID = camera->frameID;
		length = frame->dataLength;
	}
	xSemaphoreGive(camera->mutex);
	if (length) {
		xsMachine *the = camera->the;
		xsBeginHost(the);
		xsCallFunction1(xsReference(camera->onReadable), camera->object, xsInteger(length));
		xsEndHost(the);
	}
}

static void cameraLoop(void *pvParameter)
{
	Camera camera = pvParameter;
	bool running = false;
	TickType_t wait = portMAX_DELAY;

	for (;;) {
		uint32_t commands = 0;
		if (xTaskNotifyWait(0, UINT32_MAX, &commands, wait)) {
			if (commands & kCaptureClose)
				break;
			if (commands & kCaptureStop) {
				running = false;
				xSemaphoreGive(camera->acknowledged);
			}
			else if (commands & kCaptureStart)
				running = true;
		}

		wait = portMAX_DELAY;
		if (!running)
			continue;

		CameraFrame frame = NULL;
		xSemaphoreTake(camera->mutex, portMAX_DELAY);
		for (int i = 0; i < kCameraFrameCount; i++) {
			if (kCameraStateFree == camera->frames[i].state) {
				frame = &camera->frames[i];
				frame->state = kCameraStatePreparing;
				break;
			}
		}
		xSemaphoreGive(camera->mutex);
		// Returning a client buffer or a lifecycle command wakes this task.
		if (!frame)
			continue;

		camera_fb_t *fb = esp_camera_fb_get();
		wait = 0;
		if (!fb) {
			xSemaphoreTake(camera->mutex, portMAX_DELAY);
			frame->state = kCameraStateFree;
			xSemaphoreGive(camera->mutex);
			continue;
		}

		if (camera->swap16) {
			uint32_t *pixels = (uint32_t*)fb->buf;
			const uint32_t mask = 0x00ff00ff;
			uint32_t i, count = fb->len >> 2;
			for (i = 0; i < count; i++) {
				uint32_t t = pixels[i];
				pixels[i] = ((t & mask) << 8) | ((t >> 8) & mask);
			}
		}
		else if (kCommodettoBitmapGray16 == camera->imageType) {	// convert RGB565BE to Gray16
			uint32_t *src = (uint32_t*)fb->buf;
			uint8_t *dst = (uint8_t*)fb->buf;
			uint32_t i, count = fb->len >> 2;
			const uint32_t mask = 0x00ff00ff;
			for (i = 0; i < count; i++) {
				uint32_t t = *src++;
				t = ((t & mask) << 8) | ((t >> 8) & mask);
				uint8_t a = PocoMakePixelGray16((((t >> 27) & 0x1f) << 3), (((t >> 21) & 0x3f) << 2), (((t >> 16) & 0x1f) >> 3));
				uint8_t b = PocoMakePixelGray16((((t >> 11) & 0x1f) << 3), (((t >> 5) & 0x3f) << 2), (((t >> 0) & 0x1f) >> 3));
				*dst++ = (b << 4) | a;
			}
		}

		xSemaphoreTake(camera->mutex, portMAX_DELAY);
		frame->id = ++camera->frameID;
		frame->fb = fb;
		frame->data = fb->buf;
		frame->dataLength = fb->len;
		frame->state = kCameraStateReady;
		xSemaphoreGive(camera->mutex);
	}

	// The owner can deinitialize the peripheral after this acknowledgement.
	xSemaphoreGive(camera->acknowledged);
	vTaskDelete(NULL);
}

static int formatToCamFormat(int commodettoFormat)
{
	switch (commodettoFormat) {
		case kCommodettoBitmapRGB565BE:
		case kCommodettoBitmapRGB565LE: return PIXFORMAT_RGB565; 		// 2BPP/RGB565
		case kCommodettoBitmapMonochrome: return PIXFORMAT_GRAYSCALE;	// 1BPP/GRAYSCALE
		case kCommodettoBitmapJPEG: return PIXFORMAT_JPEG;				// JPEG/COMPRESSED
		case kCommodettoBitmap24RGB: return PIXFORMAT_RGB888;			// 3BPP/RGB888
		case kCommodettoBitmapRGB444: return PIXFORMAT_RGB444;			// 3BP2P/RGB444
		case kCommodettoBitmapYUV422: return PIXFORMAT_YUV422;			// 2BPP/YUV422
		case kCommodettoBitmapGray16: return PIXFORMAT_RGB565;			// 4BPP/GRAYSCAPE (post process) (in a perfec world, we would select YUV422 when available)
		// PIXFORMAT_YUV420;    // 1.5BPP/YUV420
		// PIXFORMAT_RAW;       // RAW	(?)
		// PIXFORMAT_RGB555;    // 3BP2P/RGB555
	}
	return -1;
}

static int dimensionsToFrameSize(int width, int height)
{
	int i;
	for (i = 0; FRAMESIZE_INVALID != FrameSizes[i].id; i++) {
		if (FrameSizes[i].width < width)
			continue;
		if (FrameSizes[i].height < height) {
			if ((FRAMESIZE_INVALID != FrameSizes[i + 1].id) && (FrameSizes[i+1].width == FrameSizes[i].width))
				return i + 1;
		}
		return i;
	}
	return -1;
}


void xs_camera_constructor(xsMachine *the)
{
	uint32_t width = 240;
	uint32_t height = 176;
	uint8_t format = kIOFormatBuffer;
	Camera camera;
	int imageType = kCommodettoBitmapRGB565LE;
	uint8_t isJPEG = 0;

	xsmcVars(1);

	format = builtinInitializeFormat(the, format);
	if ((kIOFormatBuffer != format) && (kIOFormatBufferDisposable != format))
		xsRangeError("invalid format");

	if (xsmcGet(xsVar(0), xsArg(0), xsID_width))
		width = xsmcToInteger(xsVar(0));
	if (xsmcGet(xsVar(0), xsArg(0), xsID_height))
		height = xsmcToInteger(xsVar(0));
	if (xsmcGet(xsVar(0), xsArg(0), xsID_imageType)) {
		if (xsStringType == xsmcTypeOf(xsVar(0))) {
			if (c_strcmp("jpeg", xsmcToString(xsVar(0))))
				xsRangeError("unknown imageType");
			isJPEG = 1;
			imageType = -1;
		}
		else
			imageType = xsmcToInteger(xsVar(0));
	}

	int frameSizeIndex = dimensionsToFrameSize(width, height);
	if (-1 == frameSizeIndex)
		xsUnknownError("unsupported dimensions");
	int pixelFormat = isJPEG ? PIXFORMAT_JPEG : formatToCamFormat(imageType);
	if (-1 == pixelFormat)
		xsUnknownError("unsupported pixel format");

	xsSlot *onReadable = builtinGetCallback(the, xsID_onReadable);
	builtinInitializeTarget(the);
	xsmcGet(xsVar(0), xsArg(0), xsID_prototype);
	xsSlot *hostBufferPrototype = xsmcToReference(xsVar(0));

	if (atomic_exchange(&cameraInUse, true))
		xsUnknownError("camera already open");
	camera = c_calloc(1, sizeof(CameraRecord));
	if (!camera) {
		atomic_store(&cameraInUse, false);
		xsUnknownError("not enough memory");
	}

	camera->mutex = xSemaphoreCreateMutex();
	camera->acknowledged = xSemaphoreCreateBinary();
	if (!camera->mutex || !camera->acknowledged)
		goto fail;

	camera_config_t config = cameraDefaults;
	config.frame_size = FrameSizes[frameSizeIndex].id;
	config.pixel_format = pixelFormat;
	if (ESP_OK != esp_camera_init(&config))
		goto fail;

	framesize_t frameSize = esp_camera_sensor_get()->status.framesize;
	camera->width = resolution[frameSize].width;
	camera->height = resolution[frameSize].height;
	camera->the = the;
	camera->object = xsThis;
	camera->format = format;
	camera->onReadable = onReadable;
	camera->hostBufferPrototype = hostBufferPrototype;
	camera->imageType = imageType;
	camera->swap16 = (imageType == kCommodettoBitmapRGB565LE);
	camera->isJPEG = isJPEG;

	if (pdPASS != xTaskCreate(cameraLoop, "camera", 8 * 1024 + XT_STACK_EXTRA_CLIB, camera, 10, &camera->task)) {
		esp_camera_deinit();
		goto fail;
	}
	xsmcSetHostData(xsThis, camera);
	xsSetHostHooks(xsThis, (xsHostHooks *)&xsCameraHooks);
	xsRemember(camera->object);
	return;

fail:
	if (camera->acknowledged)
		vSemaphoreDelete(camera->acknowledged);
	if (camera->mutex)
		vSemaphoreDelete(camera->mutex);
	c_free(camera);
	atomic_store(&cameraInUse, false);
	xsUnknownError("camera init failed");
}

static void releaseFrames(xsMachine *the, Camera camera)
{
	// The producer has acknowledged stop or exited before we touch these slots.
	for (int i = 0; i < kCameraFrameCount; i++) {
		CameraFrame frame = &camera->frames[i];
		if (the && frame->hostBuffer) {
			xsSlot buffer = xsReference(frame->hostBuffer);
			xsmcSetHostBuffer(buffer, NULL, 0);
		}
		if (frame->fb)
			esp_camera_fb_return(frame->fb);
		c_memset(frame, 0, sizeof(*frame));
	}
}

static void stopReadable(Camera camera)
{
	if (camera->readableTimer) {
		modTimerRemove(camera->readableTimer);
		camera->readableTimer = NULL;
	}
}

static void waitForCapture(Camera camera, uint32_t command)
{
	xTaskNotify(camera->task, command, eSetBits);
	xSemaphoreTake(camera->acknowledged, portMAX_DELAY);
}

static void closeCamera(xsMachine *the, Camera camera)
{
	stopReadable(camera);
	waitForCapture(camera, kCaptureClose);
	releaseFrames(the, camera);
	esp_camera_deinit();
	vSemaphoreDelete(camera->acknowledged);
	vSemaphoreDelete(camera->mutex);
	c_free(camera);
	atomic_store(&cameraInUse, false);
}

void xs_camera_destructor(void *it)
{
	if (it)
		closeCamera(NULL, it);
}

void xs_camera_close(xsMachine *the)
{
	if (xsmcGetHostData(xsThis)) {
		Camera camera = xsmcGetHostDataValidate(xsThis, (void *)&xsCameraHooks);
		xsmcSetHostData(xsThis, NULL);
		xsmcSetHostDestructor(xsThis, NULL);
		xsForget(camera->object);
		closeCamera(the, camera);
	}
}

void xs_camera_mark(xsMachine *the, void *it, xsMarkRoot markRoot)
{
	Camera camera = it;

	if (camera->onReadable)
		(*markRoot)(the, camera->onReadable);

	if (camera->hostBufferPrototype)
		(*markRoot)(the, camera->hostBufferPrototype);

	int i;
	for (i = 0; i < kCameraFrameCount; i++) {
		if (camera->frames[i].hostBuffer)
			(*markRoot)(the, camera->frames[i].hostBuffer);
	}
}

void xs_camera_read(xsMachine *the)
{
	Camera camera = xsmcGetHostDataValidate(xsThis, (void *)&xsCameraHooks);
	xSemaphoreTake(camera->mutex, portMAX_DELAY);
	CameraFrame frame = oldestReadyFrame(camera);

	if (NULL == frame) {
		xSemaphoreGive(camera->mutex);
		return;
	}

	xsTry {
		if (kIOFormatBufferDisposable == camera->format) {
			xsSlot tmp;

			tmp = xsReference(camera->hostBufferPrototype);
			xsmcSetNewHostInstance(xsResult, tmp);
			xsmcSetHostBuffer(xsResult, frame->data, frame->dataLength);
			xsmcDefine(xsResult, xsID_camera, xsThis, xsDontDelete | xsDontSet);
			xsmcSetInteger(tmp, frame->dataLength);
			xsmcDefine(xsResult, xsID_byteLength, tmp, xsDontDelete | xsDontSet);
			xsmcPetrifyHostBuffer(xsResult);

			frame->hostBuffer = xsmcToReference(xsResult);
			frame->state = kCameraStateClient;
		}
		else {
			if ((xsmcArgc > 0) && (xsReferenceType == xsmcTypeOf(xsArg(0)))) {
				void *dst;
				xsUnsignedValue requested;

				xsmcGetBufferWritable(xsArg(0), &dst, &requested);
				if (requested < frame->dataLength)
					xsRangeError("buffer too small");
				xsmcSetInteger(xsResult, frame->dataLength);

				memcpy(dst, frame->data, frame->dataLength);
			}
			else {
				xsmcSetArrayBuffer(xsResult, frame->data, frame->dataLength);
			}


			esp_camera_fb_return(frame->fb);
			frame->hostBuffer = NULL;
			frame->fb = NULL;
			frame->data = NULL;
			frame->state = kCameraStateFree;
			xTaskNotify(camera->task, kCaptureBufferReturned, eSetBits);
		}

	}
	xsCatch {
		xSemaphoreGive(camera->mutex);
		xsThrow(xsException);
	}

	xSemaphoreGive(camera->mutex);
}

void xs_camera_start(xsMachine *the)
{
	Camera camera = xsmcGetHostDataValidate(xsThis, (void *)&xsCameraHooks);
	if (camera->running)
		return;
	if (camera->onReadable) {
		camera->readableTimer = modTimerAdd(0, 16, notifyReadable, &camera, sizeof(camera));
		if (!camera->readableTimer)
			xsUnknownError("camera callback timer");
	}
	camera->running = true;
	xTaskNotify(camera->task, kCaptureStart, eSetBits);
}

void xs_camera_stop(xsMachine *the)
{
	Camera camera = xsmcGetHostDataValidate(xsThis, (void *)&xsCameraHooks);
	if (!camera->running)
		return;
	stopReadable(camera);
	camera->running = false;
	waitForCapture(camera, kCaptureStop);
	releaseFrames(the, camera);
}

void xs_camera_get_format(xsMachine *the)
{
    Camera camera = xsmcGetHostDataValidate(xsThis, (void *)&xsCameraHooks);
	builtinGetFormat(the, camera->format);
}

void xs_camera_set_format(xsMachine *the)
{
    Camera camera = xsmcGetHostDataValidate(xsThis, (void *)&xsCameraHooks);
	uint8_t format = builtinSetFormat(the);
	if ((kIOFormatBuffer != format) && (kIOFormatBufferDisposable != format))
		xsRangeError("invalid format");
	camera->format = format;
}

void xs_camera_get_imageType(xsMachine *the)
{
    Camera camera = xsmcGetHostDataValidate(xsThis, (void *)&xsCameraHooks);
    if (camera->isJPEG)
		xsmcSetStringX(xsResult, "jpeg");
   else
		xsmcSetInteger(xsResult, camera->imageType);
}

void xs_camera_get_width(xsMachine *the)
{
    Camera camera = xsmcGetHostDataValidate(xsThis, (void *)&xsCameraHooks);
	xsmcSetInteger(xsResult, camera->width);
}

void xs_camera_get_height(xsMachine *the)
{
    Camera camera = xsmcGetHostDataValidate(xsThis, (void *)&xsCameraHooks);
	xsmcSetInteger(xsResult, camera->height);
}

void xs_camera_get_identification(xsMachine *the)
{
    Camera camera = xsmcGetHostDataValidate(xsThis, (void *)&xsCameraHooks);
	camera_sensor_info_t *info = esp_camera_sensor_get_info(&esp_camera_sensor_get()->id);

	xsmcVars(1);
	xsmcSetNewObject(xsResult);
	xsmcSetString(xsVar(0), (char *)info->name);
	xsmcSet(xsResult, xsID_model, xsVar(0));
}

static void ensureSensor(Camera camera)
{
	if (camera->sensorInitialized)
		return;

	sensor_t *sensor = esp_camera_sensor_get();

	camera->sensorHas.brightness = 0 == sensor->set_brightness(sensor, sensor->status.brightness);
	camera->sensorHas.contrast = 0 == sensor->set_contrast(sensor, sensor->status.contrast);
	camera->sensorHas.saturation = 0 == sensor->set_saturation(sensor, sensor->status.saturation);
	camera->sensorHas.sharpness = 0 == sensor->set_sharpness(sensor, sensor->status.sharpness);
	camera->sensorHas.denoise = 0 == sensor->set_denoise(sensor, sensor->status.denoise);
	camera->sensorHas.wb_mode = 0 == sensor->set_whitebal(sensor, sensor->status.wb_mode);

	camera->sensorInitialized = true;
}

void xs_camera_get_configuration(xsMachine *the)
{
    Camera camera = xsmcGetHostDataValidate(xsThis, (void *)&xsCameraHooks);
	ensureSensor(camera);

	sensor_t *sensor = esp_camera_sensor_get();
	xsSlot tmp;

	xsmcSetNewObject(xsResult);
	if (camera->sensorHas.brightness) {
		xsmcSetInteger(tmp, sensor->status.brightness);
		xsmcSet(xsResult, xsID_brightness, tmp);
	}
	if (camera->sensorHas.contrast) {
		xsmcSetInteger(tmp, sensor->status.contrast);
		xsmcSet(xsResult, xsID_contrast, tmp);
	}
	if (camera->sensorHas.saturation) {
		xsmcSetInteger(tmp, sensor->status.saturation);
		xsmcSet(xsResult, xsID_saturation, tmp);
	}
	if (camera->sensorHas.sharpness) {
		xsmcSetInteger(tmp, sensor->status.sharpness);
		xsmcSet(xsResult, xsID_sharpness, tmp);
	}
	if (camera->sensorHas.denoise) {
		xsmcSetInteger(tmp, sensor->status.denoise);
		xsmcSet(xsResult, xsID_denoise, tmp);
	}
	if (camera->sensorHas.wb_mode) {
		xsmcSetInteger(tmp, sensor->status.wb_mode);
		xsmcSet(xsResult, xsID_whiteBalance, tmp);
	}
}

void xs_camera_configure(xsMachine *the)
{
    Camera camera = xsmcGetHostDataValidate(xsThis, (void *)&xsCameraHooks);
	ensureSensor(camera);

	sensor_t *sensor = esp_camera_sensor_get();
	xsSlot tmp;

	if (camera->sensorHas.brightness && xsmcGet(tmp, xsArg(0), xsID_brightness))
		sensor->set_brightness(sensor, xsmcToInteger(tmp));
	if (camera->sensorHas.contrast && xsmcGet(tmp, xsArg(0), xsID_contrast))
		sensor->set_contrast(sensor, xsmcToInteger(tmp));
	if (camera->sensorHas.saturation && xsmcGet(tmp, xsArg(0), xsID_saturation))
		sensor->set_saturation(sensor, xsmcToInteger(tmp));
	if (camera->sensorHas.sharpness && xsmcGet(tmp, xsArg(0), xsID_sharpness))
		sensor->set_sharpness(sensor, xsmcToInteger(tmp));
	if (camera->sensorHas.denoise && xsmcGet(tmp, xsArg(0), xsID_denoise))
		sensor->set_denoise(sensor, xsmcToInteger(tmp));
	if (camera->sensorHas.wb_mode && xsmcGet(tmp, xsArg(0), xsID_whiteBalance))
		sensor->set_wb_mode(sensor, xsmcToInteger(tmp));
}

/*
	Disposable HostBuffer
*/

void _xs_disposable_hostbuffer_destructor(void *data)
{
}

void _xs_disposable_hostbuffer_close(xsMachine *the)
{
	void *buffer = xsmcGetHostData(xsThis);
	if (!buffer)
		return;

	xsmcVars(1);

	xsmcGet(xsVar(0), xsThis, xsID_camera);
    Camera camera = xsmcGetHostDataValidate(xsVar(0), (void *)&xsCameraHooks);

	xSemaphoreTake(camera->mutex, portMAX_DELAY);

	int i;
	for (i = 0; i < kCameraFrameCount; i++) {
		if (camera->frames[i].data == buffer) {
			esp_camera_fb_return(camera->frames[i].fb);
			camera->frames[i].state = kCameraStateFree;
			camera->frames[i].fb = NULL;
			camera->frames[i].data = NULL;
			camera->frames[i].hostBuffer = NULL;
			xSemaphoreGive(camera->mutex);
			xTaskNotify(camera->task, kCaptureBufferReturned, eSetBits);
			xsmcSetHostBuffer(xsThis, NULL, 0);
			return;
		}
	}

	xSemaphoreGive(camera->mutex);
	xsUnknownError("unknown buffer");
}
