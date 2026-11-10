import { requests } from 'realtimeConversation/http'
import config from 'mc/config'
import Modules from 'modules'
import Preference from 'preference'
import { assert, equal } from 'testing/assert'
import Timer from 'timer'

function equalConfig(actual, expected) {
  if (expected && typeof expected === 'object') {
    equal(Object.keys(actual).length, Object.keys(expected).length, 'all configuration fields preserved')
    for (const key of Object.keys(expected)) equalConfig(actual[key], expected[key])
  } else equal(actual, expected, 'configuration leaf preserved')
}

async function run() {
  globalThis.amp = {}
  const buttons = new Map(),
    balloons = []
  let acquired = 0,
    released = 0
  const robot = {
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
  button.callback()
  await waitFor('GPT-Live connected')
  equal(acquired, 1, 'host audio acquired')
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
  await waitFor('GPT-Live stopped')
  equal(released, 1, 'host audio released')
  equal(globalThis.amp.sampleRate, 24000, 'host audio rate restored')
  Preference.set('openailive', 'backendModel', 'saved-backend')
  Preference.set('openailive', 'reasoningEffort', 'none')
  balloons.length = 0
  button.callback()
  await waitFor('GPT-Live connected')
  equal(requests.length, 2, 'new start creates a fresh signaling request')
  const next = JSON.parse(requests[1].init.body).session
  equal(next.delegation.responses.model, 'saved-backend', 'saved backend reaches signaling on restart')
  equal(next.delegation.responses.reasoning.effort, 'none', 'none is an explicit effort, not a missing preference')
  equal(next.model, session.model, 'voice model is unchanged')
  button.callback()
  await waitFor('GPT-Live stopped')
  equal(released, 2, 'restarted session releases host audio')
  trace('@@STACKCHAN_TEST:PASS@@\n')
}
run().catch((error) => {
  trace(`${String(error)}\n`)
  trace('@@STACKCHAN_TEST:FAIL@@\n')
})
