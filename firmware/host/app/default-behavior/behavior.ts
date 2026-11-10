import type { StackchanAppBehavior } from 'app-behavior'
import { onContextCreated } from 'app-default-behavior/on-context-created'
import { onLaunch } from 'app-default-behavior/on-launch'
import Modules from 'modules'

const behavior: StackchanAppBehavior = {
  onLaunch,
  async onContextCreated(robot, options) {
    await onContextCreated(robot, options)
    if (Modules.has('openai-live-integrated')) {
      const integrated = Modules.importNow('openai-live-integrated') as StackchanAppBehavior
      await integrated.onContextCreated?.(robot, options)
    }
  },
}

export default behavior
