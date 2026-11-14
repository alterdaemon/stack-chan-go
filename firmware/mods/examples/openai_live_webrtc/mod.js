import Modules from 'modules'
import { trialPreferences } from 'openai-live-debug-trials'
import { ConversationFeedback } from 'openai-live-feedback'
import { diagnostic, formatLiveError, LiveSession, liveModelLabel } from 'openai-live-session'
import { readLiveSettings } from 'openai-live-settings'
import Preference from 'preference'
import Time from 'time'
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
  'sign-in': 'Sign in to ChatGPT in Wi-Fi Settings',
}
const notices = {
  idle: 'STOPPED',
  connected: 'STARTED',
  configuration: 'SET KEY',
  'sign-in': 'SIGN IN',
  error: 'ERROR',
}

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
  const debug = Modules.has('device-debug') ? Modules.importNow('device-debug') : undefined
  const drawer = robot.ui.drawer
  const defaults =
    (Modules.has('mod/config') ? Modules.importNow('mod/config').openaiLive : undefined) ??
    Modules.importNow('mc/config').openaiLive ??
    {}
  const readSettings = (trials) =>
    readLiveSettings(
      defaults,
      trialPreferences((domain, key) => Preference.get(domain, key), trials),
    )
  let changingMute = false,
    backendProbe,
    liveButton,
    statusTimer
  let mouthTimer,
    feedback,
    headLed,
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
      const label = liveModelLabel(session.settings.mode, session.settings.model)
      robot.ui.showBalloon(
        state === 'error'
          ? formatLiveError(detail, session.settings.mode, session.settings.model)
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
      state === 'error' || state === 'configuration' || state === 'sign-in' ? 5000 : 1200,
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
    now: () => Time.ticks,
    onInterruption: () => feedback?.interrupt(),
    onState(state, detail) {
      const active = ['connecting', 'connected', 'closing'].includes(state)
      if (!active) debug?.releaseLive(session)
      if (state === 'connecting') {
        headLed = robot.lighting?.led?.head
        try {
          headLed?.off()
        } catch {
          headLed = undefined
        }
      }
      if (state === 'connected' && mouthTimer === undefined && levels) {
        feedback = new ConversationFeedback({
          led: headLed,
          motion: robot.motion,
          entry: session.active,
          bargeIn: session.settings.bargeIn,
          now: () => Time.ticks,
        })
        mouthTimer = Timer.repeat(
          () => {
            const sample = levels.levels()
            const level = sample.playbackLevel ?? 0
            updateMouth(Math.min(10, Math.round(level / 200)) / 10)
            try {
              feedback?.tick(sample)
            } catch {
              feedback?.close()
              feedback = undefined
            }
          },
          session.settings.bargeIn ? 200 : 100,
        )
      } else if (state !== 'connected') {
        if (mouthTimer !== undefined) Timer.clear(mouthTimer)
        mouthTimer = undefined
        feedback?.close()
        feedback = undefined
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
    backendProbe?.cancel()
    clearStatus()
    debug?.unregisterLive(session)
    return session.stop()
  }
  function startLive(interruption, stage, voice, trials) {
    if (shuttingDown || session.active || backendProbe) return
    session.settings = readSettings(trials)
    const apiTrial =
      trials?.connection === 'api-live' &&
      stage === 4 &&
      voice === undefined &&
      trials.model === undefined &&
      trials.effort === undefined
    if ((trials !== undefined || stage < 4 || voice !== undefined) && session.settings.auth !== 'chatgpt' && !apiTrial)
      throw Object.assign(new Error('Select ChatGPT subscription'), { code: 'not_subscription' })
    return session.start(interruption, stage, voice)
  }
  debug?.registerLive(session, {
    isActive: () => shuttingDown || !!session.active || !!backendProbe,
    stats: () => {
      const stats = { ...session.active?.conversation?.stats }
      try {
        stats.amplifierVolume = globalThis.amp?.volume
      } catch {}
      return stats
    },
    start: startLive,
    stop: () => {
      backendProbe?.cancel()
      return session.stop()
    },
    async mute(muted) {
      await session.setMuted(muted)
      if (!session.active?.conversation || session.active.conversation.muted !== muted)
        throw Object.assign(new Error('Mute did not apply'), { code: 'not_connected' })
    },
    async backend() {
      if (shuttingDown || session.active || backendProbe)
        throw Object.assign(new Error('LIVE is active'), { code: 'live_active' })
      if (readSettings().auth !== 'chatgpt')
        throw Object.assign(new Error('Select ChatGPT subscription'), { code: 'not_subscription' })
      const auth = Modules.importNow('realtimeConversation/subscription')
      const radio = power.acquireLowLatency()
      let probe
      try {
        probe = Modules.importNow('device-debug/subscription-probes', true).detachedBackendProbe({
          credentials: async () => {
            const network = await robot.connectivity.network?.ready
            if (network?.status !== 'connected')
              throw Object.assign(new Error('Network unavailable'), { code: 'network_unavailable' })
            if (!debug.enabled || shuttingDown || session.active)
              throw Object.assign(new Error('Diagnostic session ended'), { code: 'cancelled' })
            return auth.credentials()
          },
          fetch: Modules.importNow('realtimeConversation/http'),
          random: () => Modules.importNow('rng').get(16),
          diagnose: (event, fields) => debug.event('subscription', event, fields),
        })
        backendProbe = probe
        await probe
      } finally {
        if (backendProbe === probe) backendProbe = undefined
        radio.close()
      }
    },
    async warmup() {
      if (shuttingDown || session.active) throw Object.assign(new Error('LIVE is active'), { code: 'live_active' })
      if (readSettings().auth !== 'chatgpt')
        throw Object.assign(new Error('Select ChatGPT subscription'), { code: 'not_subscription' })
      const network = await robot.connectivity.network?.ready
      if (network?.status !== 'connected')
        throw Object.assign(new Error('Network unavailable'), { code: 'network_unavailable' })
      await Modules.importNow('realtimeConversation/subscription').credentials()
    },
  })
  function toggleLive() {
    if (shuttingDown || session.active?.closing) return
    if (session.active) void session.stop()
    else {
      try {
        void startLive()
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
