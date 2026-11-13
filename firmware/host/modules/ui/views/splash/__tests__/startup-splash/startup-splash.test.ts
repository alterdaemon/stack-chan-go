import { SUPPORTED_LOCALES, setLocalizationLanguage } from 'localization'
import type { Container as PiuContainer, Content as PiuContent, Label as PiuLabel, Style as PiuStyle } from 'piu/MC'
import { showStartupSplash, showWiFiConnectionStatus, showWiFiRecoveryChoice } from 'startup-splash'
import { assert, equal } from 'testing/assert'
import Timer from 'timer'

trace('=== startup-splash test ===\n')

function find(root: PiuContainer, name: string): PiuContent | undefined {
  for (let node = root.first; node; node = node.next) {
    if (node.name === name) return node
    const child = find(node as PiuContainer, name)
    if (child) return child
  }
  return undefined
}

function tap(content: PiuContent | undefined) {
  assert(!!content, 'action must exist')
  const button = content as PiuContent
  const behavior = button.behavior as {
    onTouchBegan(content: PiuContent, id: number, x: number, y: number): void
    onTouchEnded(content: PiuContent): void
  }
  behavior.onTouchBegan(button, 0, button.x, button.y)
  behavior.onTouchEnded(button)
}

let settingsCount = 0
let modsCount = 0
let retryCount = 0
let offlineCount = 0
let index = 0
let recovery = false
let application: ReturnType<typeof showStartupSplash>

const settingsOnly = showStartupSplash({
  onSettings() {
    settingsCount++
  },
})
equal((find(settingsOnly, 'startup:actions') as PiuContainer).length, 1)
tap(find(settingsOnly, 'startup:settings'))
equal(settingsCount, 1, 'settings-only startup retains its callback')
settingsCount = 0

function showLocale() {
  const locale = SUPPORTED_LOCALES[index]
  setLocalizationLanguage(locale)
  application = showStartupSplash({
    onSettings() {
      settingsCount++
    },
    onMods() {
      modsCount++
    },
  })
  trace(`RENDER splash ${locale} welcome\n`)
}

showLocale()
const timer = Timer.repeat(() => {
  const title = find(application, 'startup:title') as PiuLabel
  const fork = find(application, 'startup:fork') as PiuLabel
  const version = find(application, 'startup:version') as PiuLabel
  const message = find(application, 'startup:message') as PiuLabel
  const actions = find(application, 'startup:actions') as PiuContainer
  equal(application.width, 320)
  equal(application.height, 240)
  equal(title.string, 'Stack-chan[・＿・]')
  equal(fork.string, 'GO')
  equal(version.string, 'v2.1.0-R15', 'display the complete embedded fork revision')
  assert(
    (version.style as PiuStyle).measure('GO').height < (fork.style as PiuStyle).measure('GO').height,
    'version must be smaller than GO',
  )
  equal(fork.y, title.y + title.height)
  equal(version.y, fork.y + fork.height)
  equal(message.y, version.y + version.height)
  assert(message.y + message.height <= actions.y, 'progress must stay above the actions')
  equal(actions.y, 184, 'retain the original bottom action position')
  equal(actions.height, 44, 'retain existing touch targets')
  for (const label of [title, fork, version, message]) {
    assert((label.style as PiuStyle).measure(label.string).width <= label.width, 'text must fit its label')
  }
  for (let button = actions.first; button; button = button.next) {
    equal(button.height, 44)
    equal(button.width, 148)
    assert(button.y + button.height <= 228, 'button must fit the existing bottom margin')
  }

  if (!recovery) {
    tap(find(application, 'startup:settings'))
    tap(find(application, 'startup:mods'))
    equal(settingsCount, index + 1)
    equal(modsCount, index + 1)
    showWiFiConnectionStatus({ attempt: 1, maxAttempts: 3 })
    equal(actions.length, 0, 'connecting hides actions without removing identity')
    assert(message.string.length > 0)
    showWiFiRecoveryChoice({
      message: 'Wi-Fi unavailable',
      onRetry() {
        retryCount++
      },
      onOffline() {
        offlineCount++
      },
    })
    recovery = true
    trace(`RENDER splash ${SUPPORTED_LOCALES[index]} recovery\n`)
    return
  }

  equal(message.string, 'Wi-Fi unavailable')
  tap(actions.first)
  tap(actions.last)
  equal(retryCount, index + 1)
  equal(offlineCount, index + 1)
  recovery = false
  if (++index < SUPPORTED_LOCALES.length) {
    showLocale()
    return
  }
  Timer.clear(timer)
  setLocalizationLanguage('ja')
  trace('@@STACKCHAN_TEST:PASS@@\n')
}, 100)
