import { M5StackChanServoDriver } from 'm5stackchan-servo-driver'
import {
  type MotionCompletion,
  MotionController,
  type MotionDriver,
  type MotionResultCallback,
  motionDurationSecondsToCentiseconds,
  motionDurationSecondsToMilliseconds,
  type SpeakingMotion,
} from 'motion-controller'
import { type Maybe, type Pose, type Rotation, wait, waitForCompletion } from 'stackchan-util'
import { assert, equal } from 'testing/assert'
// The fixture replaces only physical serial I/O, exercising the real packet path.
import { port } from './serial'

class FakeMotionDriver implements MotionDriver {
  feedbackReady() {
    return true
  }
  appliedRotation: Rotation | null = null
  appliedTime: number | undefined
  attached = 0
  detached = 0
  getRotationCalls = 0
  rotation: Rotation = { y: 0, p: 0, r: 0 }
  torqueStates: boolean[] = []

  applyRotation(rotation: Rotation, time?: number, callback?: MotionCompletion): void {
    this.appliedRotation = rotation
    this.appliedTime = time
    this.rotation = rotation
    callback?.()
  }

  getRotation(callback: MotionResultCallback<Maybe<Rotation>>): void {
    this.getRotationCalls += 1
    callback({
      success: true,
      value: this.rotation,
    })
  }

  setTorque(torque: boolean, callback?: MotionCompletion): void {
    this.torqueStates.push(torque)
    callback?.()
  }

  onAttached(): void {
    this.attached += 1
  }

  onDetached(): void {
    this.detached += 1
  }
}

