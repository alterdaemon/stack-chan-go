// Copyright (c) 2026 Shinya Ishikawa
// SPDX-License-Identifier: Apache-2.0

import Conversation from 'realtimeConversation/core'
import fetch from 'realtimeConversation/http'
import Transport from 'realtimeConversation/transport'
import Debug from 'device-debug'
import Modules from 'modules'
import Timer from 'timer'

export default class RealtimeConversation extends Conversation {
  constructor(options) {
    super(options, {
      debug: Debug,
      createTransport: (callback) => new Transport(callback, Debug),
      fetch,
      createSubscription: (options) => {
        if (!Modules.has('realtimeConversation/subscription'))
          throw new TypeError('Subscription unavailable on this build')
        return Modules.importNow('realtimeConversation/subscription').createSubscription(options)
      },
      setTimeout: (callback, delay) => Timer.set(callback, delay),
      clearTimeout: (timer) => Timer.clear(timer),
    })
  }
}
