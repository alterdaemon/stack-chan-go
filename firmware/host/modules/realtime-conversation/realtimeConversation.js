// Copyright (c) 2026 Shinya Ishikawa
// SPDX-License-Identifier: Apache-2.0

import Conversation from 'realtimeConversation/core'
import fetch from 'realtimeConversation/http'
import Transport from 'realtimeConversation/transport'
import Debug from 'device-debug'
import Timer from 'timer'

export default class RealtimeConversation extends Conversation {
  constructor(options) {
    super(options, {
      debug: Debug,
      createTransport: (callback) => new Transport(callback, Debug),
      fetch,
      setTimeout: (callback, delay) => Timer.set(callback, delay),
      clearTimeout: (timer) => Timer.clear(timer),
    })
  }
}
