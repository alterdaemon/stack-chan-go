import Modules from 'modules'
import { diagnostic, formatLiveError, LiveSession } from 'openai-live-session'
import { readLiveSettings } from 'openai-live-settings'
import Preference from 'preference'
import Timer from 'timer'

const SESSION = 'openai-live:session'
const MUTE = 'openai-live:mute'
let closeSession
const messages = {
  idle: 'GPT-Live stopped',
  standby: 'GPT-Live standby',
  connecting: 'Connecting GPT-Live',
  connected: 'GPT-Live connected',
  closing: 'Stopping GPT-Live',
  configuration: 'Set AI token in Preferences',
}
const notices = { idle: 'STOPPED', connected: 'STARTED', configuration: 'SET KEY', error: 'ERROR' }

function createLiveButton(toggle) {
  const { Behavior, Container, Label, Skin } = Modules.importNow('piu/MC')
  const { UI, uiStyles } = Modules.importNow('ui-theme')
  const styles = uiStyles()
  // 75% transparent background; keep the label fully readable.
  const translucent = (color) => new Skin({ fill: `${color}40` })
  const skins = {
    surface: translucent(UI.colors.surface),
    pressed: translucent(UI.colors.surfacePressed),
    accent: translucent(UI.colors.accent),
    success: translucent(UI.colors.success),
  }
  return new Container(null, {
    name: 'openai-live-control',
    left: 4,
    bottom: 4,
    width: 88,
    height: UI.touchTarget,
    active: true,
    contents: [
      new Label(null, {
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        skin: skins.surface,
        string: 'LIVE OFF',
        style: styles.button,
      }),
    ],
    Behavior: class extends Behavior {
      skin = skins.surface
      onLiveState(content, state) {
        content.active = state !== 'closing'
        this.skin = state === 'connected' ? skins.success : state === 'connecting' ? skins.accent : skins.surface
        content.first.string =
          state === 'connected'
            ? 'LIVE ON'
            : state === 'connecting'
              ? 'LIVE...'
              : state === 'closing'
                ? 'STOP...'
                : state === 'standby'
                  ? 'STANDBY'
                  : 'LIVE OFF'
        content.first.skin = this.skin
      }
      onLiveNotice(content, notice) {
        content.first.string = notice
      }
      onTouchBegan(content, id, x, y, ticks) {
        if (!content.active || this.touchId !== undefined) return
        this.touchId = id
        this.startX = x
        this.startY = y
        this.maxX = this.maxY = 0
        content.first.skin = skins.pressed
        content.captureTouch(id, x, y, ticks)
      }
      onTouchMoved(_content, id, x, y, _ticks, samples) {
        if (id !== this.touchId) return
        // Piu batches moves until idle; release may arrive before onTouchMoved.
        for (let i = 0; i < (samples?.length ?? 0); i++) {
          const sample = samples.peek(i)
          this.maxX = Math.max(this.maxX, Math.abs(sample.x - this.startX))
          this.maxY = Math.max(this.maxY, Math.abs(sample.y - this.startY))
        }
        this.maxX = Math.max(this.maxX, Math.abs(x - this.startX))
        this.maxY = Math.max(this.maxY, Math.abs(y - this.startY))
      }
      onTouchCancelled(content) {
        this.touchId = undefined
        content.first.skin = this.skin
      }
      onTouchEnded(content, id, x, y, ticks, samples) {
        if (id !== this.touchId) return
        this.onTouchMoved(content, id, x, y, ticks, samples)
        this.touchId = undefined
        content.first.skin = this.skin
        if (content.active && this.maxX <= 8 && this.maxY <= 8) toggle()
      }
    },
  })
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
  let changingMute = false,
    liveButton,
    statusTimer
  let mouthTimer,
    lastMouth = 0,
    shuttingDown = false
  function clearStatus() {
    if (statusTimer !== undefined) Timer.clear(statusTimer)
    statusTimer = undefined
  }
  function showStatus(state, detail) {
    clearStatus()
    if (liveButton) {
      if (notices[state]) liveButton.delegate('onLiveNotice', notices[state])
    } else {
      const label = session.settings.mode === 'realtime' ? 'GPT-Realtime 2.1 Mini' : 'GPT-Live 1'
      robot.ui.showBalloon(
        state === 'error'
          ? formatLiveError(detail, session.settings.mode)
          : messages[state]?.replace('GPT-Live', label),
      )
    }
    statusTimer = Timer.set(
      () => {
        statusTimer = undefined
        try {
          if (liveButton) liveButton.delegate('onLiveState', state)
          else robot.ui.hideBalloon()
        } catch {
          // A display failure must not affect the conversation.
        }
      },
      state === 'error' || state === 'configuration' ? 5000 : 1200,
    )
  }
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
    Timer,
    Conversation,
    audio: robot.audio,
    networkReady: robot.connectivity.network?.ready,
    acquireLowLatency: () => power.acquireLowLatency(),
    amp: globalThis.amp,
    settings: readSettings(),
    onState(state, detail) {
      const active = ['connecting', 'connected', 'closing'].includes(state)
      if (state === 'connected' && mouthTimer === undefined && levels && robot.setMouthOpen) {
        mouthTimer = Timer.repeat(() => {
          const level = levels.levels().playbackLevel ?? 0
          updateMouth(Math.min(10, Math.round(level / 200)) / 10)
        }, 100)
      } else if (state !== 'connected') {
        if (mouthTimer !== undefined) Timer.clear(mouthTimer)
        mouthTimer = undefined
        updateMouth(0)
      }
      try {
        levels?.setLiveUI?.(active && session.settings.bargeIn === true)
        robot.ui.setFaceMotionEnabled?.(!active)
      } catch {
        // Optional face controls must not prevent session cleanup.
      }
      try {
        liveButton?.delegate('onLiveState', state)
        drawer.setDrawerButtonState(SESSION, active)
        drawer.setDrawerButtonState(MUTE, false)
        if (!shuttingDown) showStatus(state, detail)
      } catch {
        // Display failures must not prevent native audio/radio cleanup.
      }
      // Only machine-readable diagnostics; never raw exception messages or bodies.
      trace(`[openai-live] ${state}\n`)
      if (detail) trace(`[openai-live] diagnostic ${JSON.stringify(detail)}\n`)
    },
  })
  closeSession = () => {
    shuttingDown = true
    clearStatus()
    return session.stop()
  }
  function toggleLive() {
    if (shuttingDown || session.active?.closing) return
    if (session.active) void session.stop()
    else {
      try {
        session.settings = readSettings()
        void session.start()
      } catch (error) {
        session.onState('error', diagnostic(error, 'configuration', 'settings_read'))
      }
    }
  }
  // Keep headless hosts usable; the control belongs to the face's effects layer.
  if (Modules.has('piu/MC')) {
    liveButton = createLiveButton(toggleLive)
    robot.ui.addEffect(liveButton, SESSION)
  }
  drawer.addDrawerButton({
    key: SESSION,
    label: 'OpenAI LIVE',
    kind: 'toggle',
    initialState: false,
    callback: toggleLive,
  })
  drawer.addDrawerButton({
    key: MUTE,
    label: 'Mute mic',
    kind: 'toggle',
    initialState: false,
    callback: () => {
      if (shuttingDown || changingMute) return
      changingMute = true
      const muted = !session.active?.conversation?.muted
      void session.setMuted(muted).then((value) => {
        changingMute = false
        drawer.setDrawerButtonState(MUTE, value)
      })
    },
  })
  return session
}

export function onClose() {
  return closeSession?.()
}
