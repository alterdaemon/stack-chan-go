# GPT-Live Voice, Pitch and Style (R10)

Release impact: minor.

The shared Wi-Fi and Bluetooth Settings → OpenAI form adds exactly three controls:

- **Voice:** the 31 built-in GPT-Live voices; default `marin`.
- **Pitch:** −6 to +6 semitones in whole steps; default `0`.
- **Style:** Default, Calm or Expressive; default Default.

Saved changes apply on the next GPT-Live start and persist across restarts.
Firmware must advertise each preference before the form permits editing it.
Invalid writes are rejected by the form and both preference transports. Invalid
stored values fall back to the configured firmware defaults.

Voice is sent as `session.audio.output.voice`. Style appends delivery guidance to
the existing AI context; Default adds nothing. Existing interruption instructions
are retained. These instructions guide the model, rather than guaranteeing an
exact vocal performance. See [OpenAI session configuration](https://developers.openai.com/api/reference/resources/live/methods/create)
and [GPT-Live prompting](https://developers.openai.com/api/docs/guides/live-prompting).

Pitch is local output processing, not an OpenAI API parameter. Nonzero pitch uses
Espressif Sonic on mono PCM16 at 48 kHz, with speed fixed at 1.0 and pitch factor
`2 ** (semitones / 12)`. Zero allocates no Sonic instance and preserves the original
playback path. Processed audio passes through volume adjustment and becomes the
AEC reference. Missing input is padded with silence to drain the processor's tail
during gaps. Each session owns and releases its processor. DSP failures terminate
the call with `pitch_open` or `pitch_process` diagnostics.

Offline checks cover preference round trips and invalid writes, form controls,
session JSON versus native options, and the native stream adapter's partial input,
buffered output, pauses, cleanup and failure paths using a Sonic test double.

The R10 amendment addresses the reported UI lag with Voice interruption On.
Previously `aec_process` ran in the priority-20 I2S task. It now runs on core 0
at priority 3, below Moddable's priority-4 main/UI task. The I2S producer only
copies paired microphone and playback-reference frames into a bounded queue;
it never waits for AEC. The worker emits cleaned capture audio; shutdown waits
for processing to finish before freeing its buffers and AEC handle. Off creates
no AEC worker.
The queue holds at most three frames; overload rejects a new frame and increments
the existing overrun counter. The added task uses an 8 KiB stack and PSRAM PCM
storage. The host regression blocks AEC deliberately and verifies non-blocking
submission, bounded overflow, paired samples, frame order, session isolation,
allocation/task failures and cleanup under ASan/UBSan.

This removes AEC from the high-priority audio clock; the user's physical-device
menu responsiveness and interruption performance still require verification.
At the user's request, this amendment replaces both R10 images within R10.

The separate device signal test uses the real Sonic library without API access or
I2S. From `firmware/`, in the activated toolchain environment, build it with:

```sh
npm run build -- --mode=debug --manifest host/modules/realtime-conversation/__tests__/pitch-signal/manifest.device.json
```

It checks a 220 Hz signal at −6, 0 and +6 semitones, frequency ratios and input/output
duration, and reports the maximum DSP processing time. Building this test does not
execute it. Hardware signal results, audible quality, latency, CPU/RAM headroom
during an API conversation, and echo/interruption behavior require a CoreS3 test.
Check Pitch 0 and both extremes with voice interruption both Off and On, several
volumes, mute/unmute, network gaps, and repeated start/stop while monitoring heap.

R10 packaging produces matching full-flash and application-only BINs in
`gpt-live-package/`, retaining earlier revisions. Full installation resets data;
the application update preserves other partitions on the supported layout.

Validation performed on 2026-11-10:

- `npm run test:unit`: 580 tests passed; the final packaging suite passed 9 tests.
- Web React suite: 70 tests passed with one worker; device-settings production
  build and serving the shared options module in the development server passed.
- Firmware lint and formatting passed. Lint retains an existing informational
  diagnostic in the unchanged `connectivity/__tests__/fakes/crypt.ts` constructor.
- CoreS3 release build and device signal-test build passed.
- Both R10 BINs were verified against the release build. The full image is
  16,777,216 bytes; its bootloader, partition table and application match, and
  unused bytes are `0xFF`. The app BIN matches both generated application copies.
- The HTTP settings server and both integrated-startup XS manifests compiled;
  execution was blocked by the simulator’s unavailable D-Bus registration service
  when using the existing desktop-display wrapper. The hardware signal test,
  live API conversation and physical device tests were not executed.
