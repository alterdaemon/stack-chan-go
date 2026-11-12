import Time from 'time'

export const samples = []
export function levels() {
  samples.push(Time.ticks)
  return { playbackLevel: samples.length % 2 ? 400 : 800 }
}
export function setLiveUI() {}
