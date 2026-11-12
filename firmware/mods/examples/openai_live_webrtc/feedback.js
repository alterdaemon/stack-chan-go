const COLORS = [
  [0, 0, 0],
  [0, 19, 6],
  [0, 75, 25],
  [50, 15, 85],
  [0, 45, 95],
]

// One instance per connection; ticked by the existing mouth meter timer.
export class ConversationFeedback {
  constructor({ led, motion, entry, bargeIn, now = Date.now }) {
    Object.assign(this, { led, motion, entry, bargeIn, now })
    this.color = -1
    this.baseline = undefined
    this.rebase = true
    this.speakingUntil = 0
    this.speakingSince = undefined
    this.nextGesture = 0
    this.generation = 0
    this.phase = 0
    this.busy = false
    this.closed = false
  }

  interrupt() {
    this.rebase = true
    this.speakingUntil = 0
    this.speakingSince = undefined
    this.cancelMotion()
  }

  cancelMotion() {
    this.generation++
    const motion = this.speakingMotion
    this.speakingMotion = undefined
    this.busy = false
    this.phase = 0
    try {
      motion?.cancel()
    } catch {
      this.motion = undefined
    }
  }

  close() {
    this.closed = true
    this.entry.inputUntil = 0
    this.interrupt()
    this.setColor(0)
  }

  setColor(color) {
    if (this.color === color) return
    this.color = color
    try {
      if (color === 0) this.led?.off()
      else this.led?.on(...COLORS[color])
    } catch {
      this.led = undefined
    }
  }

  tick(levels) {
    if (this.closed) return
    const now = this.now(),
      entry = this.entry
    const input = !entry.conversation?.muted && (this.bargeIn || (levels.outputIdleMs ?? 10000) >= 500)
    entry.inputAvailable = input
    if (!input) entry.inputUntil = 0
    const audible = levels.audibleMs
    const fresh =
      !this.rebase &&
      !levels.outputSuppressed &&
      Number.isFinite(audible) &&
      this.baseline !== undefined &&
      audible !== this.baseline
    this.baseline = audible
    this.rebase = !!levels.outputSuppressed
    if (fresh) {
      if (this.speakingSince === undefined) this.speakingSince = now
      this.speakingUntil = now + 400
    }
    const speaking = now < this.speakingUntil
    if (!speaking) this.speakingSince = undefined
    const pending = !entry.pendingSuppressed && (entry.backend.size || entry.responseId || entry.searchId)
    this.setColor(speaking ? 4 : pending ? 3 : input ? (entry.inputUntil > now ? 2 : 1) : 0)
    try {
      this.tickMotion(now, speaking, fresh)
    } catch {
      this.failMotion()
    }
  }

  tickMotion(now, speaking, fresh) {
    if (this.speakingMotion && !this.speakingMotion.valid()) this.cancelMotion()
    if (!this.motion || this.busy) return
    if (this.phase && now >= this.deadline) {
      if (this.phase === 1) this.move(this.speakingMotion.rotation, now, 2)
      else {
        this.phase = 0
        const generation = this.generation
        this.busy = true
        this.speakingMotion.release((error) => {
          if (generation !== this.generation) return
          this.busy = false
          if (error) this.failMotion()
          else if (!speaking) this.cancelMotion()
        })
      }
      return
    }
    if (!speaking) {
      if (!this.phase) this.cancelMotion()
      return
    }
    if (this.phase || !fresh || now - this.speakingSince < 2000 || now < this.nextGesture) return
    this.nextGesture = now + 2000 + Math.random() * 1000
    if (this.speakingMotion) this.startGesture(now)
    else {
      this.busy = true
      const generation = this.generation
      this.motion.trySpeakingMotion?.(
        (motion, error) => {
          if (generation !== this.generation) {
            motion?.cancel()
            return
          }
          this.busy = false
          if (error) this.failMotion()
          else if (motion) {
            this.speakingMotion = motion
            // A delayed read must not start a gesture after speech ended.
            const time = this.now()
            if (time < this.speakingUntil) this.startGesture(time)
            else this.cancelMotion()
          }
        },
        () => generation === this.generation && !this.closed,
      )
      if (!this.motion.trySpeakingMotion) this.busy = false
    }
  }

  startGesture(now) {
    this.nextGesture = now + 2000 + Math.random() * 1000
    const rotation = { ...this.speakingMotion.rotation }
    if (Math.random() < 0.5) rotation.p += ((Math.random() < 0.5 ? -1 : 1) * Math.PI) / 60
    else rotation.y += ((Math.random() < 0.5 ? -1 : 1) * Math.PI) / 45
    this.move(rotation, now, 1)
  }

  move(rotation, now, phase) {
    const generation = this.generation
    this.busy = true
    const accepted = this.speakingMotion.move(rotation, 0.5, (error) => {
      if (generation !== this.generation) return
      this.busy = false
      if (error) this.failMotion()
      else {
        this.phase = phase
        this.deadline = Math.max(now, this.now()) + 500
      }
    })
    if (accepted === false) this.cancelMotion()
  }

  failMotion() {
    this.cancelMotion()
    this.motion = undefined
  }
}
