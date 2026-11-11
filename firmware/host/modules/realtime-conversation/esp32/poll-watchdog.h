// SPDX-License-Identifier: Apache-2.0

#pragma once
#include <stdatomic.h>
#include <stdbool.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static inline bool livePollTimedOut(const atomic_uint *lastPollTick, TickType_t timeout)
{
    // Snapshot the heartbeat before the clock. A poll can preempt this task
    // between reads. Loading a newer heartbeat after an older clock would
    // underflow the unsigned age and falsely close a healthy conversation.
    TickType_t polled = atomic_load(lastPollTick);
    TickType_t now = xTaskGetTickCount();
    return (TickType_t)(now - polled) > timeout;
}
