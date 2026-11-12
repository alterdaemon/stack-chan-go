#ifndef DEBUG_TEST_PLATFORM_H
#define DEBUG_TEST_PLATFORM_H
#include <stdbool.h>
#include <stdint.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
typedef struct {} xsMachine;
static bool testEnable;
#define xsArg(n) (n)
#define xsmcToBoolean(n) (testEnable)
#define xsmcToInteger(n) (n)
#define xsUnknownError(...) abort()
#define xsmcVars(...) ((void)0)
#define xsmcSetNewObject(...) ((void)0)
#define xsmcSetNumber(...) ((void)0)
#define xsmcSetString(...) ((void)0)
#define xsmcSetBoolean(...) ((void)0)
#define xsmcSet(...) ((void)0)
typedef pthread_mutex_t portMUX_TYPE;
#define portMUX_INITIALIZER_UNLOCKED PTHREAD_MUTEX_INITIALIZER
#define portENTER_CRITICAL(lock) pthread_mutex_lock(lock)
#define portEXIT_CRITICAL(lock) pthread_mutex_unlock(lock)
static atomic_llong fakeMicros;
static inline int64_t esp_timer_get_time(void) { return atomic_fetch_add(&fakeMicros, 10); }
typedef struct { unsigned char app_elf_sha256[32]; char idf_ver[32]; } esp_app_desc_t;
static inline const esp_app_desc_t *esp_app_get_description(void) { static esp_app_desc_t app; return &app; }
static inline int esp_reset_reason(void) { return 0; }
#define MALLOC_CAP_8BIT 1
#define MALLOC_CAP_INTERNAL 2
static inline unsigned heap_caps_get_free_size(int caps) { return 1000; }
static inline unsigned heap_caps_get_minimum_free_size(int caps) { return 900; }
#endif
