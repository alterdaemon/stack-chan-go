import Time from 'time'

export const samples = []
export function levels() {
  samples.push(Time.ticks)
  return {
    playbackLevel: samples.length % 2 ? 400 : 800,
    audibleMs: samples.length * 20,
    outputIdleMs: 10000,
    outputSuppressed: false,
  }
}
export function setLiveUI() {}
