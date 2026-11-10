import type { StackchanAppBehavior } from 'app-behavior'
import { onContextCreated } from 'app-default-behavior/on-context-created'
import { onLaunch } from 'app-default-behavior/on-launch'
import Modules from 'modules'

function integratedLive() {
  return Modules.has('openai-live-integrated')
    ? (Modules.importNow('openai-live-integrated') as StackchanAppBehavior)
    : undefined
}

const behavior: StackchanAppBehavior = {
  onLaunch,
  async onContextCreated(robot, options) {
    await onContextCreated(robot, options)
    await integratedLive()?.onContextCreated?.(robot, options)
  },
  onClose: () => integratedLive()?.onClose?.(),
}

export default behavior
