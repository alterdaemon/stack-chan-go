import {
  type Maybe,
  type Pose,
  type Rotation as RotationType,
  randomBetween,
  type Vector3,
  writeBodyRelativeVector3,
  writeRotationFromVector3,
} from 'stackchan-util'
import Timer from 'timer'

const INTERVAL_POSE = 1000 / 10
const GAZE_THRESHOLD = Math.PI / 6

export type MotionDurationSeconds = number
export type ServoGoalTimeMilliseconds = number
export type ServoGoalTimeCentiseconds = number
export type MotionCompletion = (error?: unknown) => void
export type MotionResultCallback<T> = (result: T) => void

export type MotionDriver = {
  applyRotation: (
    ori: RotationType,
    time?: MotionDurationSeconds,
    callback?: MotionCompletion,
    guard?: () => boolean,
  ) => void
  getRotation: (callback: MotionResultCallback<Maybe<RotationType>>, guard?: () => boolean) => void
  setTorque: (torque: boolean, callback?: MotionCompletion, guard?: () => boolean) => void
  feedbackReady?: () => boolean
  onAttached?: () => void
  onDetached?: () => void
}

export type SpeakingMotion = {
  rotation: RotationType
  valid: () => boolean
  move: (rotation: RotationType, time: number, callback: MotionCompletion) => boolean
  release: (callback: MotionCompletion) => void
  cancel: () => void
}

export type MotionControllerPose = {
  body: Pose
  eyes: {
    left: Pose
    right: Pose
  }
}

export type MotionControllerConstructorParam = {
  driver: MotionDriver
  pose?: MotionControllerPose
}

type MotionControllerOptions = {
  isPaused: () => boolean
}

export function motionDurationSecondsToMilliseconds(duration: MotionDurationSeconds): ServoGoalTimeMilliseconds {
  return Math.max(0, Math.round(duration * 1000))
}

export function motionDurationSecondsToCentiseconds(duration: MotionDurationSeconds): ServoGoalTimeCentiseconds {
  return Math.max(0, Math.round(duration * 100))
}

function createDefaultPose(): MotionControllerPose {
  return {
    body: {
      position: {
        x: 0.0,
        y: 0.0,
        z: 0.0,
      },
      rotation: {
        y: 0.0,
        p: 0.0,
        r: 0.0,
      },
    },
    eyes: {
      left: {
        position: {
          x: 0.03,
          y: 0.009,
          z: 0,
        },
        rotation: {
          r: 0.0,
          p: 0.0,
          y: 0.0,
        },
      },
      right: {
        position: {
          x: 0.03,
          y: -0.009,
          z: 0,
        },
        rotation: {
          r: 0.0,
          p: 0.0,
          y: 0.0,
        },
      },
    },
  }
}

export class MotionController {
  // The constructor always initializes this through useDriver, including attachment.
  #driver!: MotionDriver
  #gazePoint: Vector3 | null = null
  #isMoving = false
  #nextRotation: RotationType = { y: 0, p: 0, r: 0 }
  #options: MotionControllerOptions
  #pendingMotionTime = 0
  #pose: MotionControllerPose
  #relativeGazePoint: Vector3 = [0, 0, 0]
  #relativeGazeRotation: RotationType = { y: 0, p: 0, r: 0 }
  #releaseTorqueHandler: ReturnType<typeof Timer.set> | undefined
  #updatePoseHandler: ReturnType<typeof Timer.repeat> | undefined
  #updatePose = () => this.updatePose()
  #speaking: SpeakingMotion | undefined
  #ordinaryPending = 0
  #ordinaryTorque = false
  #ordinaryUntil = 0
  updating = false

  constructor(params: MotionControllerConstructorParam, options: MotionControllerOptions) {
    this.#options = options
    this.#pose = params.pose ?? createDefaultPose()
    this.useDriver(params.driver)
  }

  get driver(): MotionDriver {
    return this.#driver
  }

  get gazePoint(): Vector3 | null {
    return this.#gazePoint
  }

  get pose() {
    return this.#pose
  }

  close(): void {
    this.#speaking?.cancel()
    this.#stopPosePolling()
    this.#clearReleaseTorqueTimer()
  }

  useDriver(driver: MotionDriver) {
    this.#preemptSpeaking()
    if (this.#driver != null) {
      this.#driver.onDetached?.()
    }
    this.#driver = driver
    this.#driver.onAttached?.()
  }