async function runTest() {
  trace('=== motion controller test ===\n')

  const driver = new FakeMotionDriver()
  const controller = new MotionController({ driver }, { isPaused: () => false })
  controller.close()

  equal(driver.attached, 1, 'initial driver should be attached')

  controller.lookAt([1, 2, 2])

  const expectedPitch = -Math.atan2(2, Math.sqrt(1 ** 2 + 2 ** 2))
  equal(driver.torqueStates[0], true, 'lookAt update should enable torque before moving')
  assert(driver.appliedRotation != null, 'lookAt update should apply a face rotation')
  assert(
    Math.abs(driver.appliedRotation.p - expectedPitch) < 0.000001,
    'lookAt update should use xy distance when calculating pitch',
  )
  assert(driver.appliedTime != null && driver.appliedTime >= 0.5, 'lookAt movement should use random motion time')
  assert(driver.appliedTime != null && driver.appliedTime <= 1.0, 'lookAt movement should cap random motion time')

  await wait(1100)
  equal(driver.torqueStates[1], false, 'lookAt movement should release torque after motion time')

  controller.lookAway()
  equal(controller.gazePoint, null, 'lookAway should clear the gaze point')

  const pollingDriver = new FakeMotionDriver()
  const pollingController = new MotionController({ driver: pollingDriver }, { isPaused: () => false })
  await wait(500)
  equal(pollingDriver.getRotationCalls, 0, 'pose polling should stay idle without a gaze point')

  pollingController.lookAt([1, 2, 2])
  equal(pollingDriver.getRotationCalls, 1, 'lookAt should sample pose immediately')
  await wait(100)
  assert(pollingDriver.getRotationCalls > 1, 'lookAt should start timer-driven pose polling')

  pollingController.lookAway()
  await wait(1100)
  const callsAfterMotionSettled = pollingDriver.getRotationCalls
  await wait(500)
  equal(pollingDriver.getRotationCalls, callsAfterMotionSettled, 'pose polling should stop after gaze clears')
  pollingController.close()

  const releaseDriver = new FakeMotionDriver()
  const releaseController = new MotionController({ driver: releaseDriver }, { isPaused: () => false })
  releaseController.lookAt([1, 2, 2])
  equal(releaseController.gazePoint?.[0], 1, 'lookAt should set the gaze point')
  releaseController.lookAt(undefined)
  equal(releaseController.gazePoint, null, 'lookAt(undefined) should release the gaze point')
  await wait(1100)
  const releaseCallsAfterSettled = releaseDriver.getRotationCalls
  await wait(500)
  equal(releaseDriver.getRotationCalls, releaseCallsAfterSettled, 'pose polling should stop after lookAt(undefined)')
  releaseController.close()

  const closingDriver = new FakeMotionDriver()
  const closingController = new MotionController({ driver: closingDriver }, { isPaused: () => false })
  closingController.lookAt([1, 2, 2])
  equal(closingDriver.torqueStates[0], true, 'lookAt should enable torque before close')
  closingController.close()
  const callsAfterClose = closingDriver.getRotationCalls
  await wait(1200)
  equal(closingDriver.torqueStates.length, 1, 'close should cancel the pending torque release timer')
  equal(closingDriver.getRotationCalls, callsAfterClose, 'close should stop pose polling')

  equal(motionDurationSecondsToMilliseconds(0.5), 500, 'seconds should convert to milliseconds')
  equal(motionDurationSecondsToMilliseconds(0.1234), 123, 'millisecond conversion should round to integers')
  equal(motionDurationSecondsToMilliseconds(-1), 0, 'millisecond conversion should clamp negative durations')
  equal(motionDurationSecondsToCentiseconds(0.5), 50, 'seconds should convert to centiseconds')
  equal(motionDurationSecondsToCentiseconds(0.126), 13, 'centisecond conversion should round to integers')
  equal(motionDurationSecondsToCentiseconds(-1), 0, 'centisecond conversion should clamp negative durations')

  const nextDriver = new FakeMotionDriver()
  controller.useDriver(nextDriver)
  equal(driver.detached, 1, 'replacing driver should detach the previous driver')
  equal(nextDriver.attached, 1, 'replacing driver should attach the next driver')

  await waitForCompletion((callback) => controller.setTorque(true, callback))
  equal(nextDriver.torqueStates[0], true, 'setTorque should delegate to the active driver')

  const pose: Pose = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { y: 0.2, p: -0.1, r: 0 },
  }
  await waitForCompletion((callback) => controller.setPose(pose, 0.25, callback))
  equal(nextDriver.appliedRotation?.y, 0.2, 'setPose should delegate yaw to the active driver')
  equal(nextDriver.appliedRotation?.p, -0.1, 'setPose should delegate pitch to the active driver')
  equal(nextDriver.appliedTime, 0.25, 'setPose should pass motion time to the active driver')

  const hardware = new M5StackChanServoDriver({ servoPower: { type: 'none' } })
  const guarded = new MotionController({ driver: hardware }, { isPaused: () => false })
  let motion: SpeakingMotion | undefined, readError: unknown
  const acquire = () =>
    guarded.trySpeakingMotion((value, error) => {
      motion = value
      readError = error
    })
  const readPose = () => {
    port.reply([1, 204])
    port.reply([2, 188])
  }
  acquire()
  equal(port.packets.length, 1, 'fresh pose begins with one axis read')
  readPose()
  assert(motion && !readError, 'compound calibrated pose read succeeds')
  let done = false
  motion.move({ y: 0.1, p: -0.7, r: 0 }, 0.5, () => {
    done = true
  })
  equal(port.packets.length, 3, 'gesture starts pan torque enable')
  port.reply()
  equal(port.packets.length, 4, 'tilt torque waits for pan acknowledgement')
  port.reply()
  equal(port.packets.length, 5, 'position starts only after both torque acknowledgements')
  const countBeforePreemption = port.packets.length
  guarded.setTorque(true)
  assert(!motion.valid(), 'ordinary torque immediately preempts gesture')
  port.reply()
  equal(port.packets.length, countBeforePreemption, 'late pan acknowledgement cannot transmit obsolete tilt')
  await wait(5)
  equal(port.packets.length, countBeforePreemption + 1, 'ordinary torque keeps its existing queue')
  port.reply()
  port.reply()
  assert(!done, 'old gesture does not complete into a later motion')
  let available = true
  guarded.trySpeakingMotion((value) => {
    available = !!value
  })
  assert(!available, 'ordinary held torque makes speaking ineligible')
  guarded.setTorque(false)
  guarded.trySpeakingMotion((value) => {
    available = !!value
  })
  assert(!available, 'ordinary torque release remains busy until acknowledged')
  port.reply()
  port.reply()

  acquire()
  readPose()
  motion.move({ y: 0.1, p: -0.7, r: 0 }, 0.5, () => {})
  const cancelAtEnable = port.packets.length
  motion.cancel()
  port.reply()
  equal(port.packets.length, cancelAtEnable + 1, 'cancelled pan enable permits only owned torque cleanup')
  equal(port.packets[port.packets.length - 1][5], 40, 'cleanup writes torque, not position')
  equal(port.packets[port.packets.length - 1][6], 0, 'cleanup releases torque')
  port.reply()
  port.reply()

  let live = true
  const beforeRead = port.packets.length
  guarded.trySpeakingMotion(
    (value) => {
      motion = value
    },
    () => live,
  )
  live = false
  port.reply([1, 204])
  equal(port.packets.length, beforeRead + 1, 'closing during pose read prevents the tilt read')
  assert(!motion, 'cancelled pose read returns no motion')

  acquire()
  readPose()
  port.failWrites = 1
  motion.move({ y: 0, p: -0.7, r: 0 }, 0.5, () => {})
  const beforeRetry = port.packets.length
  guarded.setTorque(false)
  await wait(5)
  // Only the ordinary release may be transmitted after the failed feedback write.
  equal(port.packets.length, beforeRetry + 1, 'preemption cancels the delayed feedback write retry')
  equal(port.packets[port.packets.length - 1][6], 0, 'the successor belongs to ordinary torque release')
  port.reply()
  port.reply()
  hardware.getRotation(() => {})
  const beforeBusy = port.packets.length
  guarded.trySpeakingMotion((value) => {
    available = !!value
  })
  assert(!available, 'busy physical dispatch skips feedback without queueing')
  equal(port.packets.length, beforeBusy, 'busy feedback adds no serial command')
  readPose()
  guarded.close()

  const freshDriver = new FakeMotionDriver()
  const freshController = new MotionController({ driver: freshDriver }, { isPaused: () => false })
  freshController.trySpeakingMotion((value) => {
    motion = value
  })
  assert(motion, 'idle controller can acquire speaking pose')
  freshController.setPose(pose, 0)
  assert(!motion.valid(), 'ordinary pose preempts speaking')
  freshDriver.rotation = { y: 0.3, p: -0.6, r: 0 }
  freshController.trySpeakingMotion((value) => {
    motion = value
  })
  equal(motion?.rotation.y, 0.3, 'later gesture reads the new actual pose')
  freshController.lookAt([1, 0, 0])
  assert(!motion.valid(), 'gaze preempts speaking')
  freshController.close()

  trace('@@STACKCHAN_TEST:PASS@@\n')
}

runTest().catch((error) => {
  trace('@@STACKCHAN_TEST:FAIL@@\n')
  trace(`motion controller test failed: ${error}\n`)
  throw error
})
