import { showStartupSplash } from 'startup-splash'
import { onContextCreated as defaults } from 'app-default-behavior/on-context-created'
import { onContextCreated as probe } from 'live-probe'

export function onLaunch() {
  showStartupSplash()
  return true
}

export function onContextCreated(robot, options) {
  defaults(robot, options)
  probe(robot)
}