  lookAt(position?: Vector3 | null) {
    this.#preemptSpeaking()
    if (position == null) {
      this.lookAway()
      return
    }
    this.#gazePoint = position
    this.#startPosePolling()
    this.updatePose()
  }

  lookAway() {
    this.#preemptSpeaking()
    this.#gazePoint = null
    this.#stopPosePollingIfIdle()
  }

  setPose(pose: Pose, time?: number, callback?: MotionCompletion): void {
    this.#preemptSpeaking()
    this.#ordinaryPending++
    let finished = false
    const done: MotionCompletion = (error) => {
      if (finished) return
      finished = true
      this.#ordinaryPending--
      if (!error) this.#ordinaryUntil = Date.now() + (time ?? 0.5) * 1000
      callback?.(error)
    }
    try {
      this.#driver.applyRotation(pose.rotation, time, done)
    } catch (error) {
      done(error)
    }
  }

  setTorque(torque: boolean, callback?: MotionCompletion): void {
    this.#preemptSpeaking()
    this.#ordinaryPending++
    let finished = false
    if (torque) this.#ordinaryTorque = true
    const done: MotionCompletion = (error) => {
      if (finished) return
      finished = true
      this.#ordinaryPending--
      if (!error && !torque) this.#ordinaryTorque = false
      callback?.(error)
    }
    try {
      this.#driver.setTorque(torque, done)
    } catch (error) {
      done(error)
    }
  }

