import Modules from 'modules'
import { LiveSession } from 'openai-live-session'
import { readLiveSettings } from 'openai-live-settings'
import Preference from 'preference'
import Timer from 'timer'

const SESSION = 'openai-live:session'
const MUTE = 'openai-live:mute'
const messages = {
  idle: 'GPT-Live stopped',
  connecting: 'Connecting GPT-Live',
  connected: 'GPT-Live connected',
  closing: 'Stopping GPT-Live',
  configuration: 'Set AI token in Preferences',
  error: 'GPT-Live error. Start again.',
}

export function onContextCreated(robot) {
  if (!Modules.has('realtimeConversation') || !robot.audio.acquireExclusive || !globalThis.amp) {
    robot.ui.showBalloon('GPT-Live host required')
    return
  }
  const Conversation = Modules.importNow('realtimeConversation')
  const power = Modules.importNow('network-power')
  const levels = Modules.has('io-performance') ? Modules.importNow('io-performance') : undefined
  const drawer = robot.ui.drawer
  const defaults =
    (Modules.has('mod/config') ? Modules.importNow('mod/config').openaiLive : undefined) ??
    Modules.importNow('mc/config').openaiLive ??
    {}
  const readSettings = () => readLiveSettings(defaults, (domain, key) => Preference.get(domain, key))
  let changingMute = false
  let mouthTimer,
    lastMouth = 0
  function updateMouth(value) {
    if (value === lastMouth) return
    lastMouth = value
    try {
      robot.setMouthOpen?.(value, true)
    } catch {
      // A rendering failure must not prevent session cleanup.
    }
  }
  const session = new LiveSession({
    Conversation,
    audio: robot.audio,
    networkReady: robot.connectivity.network?.ready,
    acquireLowLatency: () => power.acquireLowLatency(),
    amp: globalThis.amp,
    settings: readSettings(),
    onState(state) {
      const active = ['connecting', 'connected', 'closing'].includes(state)
      if (state === 'connected' && mouthTimer === undefined && levels && robot.setMouthOpen) {
        mouthTimer = Timer.repeat(() => {
          const level = levels.levels().referenceLevel ?? 0
          updateMouth(Math.min(10, Math.round(level / 200)) / 10)
        }, 100)
      } else if (state !== 'connected') {
        if (mouthTimer !== undefined) Timer.clear(mouthTimer)
        mouthTimer = undefined
        updateMouth(0)
      }
      try {
        robot.ui.setFaceMotionEnabled?.(!active)
      } catch {
        // Optional face controls must not prevent session cleanup.
      }
      try {
        drawer.setDrawerButtonState(SESSION, active)
        drawer.setDrawerButtonState(MUTE, false)
        robot.ui.showBalloon(messages[state])
      } catch {
        // Display failures must not prevent native audio/radio cleanup.
      }
      // Never log credentials, server error bodies, SDP or transcripts.
      trace(`[openai-live] ${state}\n`)
    },
  })
  drawer.addDrawerButton({
    key: SESSION,
    label: 'GPT-Live',
    kind: 'toggle',
    initialState: false,
    callback: () => {
      if (session.active) void session.stop()
      else {
        session.settings = readSettings()
        void session.start()
      }
    },
  })
  drawer.addDrawerButton({
    key: MUTE,
    label: 'Mute mic',
    kind: 'toggle',
    initialState: false,
    callback: () => {
      if (changingMute) return
      changingMute = true
      const muted = !session.active?.conversation?.muted
      void session.setMuted(muted).then((value) => {
        changingMute = false
        drawer.setDrawerButtonState(MUTE, value)
      })
    },
  })
}
