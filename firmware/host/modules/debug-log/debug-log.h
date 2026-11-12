// SPDX-License-Identifier: Apache-2.0
#ifndef STACKCHAN_DEBUG_LOG_H
#define STACKCHAN_DEBUG_LOG_H
#include <stdint.h>
/* An unlinked recorder is a no-op on other builds and in native audio tests. */
extern void stackchanDebugNative(unsigned event, unsigned request, int value, int result) __attribute__((weak));
static inline void stackchanDebugTransition(unsigned event, unsigned request, int value, int result) {
    if (stackchanDebugNative) stackchanDebugNative(event, request, value, result);
}
enum {
    DEBUG_INTERRUPT = 1, DEBUG_FLUSH_BEGIN, DEBUG_FLUSH_END, DEBUG_RESUME,
    DEBUG_AUDIO_STOP, DEBUG_OUTPUT_RECOVER, DEBUG_PEER_EVENT, DEBUG_TRANSPORT_FAILURE
};
enum { DEBUG_TUNE_RESET, DEBUG_TUNE_SPEAKER, DEBUG_TUNE_CAPTURE, DEBUG_TUNE_NLP };
extern int stackchanAudioDebugSet(unsigned parameter, unsigned value) __attribute__((weak));
extern unsigned stackchanAudioDebugGet(unsigned parameter) __attribute__((weak));
#endif
