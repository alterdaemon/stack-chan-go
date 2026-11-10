import Performance from 'io-performance'
import { scheduleScreen } from 'screen-scheduler'
import Timer from 'timer'
import Modules from 'modules'

// Keep display callbacks ahead of XS transport polling. Native capture, codecs,
// playback and networking retain their existing, higher task priorities.
export default function (done) {
  native('xs_realtime_media_setup')()
  Performance.setMainPriority(6)
  const measure = Modules.has('live-probe') ? (kind) => Performance.mark(kind) : undefined
  if (globalThis.screen) scheduleScreen(globalThis.screen, Timer, 16, measure)
  done?.()
}
