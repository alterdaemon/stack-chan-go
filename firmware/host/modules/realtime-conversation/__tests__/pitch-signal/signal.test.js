import { assert } from 'testing/assert'

const probe = native('xs_live_pitch_probe')
try {
  for (const semitones of [-6, 0, 6]) {
    const result = probe(semitones)
    const expected = 220 * 2 ** (semitones / 12)
    assert(Math.abs(result.frequency / expected - 1) < 0.04, 'pitch changes signal frequency')
    // Three seconds of output must consume approximately three seconds of input,
    // allowing startup buffering, rather than changing playback duration.
    assert(Math.abs(result.inputSamples - 144000) < 12000, 'tempo is preserved')
    trace(`pitch=${semitones} ${JSON.stringify(result)}\n`)
  }
  trace('@@STACKCHAN_TEST:PASS@@\n')
} catch (error) {
  trace(`@@STACKCHAN_TEST:FAIL@@ ${error}\n`)
}
