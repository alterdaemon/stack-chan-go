import { requests } from 'realtimeConversation/http'
import { transports } from 'realtimeConversation/transport'
import Debug from 'device-debug'
import { samples } from 'io-performance'
import config from 'mc/config'
import Modules from 'modules'
import { ConversationFeedback } from 'openai-live-feedback'
import { LiveSession } from 'openai-live-session'
import Preference from 'preference'
import { assert, equal } from 'testing/assert'
import Time from 'time'
import Timer from 'timer'

function equalConfig(actual, expected) {
  if (expected && typeof expected === 'object') {
    equal(Object.keys(actual).length, Object.keys(expected).length, 'all configuration fields preserved')
    for (const key of Object.keys(expected)) equalConfig(actual[key], expected[key])
  } else equal(actual, expected, 'configuration leaf preserved')
}

async function run() {
  const diagnosticEvents = []
  const recorder = {
    enabled: false,
    emit(_component, event) {
      diagnosticEvents.push(event)
    },
  }
  Debug.install(recorder)
  globalThis.amp = {}
  const buttons = new Map(),
    balloons = [],
    colors = []
  let acquired = 0,
    released = 0,
    mouth = 0
  const robot = {
    led: { head: { on: (...rgb) => colors.push(rgb.join(',')), off: () => colors.push('off') } },
    setMouthOpen(value) {
      mouth = value
    },
    audio: {
      acquireExclusive() {
        acquired++
        return () => released++
      },
    },
    connectivity: { network: { ready: Promise.resolve({ status: 'connected' }) } },
    ui: {
      drawer: {
        addDrawerButton(button) {
          buttons.set(button.key, button)
        },
        setDrawerButtonState() {},
      },
      showBalloon(message) {
        balloons.push(message)
      },
    },
  }
  const mod = Modules.importNow('openai-live-integrated')
  mod.onContextCreated(robot)
  const button = buttons.get('openai-live:session')
  assert(button, 'integrated MOD registers GPT-Live action')
  async function waitFor(message) {
    for (let i = 0; i < 100; i++) {
      const error = balloons.find((value) => value.startsWith('GPT-Live error'))
      assert(!error, error)
      if (balloons.includes(message)) return
      await new Promise((resolve) => Timer.set(resolve, 1))
    }
    assert(false, `startup did not reach ${message}`)
  }
  async function checkMouth(interval) {
    for (let i = 0; samples.length < 4 && i < 100; i++) await new Promise((resolve) => Timer.set(resolve, 20))
    equal(samples.length, 4, 'mouth timer samples playback levels')
    for (let i = 1; i < samples.length; i++) {
      const elapsed = samples[i] - samples[i - 1]
      assert(elapsed >= interval - 30 && elapsed <= interval + 100, `mouth interval ${elapsed}/${interval}`)
    }
    assert(mouth > 0, 'playback levels animate the mouth')
  }
  async function checkMouthStopped() {
    const count = samples.length
    await new Promise((resolve) => Timer.set(resolve, 250))
    equal(samples.length, count, 'closed session has no mouth timer')
    equal(mouth, 0, 'close restores mouth')
    samples.length = 0
  }
  button.callback()
  await waitFor('GPT-Live 1 connected')
  await checkMouth(100)
  equal(colors[0], 'off', 'connecting turns LEDs off before remote startup')
  equal(colors[1], '0,19,6', 'existing timer initially shows dim ready green')
  equal(colors[2], '0,45,95', 'actual meter progress shows cyan')
  equal(colors.length, 3, 'unchanged playback makes no repeated LED writes')
  equal(acquired, 1, 'host audio acquired')
  equal(transports[0].options.bargeIn, false, 'missing saved preference keeps native interruption off')
  equal(requests.length, 1, 'one signaling request')
  const session = JSON.parse(requests[0].init.body).session
  equal(session.model, config.openaiLive.model, 'configured voice model reaches signaling')
  equal(session.delegation.responses.model, config.openaiLive.backendModel, 'backend model reaches signaling')
  equal(session.delegation.responses.reasoning.effort, config.openaiLive.reasoningEffort, 'reasoning reaches signaling')
  equalConfig(session.delegation.responses.tools, config.openaiLive.tools ?? undefined)
  if (config.openaiLive.tools?.length) equal(session.delegation.responses.tool_choice, 'auto', 'hosted tool choice')
  else equal(session.delegation.responses.tool_choice, undefined, 'baseline has no tools')
  trace(`verified config ${JSON.stringify({ model: session.model, delegation: session.delegation })}\n`)
  button.callback()
  await waitFor('GPT-Live 1 stopped')
  equal(released, 1, 'host audio released')
  await checkMouthStopped()
  equal(colors[colors.length - 1], 'off', 'close turns LEDs off without leaving a timer')
  equal(globalThis.amp.sampleRate, 24000, 'host audio rate restored')
  equal(diagnosticEvents.length, 0, 'diagnostics Off leaves startup and close unrecorded')
  recorder.enabled = true
  Preference.set('openailive', 'backendModel', 'saved-backend')
  Preference.set('openailive', 'reasoningEffort', 'none')
  Preference.set('openailive', 'bargeIn', '1')
  balloons.length = 0
  button.callback()
  await waitFor('GPT-Live 1 connected')
  equal(requests.length, 2, 'new start creates a fresh signaling request')
  equal(transports[1].options.bargeIn, true, 'saved opt-in reaches the native transport')
  await checkMouth(200)
  for (let i = 0; i < 50; i++) transports[1].callback({ type: 'bargeIn' })
  equal(transports[1].sent.length, 0, 'unclassified speech must not inject stop instructions')
  const next = JSON.parse(requests[1].init.body).session
  equal(next.delegation.responses.model, 'saved-backend', 'saved backend reaches signaling on restart')
  equal(next.delegation.responses.reasoning.effort, 'none', 'none is an explicit effort, not a missing preference')
  equal(next.model, session.model, 'voice model is unchanged')
  button.callback()
  await waitFor('GPT-Live 1 stopped')
  equal(released, 2, 'restarted session releases host audio')
  await checkMouthStopped()
  assert(
    diagnosticEvents.includes('finish'),
    'enabled diagnostics retain close while synchronous transport releases resources',
  )
  recorder.enabled = false
  // Exercise the real one-shot XS Timer, protocol and ownership with a short
  // configured interval; Node tests cover the exact default 60-second boundary.
  const states = []
  const live = new LiveSession({
    Conversation: Modules.importNow('realtimeConversation'),
    Timer,
    audio: robot.audio,
    networkReady: robot.connectivity.network.ready,
    acquireLowLatency: () => ({ close() {} }),
    amp: globalThis.amp,
    settings: { apiKey: 'test-only', voice: 'marin', pitch: 3, bargeIn: false, standbySeconds: 1 },
    onState: (state) => states.push(state),
  })
  await live.start()
  const transport = transports[2]
  transport.message({ type: 'session.input_transcript.delta', delta: 'Order 42.', start_ms: 0, end_ms: 100 })
  transport.message({ type: 'session.delegation.created', delegation: { id: 'del_test' } })
  await new Promise((resolve) => Timer.set(resolve, 1100))
  equal(states[states.length - 1], 'connected', 'quiet backend work prevents standby')
  transport.message({ type: 'response.event', delegation_id: 'del_test', event: { type: 'response.completed' } })
  await new Promise((resolve) => Timer.set(resolve, 1100))
  equal(states[states.length - 1], 'standby', 'idle timer closes through the protocol')
  equal(released, 3, 'standby releases host audio')
  equal(transport.sent[0].type, 'session.close', 'standby requests remote finalization')
  await live.start()
  const resumed = JSON.parse(requests[3].init.body).session
  equal(resumed.input[0].content[0].text, 'Order 42.', 'new signaling request carries RAM context')
  equal(globalThis.amp.sampleRate, 16000, 'resume reacquires audio')
  await live.stop()
  equal(released, 4, 'resumed session releases host audio')
  equal(globalThis.amp.sampleRate, 24000, 'standby and explicit stop restore host rate')
  // Real XS Timer service must wait for acknowledgement AND commanded duration.
  const targets = [],
    starts = []
  let acquiredMotion = 0,
    torqueReleased = 0,
    audibleMs = 0
  const rotation = { y: 0.2, p: -0.7, r: 0 }
  const speaking = new ConversationFeedback({
    entry: { backend: new Map(), conversation: { muted: false }, inputUntil: 0 },
    bargeIn: true,
    now: () => Time.ticks,
    motion: {
      trySpeakingMotion(done) {
        acquiredMotion++
        done({
          rotation,
          valid: () => true,
          move(target, time, acknowledged) {
            targets.push(target)
            starts.push(Time.ticks)
            equal(time, 0.5, 'gesture uses the fixed smooth target duration')
            Timer.set(() => acknowledged(), 150)
            return true
          },
          release(acknowledged) {
            torqueReleased++
            acknowledged()
          },
          cancel() {},
        })
      },
    },
  })
  const began = Time.ticks
  const gestureTimer = Timer.repeat(() => {
    if (Time.ticks - began < 2500) audibleMs += 100
    speaking.tick({ audibleMs, outputIdleMs: 10000, outputSuppressed: false })
  }, 100)
  await new Promise((resolve) => Timer.set(resolve, 3900))
  Timer.clear(gestureTimer)
  speaking.close()
  equal(acquiredMotion, 1, 'longer speech acquires one fresh pose')
  equal(targets.length, 2, 'normal speech completion sends one target and its return')
  assert(starts[0] - began >= 2000, 'short replies do not force a gesture')
  assert(starts[1] - starts[0] >= 650, 'next target waits for delayed acknowledgement and movement')
  equal(targets[1].y, rotation.y, 'normal completion restores starting yaw')
  equal(targets[1].p, rotation.p, 'normal completion restores starting pitch')
  equal(torqueReleased, 1, 'settled speech releases torque once')
  trace('@@STACKCHAN_TEST:PASS@@\n')
}
run().catch((error) => {
  trace(`${String(error)}\n`)
  trace('@@STACKCHAN_TEST:FAIL@@\n')
})
