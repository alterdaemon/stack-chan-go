import { createAppControllerApplication } from 'app-controller'
import { SimpleFace } from 'behaviors/face'
import { ChatStatusBar } from 'chat-status-bar'
import { SpeechBalloon } from 'effects/speech-balloon'
import { onContextCreated } from 'openai-live-integrated'
import { Container } from 'piu/MC'
import { assert, equal } from 'testing/assert'
import Time from 'time'
import Timer from 'timer'

const delay = () => new Promise((resolve) => Timer.set(resolve, 10))

async function run() {
  globalThis.amp = {}
  const controller = createAppControllerApplication(
    { face: new SimpleFace({}), appBar: new ChatStatusBar() },
    { displayListLength: 4096 },
  )
  const app = controller.application
  const buttons = new Map()
  let control, balloon, message
  let acquired = 0,
    released = 0
  onContextCreated({
    audio: {
      acquireExclusive() {
        acquired++
        return () => released++
      },
    },
    connectivity: { network: { ready: Promise.resolve({ status: 'connected' }) } },
    ui: {
      addEffect(effect, key) {
        control = effect
        controller.addEffect(effect, key)
      },
      drawer: {
        addDrawerButton(button) {
          buttons.set(button.key, button)
          controller.addDrawerButton(button)
          controller.bindDrawerAction(button.key, button.callback)
        },
        setDrawerButtonState: (key, active) => controller.setDrawerButtonState(key, active),
      },
      showBalloon(text, options) {
        message = text
        balloon = new SpeechBalloon({ ...options, text })
        controller.addEffect(balloon, 'live-control-test-balloon')
      },
    },
  })
  await delay()
  assert(control, 'face receives a LIVE control')
  assert(control.x < app.width / 2 && control.y > app.height / 2, 'control is in the bottom-left corner')
  equal(control.first.string, 'LIVE OFF', 'starts visibly off')
  equal(acquired, 0, 'adding the control does not start a conversation')
  const label = () => control.first.string
  const menu = buttons.get('openai-live:session')
  const point = () => [control.x + control.width / 2, control.y + control.height / 2]
  function touch(phase, x, y) {
    screen.context[`onTouch${phase}`](0, x, y, Time.ticks)
  }
  function gesture(dx = 0, dy = 0, x = point()[0], y = point()[1]) {
    touch('Began', x, y)
    touch('Moved', x + dx, y + dy)
    touch('Ended', x + dx, y + dy)
  }
  async function waitFor(expected) {
    for (let i = 0; i < 100; i++) {
      assert(!message?.startsWith('GPT-Live error'), message)
      if (label() === expected) {
        await delay()
        return
      }
      await delay()
    }
    assert(false, `LIVE control did not reach ${expected}`)
  }

  for (const [dx, dy, name] of [
    [50, 0, 'horizontal drag'],
    [0, 40, 'downward drag'],
    [0, -16, 'short upward drag'],
    [45, -60, 'diagonal drag'],
  ]) {
    gesture(dx, dy)
    equal(label(), 'LIVE OFF', `${name} does not toggle`)
  }
  gesture(0, -60, app.width - 20, app.height - 20)
  equal(label(), 'LIVE OFF', 'outside swipe does not toggle')
  const [x, y] = point()
  touch('Began', x, y)
  touch('Moved', x + 50, y)
  touch('Ended', x, y)
  equal(label(), 'LIVE OFF', 'batched move away and back cannot become a tap')
  touch('Began', x, y)
  control.behavior.onTouchCancelled(control)
  touch('Ended', x, y)
  equal(label(), 'LIVE OFF', 'cancelled touch does not toggle')
  equal(acquired, 0, 'rejected gestures never acquire audio')

  app.first.content('ChatStatusBar').delegate('onFinished')
  gesture()
  equal(label(), 'LIVE...', 'tap starts a connection even with the AppBar hidden')
  gesture()
  await waitFor('LIVE OFF')
  equal(acquired, 0, 'a second tap cancels a pending start')

  touch('Began', x, y)
  touch('Moved', x, y - 60)
  equal(label(), 'LIVE OFF', 'swipe does not toggle before release')
  touch('Ended', x, y - 60)
  await waitFor('LIVE ON')
  equal(acquired, 1, 'upward swipe outside the button starts exactly one session')
  assert(balloon.y + balloon.height <= control.y, 'GPT-Live messages do not cover the control')
  menu.callback()
  equal(label(), 'STOP...', 'menu stop updates the shortcut immediately')
  equal(control.active, false, 'closing control cannot be activated')
  menu.callback()
  gesture()
  await waitFor('LIVE OFF')
  equal(released, 1, 'closing releases audio exactly once')

  menu.callback()
  await waitFor('LIVE ON')
  gesture()
  await waitFor('LIVE OFF')
  equal(acquired, 2, 'menu and shortcut share session ownership')
  equal(released, 2, 'tap stops a menu-started conversation')

  controller.openDrawer()
  gesture()
  controller.closeDrawer()
  await delay()
  equal(acquired, 2, 'drawer overlay blocks the shortcut')
  controller.setMain(new Container(null, { left: 0, right: 0, top: 0, bottom: 0 }))
  await delay()
  gesture(0, 0, x, y)
  equal(acquired, 2, 'shortcut is absent when the face is replaced')
  controller.showFace()
  await delay()
  gesture(0, -60)
  await waitFor('LIVE ON')
  gesture(0, -60)
  await waitFor('LIVE OFF')
  equal(acquired, 3, 'shortcut returns with the face')
  equal(released, 3, 'swipe also stops the conversation')
  trace('@@STACKCHAN_TEST:PASS@@\n')
}

run().catch((error) => {
  trace(`${String(error)}\n`)
  trace('@@STACKCHAN_TEST:FAIL@@\n')
})