  #preemptSpeaking(): void {
    // Losing this reference invalidates every nested axis/retry guard. The new
    // ordinary action owns torque; an old cleanup must not release it.
    this.#speaking = undefined
  }

  trySpeakingMotion(
    callback: (motion?: SpeakingMotion, error?: unknown) => void,
    isCurrent: () => boolean = () => true,
  ): void {
    const driver = this.#driver
    if (
      this.#speaking ||
      this.#ordinaryPending ||
      this.#ordinaryTorque ||
      this.#isMoving ||
      this.updating ||
      this.#gazePoint ||
      this.#options.isPaused() ||
      Date.now() < this.#ordinaryUntil ||
      !driver.feedbackReady?.()
    ) {
      callback()
      return
    }
    let cancelled = false,
      pending = false,
      owned = false,
      operation = 0
    const current = () => this.#speaking === motion
    const valid = () => current() && !cancelled && isCurrent()
    const release = (done: MotionCompletion) => {
      if (!current() || !owned) {
        done()
        return
      }
      pending = true
      try {
        driver.setTorque(
          false,
          (error) => {
            pending = false
            owned = false
            if (current()) {
              if (cancelled) this.#speaking = undefined
              done(error)
            }
          },
          current,
        )
      } catch (error) {
        pending = false
        owned = false
        if (current()) this.#speaking = undefined
        done(error)
      }
    }
    const settled = (generation: number, done: MotionCompletion, error?: unknown) => {
      pending = false
      if (cancelled) {
        release(() => {})
        return
      }
      if (!current() || generation !== operation) return
      done(error)
    }
    const motion: SpeakingMotion = {
      rotation: { y: 0, p: 0, r: 0 },
      valid,
      move: (rotation, time, done) => {
        if (!valid() || pending || !driver.feedbackReady?.()) return false
        pending = true
        const generation = ++operation
        const guard = () => valid() && generation === operation
        const apply = (error?: unknown) => {
          if (error || !guard()) {
            settled(generation, done, error)
            return
          }
          try {
            driver.applyRotation(rotation, time, (error) => settled(generation, done, error), guard)
          } catch (error) {
            settled(generation, done, error)
          }
        }
        if (owned) apply()
        else {
          owned = true
          try {
            driver.setTorque(true, apply, guard)
          } catch (error) {
            settled(generation, done, error)
          }
        }
        return true
      },
      release: (done) => {
        if (!valid() || pending) {
          done(new Error('speaking motion unavailable'))
          return
        }
        release(done)
      },
      cancel: () => {
        if (!current()) return
        cancelled = true
        operation++
        if (!pending) {
          if (owned) release(() => {})
          else this.#speaking = undefined
        }
      },
    }
    this.#speaking = motion
    pending = true
    try {
      driver.getRotation((result) => {
        pending = false
        if (!valid()) {
          if (current()) this.#speaking = undefined
          callback()
          return
        }
        if (result.success === false) {
          this.#speaking = undefined
          callback(undefined, new Error(result.reason))
          return
        }
        Object.assign(motion.rotation, result.value)
        callback(motion)
      }, valid)
    } catch (error) {
      if (current()) this.#speaking = undefined
      callback(undefined, error)
    }
  }

  updatePose(_id?: unknown): void {
    if (this.updating || this.#options.isPaused()) {
      return
    }
    this.updating = true
    try {
      this.#driver.getRotation(this.#handleRotation)
    } catch (error) {
      trace(`[MotionController] get rotation failed: ${String(error)}\n`)
      this.updating = false
    }
  }

  #handleRotation: MotionResultCallback<Maybe<RotationType>> = (result) => {
    let waitingForMotion = false
    try {
      if (result.success) {
        const bodyRotation = this.#pose.body.rotation
        bodyRotation.y = result.value.y
        bodyRotation.p = result.value.p
        bodyRotation.r = result.value.r
      }

      const gazePoint = this.#gazePoint
      if (!this.#isMoving && gazePoint != null) {
        writeBodyRelativeVector3(this.#relativeGazePoint, gazePoint, this.#pose.body.rotation)
        writeRotationFromVector3(this.#relativeGazeRotation, this.#relativeGazePoint)
        const y = this.#relativeGazeRotation.y
        const p = this.#relativeGazeRotation.p
        if (y > GAZE_THRESHOLD || y < -GAZE_THRESHOLD || p > GAZE_THRESHOLD || p < -GAZE_THRESHOLD) {
          this.#isMoving = true
          waitingForMotion = true
          this.#pendingMotionTime = randomBetween(0.5, 1.0)
          writeRotationFromVector3(this.#nextRotation, gazePoint)
          try {
            this.#driver.setTorque(true, this.#handleTorqueEnabled)
          } catch (error) {
            trace(`[MotionController] set torque failed: ${String(error)}\n`)
            this.#isMoving = false
            waitingForMotion = false
          }
        }
      }
    } finally {
      if (!waitingForMotion) {
        this.updating = false
        this.#stopPosePollingIfIdle()
      }
    }
  }

  #handleTorqueEnabled: MotionCompletion = (torqueError) => {
    if (torqueError) {
      trace(`[MotionController] set torque failed: ${String(torqueError)}\n`)
      this.#isMoving = false
      this.updating = false
      this.#stopPosePollingIfIdle()
      return
    }
    try {
      this.#driver.applyRotation(this.#nextRotation, this.#pendingMotionTime, this.#handleMotionApplied)
    } catch (error) {
      trace(`[MotionController] apply rotation failed: ${String(error)}\n`)
      this.#isMoving = false
      this.updating = false
      this.#stopPosePollingIfIdle()
    }
  }

  #handleMotionApplied: MotionCompletion = (moveError) => {
    if (moveError) {
      trace(`[MotionController] apply rotation failed: ${String(moveError)}\n`)
      this.#isMoving = false
      this.#stopPosePollingIfIdle()
    } else {
      try {
        this.#clearReleaseTorqueTimer()
        this.#releaseTorqueHandler = Timer.set(this.#releaseTorque, this.#pendingMotionTime * 1000 + 50)
      } catch (error) {
        trace(`[MotionController] release torque failed: ${String(error)}\n`)
        this.#isMoving = false
        this.#stopPosePollingIfIdle()
      }
    }
    this.updating = false
  }

  #releaseTorque = () => {
    this.#releaseTorqueHandler = undefined
    try {
      this.#driver.setTorque(false, this.#handleTorqueReleased)
    } catch (error) {
      trace(`[MotionController] release torque failed: ${String(error)}\n`)
      this.#isMoving = false
      this.#stopPosePollingIfIdle()
    }
  }

  #handleTorqueReleased: MotionCompletion = (releaseError) => {
    if (releaseError) {
      trace(`[MotionController] release torque failed: ${String(releaseError)}\n`)
    }
    this.#isMoving = false
    this.#stopPosePollingIfIdle()
  }

  #startPosePolling(): void {
    if (this.#updatePoseHandler) return
    this.#updatePoseHandler = Timer.repeat(this.#updatePose, INTERVAL_POSE)
  }

  #stopPosePolling(): void {
    if (!this.#updatePoseHandler) return
    Timer.clear(this.#updatePoseHandler)
    this.#updatePoseHandler = undefined
  }

  #stopPosePollingIfIdle(): void {
    if (this.#gazePoint != null || this.#isMoving) return
    this.#stopPosePolling()
  }

  #clearReleaseTorqueTimer(): void {
    if (!this.#releaseTorqueHandler) return
    Timer.clear(this.#releaseTorqueHandler)
    this.#releaseTorqueHandler = undefined
  }
}
