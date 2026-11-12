# Stack-chan Community fork

[Repository](https://github.com/alterdaemon/stack-chan-go) ·
[Changelog](../../CHANGELOG-MOD.md) · [Validation](validation.md)

Current product version: **2.1.0-R4**. Standard hardware: M5StackChan CoreS3.
The published stable release is **[2.1.0-R4](https://github.com/alterdaemon/stack-chan-go/releases/tag/v2.1.0-R4)**.

The goal is to provide simple, preconfigured firmware images for a quick start,
optimize performance, and keep the fork up to date and in sync with upstream.

## What this fork adds

Main differences in **2.1.0-R4** compared with upstream **2.1.0**:

| Area | What you get |
| --- | --- |
| Easy installation | Ready-to-use full-install and app-update BINs. App updates preserve settings, MODs and storage on the supported layout. |
| Voice chat and search | GPT-Live 1, Realtime Mini and GPT-Realtime 2.1, all with web search. Start or stop with LIVE or the drawer. |
| Conversation feedback | Dim/bright green shows ready input and incoming speech; purple shows pending work and cyan shows audible replies. Small head movements accompany longer replies on CoreS3. |
| Personal settings | Added password-protected Wi-Fi Settings alongside Bluetooth. Save instructions, models, thinking effort, separate Live/Realtime voices, pitch and speaking style. |
| Interruption and resume | Enable spoken interruption, with fixes for repeated or stuck replies. Resume Live after idle standby with recent context. |
| Everyday fixes | Fixes for screen/touch handling during chat, camera reopening and recoverable chat errors. |
| USB troubleshooting | Off by default. Enable logs and temporary audio adjustments when needed, without reinstalling firmware or changing saved settings. |

See the [R4 release notes](https://github.com/alterdaemon/stack-chan-go/releases/tag/v2.1.0-R4) for changes and comparison links.

Upstream is
[stack-chan/stack-chan](https://github.com/stack-chan/stack-chan).
`docs/release-notes/` describes upstream releases, not fork revisions.

## Branches and tags

- `main`: current fork work and the base for contributions.
- `v2.1.0-mod`: current series, kept at the same commit as `main` after changes.
- `v2.0.1-mod`: historical 2.0.1 R15 line.
- `origin`: this fork. `upstream`: the original repository, used for fetching.
  A separate local branch mirroring upstream is unnecessary.
- There is no fork `develop` branch. Keep only the latest release tag per series:
  currently `v2.0.1-r15` and `v2.1.0-R4`. Tags identify release builds;
  documentation commits do not move them. Archive a superseded tag privately.

Local remotes disable automatic tag fetching so historical tags do not reappear:

```sh
git fetch --no-tags upstream
```

Keep upstream history, licenses and credits. Use fixed upstream commit IDs in
[comparisons](../../CHANGELOG-MOD.md#compare). New fork documentation lives here;
standalone fork tools live in `firmware/scripts/mod/`. Shared firmware changes
remain in their existing modules with tests and driver provenance.

## Local artifacts

Keep ad hoc working artifacts and fork-specific packages/assets under the ignored
root `internal/`:

- `work/`: scratch scripts, logs, reports and screenshots.
- `diagnostics/`: generated R14 variants and input fixtures.
- `firmware/wifi-settings/`: generated embedded Settings assets.
- `release-packages/`: installable firmware images.
- `archives/`: local backups and superseded artifacts.

Names above are relative to `internal/`; create only the folders needed.
The directory is private and is never committed or uploaded as a whole.
Release publication selects only the two validated BINs. Standard upstream
build outputs and `node_modules` retain their existing paths. Source files,
tests and the sanitized evidence in this guide are not relocated.
Standard outputs include the three `firmware/dist*` folders and upstream Avatar DSL
`.test-output` files. Do not reconfigure standard build/test outputs to move them
under `internal/`. For temporary jobs, set `TMPDIR` to the absolute
`internal/tmp/` path after creating it; direct Python bytecode to
`internal/python-cache/` with `PYTHONPYCACHEPREFIX`.

## USB development diagnostics

Current firmware includes detailed device diagnostics, **Off after every boot**.
Enable them temporarily from a Linux/macOS host using Python 3 and the USB serial
port. Close other serial monitors first. From the implementation repository root:

```sh
python3 firmware/scripts/mod/capture-debug.py --port /dev/ttyACM0 --command status
python3 firmware/scripts/mod/capture-debug.py --port /dev/ttyACM0 --duration 180 --output internal/work/debug-session.jsonl
python3 firmware/scripts/mod/capture-debug.py --port /dev/ttyACM0 --command off
```

Choose a unique private output path with an existing parent directory. On macOS
select the appropriate `/dev/cu.*` port. The capture tool sends `diag on`, renews
the 30-second lease every 10 seconds and sends `diag off` on exit; reboot,
detected USB disconnect or lease expiry disables recording. `diag status` reports
state, running application ELF hash and record-loss counters. Connecting USB or
requesting status alone does not enable detailed logs. The tool does not flash
firmware or manipulate DTR/RTS/reset lines.

Records cover general application/network transitions, memory snapshots and
instrumented safe errors, plus Live/Realtime response, tool and playback
interruption events. They exclude credentials, prompts, transcripts, search
queries/results and raw audio. Logs remain in bounded RAM/USB output; the host
file retains the capture. Device timestamps and sequence/correlation IDs identify
events; host timestamps only identify receipt. Missing records make the affected
causal sequence inconclusive.

For temporary audio trials, add `--interactive --duration 1800` to capture and
enter commands in that same process. Keep one owner of the USB port. For example:

```text
diag set speaker 0
diag set speaker 1
diag set capture -12
diag set nlp 2
diag set vad 0.6
diag set silence 1000
diag set noise near_field
diag reset
diag status
```

Wait for a `set` control record with `phase: applied` before each trial. A
failure reports a safe error code. All values remain in RAM; reset, diagnostics
Off, disconnect, lease expiry and reboot restore defaults. Speaker is a 0-1
multiplier of normal volume, capture is a -27-0 dB trim, and NLP is 0/1/2
(normal/aggressive/very aggressive), applied on the capture owner. Realtime-only
controls are VAD 0.1-0.95, silence 200-2000 integer milliseconds and noise
`far_field`/`near_field`/`off`. They use acknowledged input-only session updates;
they do not create responses, inject instructions or change Interruption On.
Status reports available effective trial values. No per-trial installation is
needed after installing this support; earlier R3 images may lack it.
Capture aborts on unexpected Off or lost control acknowledgements. A sustained
500 ms USB disconnect disables trials; short monitor indications do not.
Rebooting discards trials: reconnect USB and reapply them after changing model.
Model selection itself is not currently a USB trial command.

To investigate repeated answers, keep Interruption On and the microphone on.
First say “Hello, are you there?” once and stay silent for ten seconds. Next set
speaker to zero and repeat once: silence from the speaker is expected, while the
trace counts responses and speech detections. Reset and repeat the normal-volume
control. Then compare one input/AEC parameter at a time. Once a candidate stops
false turns, restore audible output and verify an intentional spoken interruption,
a long question and both Realtime models. Report the observed outcome for each
trial; a passing silent-speaker control identifies playback dependence rather
than proving a particular AEC defect.

Detailed recording and sampling are inactive while Off; the USB command listener
still uses bounded resources. Enabled records are queued and USB writes are
nonblocking; overflow drops records with counters. Performance and physical
audio effects must be measured under the workload being investigated. The primary
UART console is retained; secondary USB console mirroring is disabled to avoid
competing FIFO writers. XS debug builds retain debugger ownership. Diagnostic control is unavailable while the
binary Android USB dock owns the port; do not send console commands into that
stream. Initial supported target: M5StackChan CoreS3.

## Conversation lights and head movement

On CoreS3, Live, Realtime standard and Realtime mini use all 12 head LEDs:

| Color | Meaning |
| --- | --- |
| Dim emerald | Microphone input is ready. |
| Brighter emerald | Incoming speech activity has been reported. |
| Purple | Confirmed response or search work is pending. |
| Cyan/blue | The robot is playing audible speech. |
| Off | The session is inactive, or microphone input is muted/gated while otherwise idle. |

Playback takes priority over pending work, and both take priority over green.
Realtime uses existing speech-start/stop events. Live brightens green for one
second after each new user audio transcript fragment; late or sparse captions can
make the indication delayed or intermittent. Neither green indication proves
understanding or identifies the speaker. Colors stay solid, with no pulsing.

During replies lasting at least two seconds, the robot can make small, smooth
nods or sideways movements, normally two to three seconds apart. Short replies,
listening and waiting do not force gestures. Normal completion returns to the
starting pose; accepted interruption cancels further steps. Existing touch,
manual and gaze actions take priority. Mouth, face and emotion behavior remains
unchanged. Feedback reuses the existing 100/200 ms UI tick; LEDs are written only
when their displayed color changes. Physical appearance and performance require
[device verification](validation.md#21-r4).

## Build

Use the existing Moddable/ESP-IDF environment, with `ESP_WEBRTC_SOLUTION` set,
`esptool` importable by `python3`, and `xtensa-esp-elf-nm` on `PATH`:

```sh
cd firmware
npm run build -- --mode=release
```

Alternatively, from the repository root:

```sh
STACKCHAN_TOOLCHAINS=/path/to/toolchains bash firmware/scripts/mod/build-firmware.sh --mode=release
```

The toolchain directory contains `moddable`, `esp-idf`, `idf-tools`,
`esp-webrtc-solution` and `fontbm`. Machine paths stay outside Git.
Use repository wrappers; outputs remain under `firmware/dist/`.
The integrated release automatically builds embedded Settings and packages both
BINs. Debug/instrument/alternate-manifest builds do not publish these packages.
Builds and packaging do not flash a device. Different contents under an existing
revision are rejected; identical repackaging is allowed.

Local R4 builds produce `StackChan-Community-v2.1.0-R4-app.bin` and
`StackChan-Community-v2.1.0-R4.bin` in `internal/release-packages/`. Download
the preconfigured pair from the [R4 release](https://github.com/alterdaemon/stack-chan-go/releases/tag/v2.1.0-R4).

To package an existing release in the same environment:

```sh
python3 firmware/scripts/mod/package-release.py
```

For a new revision, advance package/lockfile versions, web flash manifests,
the packager revision and filenames below; add its numbered changelog section.
Run `npm run check:release -- v<version>` from `firmware/`, relevant regressions,
the release build and image checks. Publish only the two validated BINs from
one build. Preserve existing images outside Git. Documentation/CI cleanup does
not advance the firmware version.

Tag CI only builds images and stores verification artifacts. It never creates
or publishes a release or prerelease. Pages deployments require manual workflow
dispatch; Cloudflare preview publication has no automatic trigger. Any public
publication requires an explicit user request. Pushing code or tags does not
authorize it.

The release-note tool extracts the exact version section from `CHANGELOG-MOD.md`.
The application descriptor keeps the independent Moddable/host API compatibility
version used by MOD loading.

## R2 audio and interruption behavior

R4 retains the R3 audio profile for all three conversation choices.

R2 promotes the selected R8 profile: 16 kHz I2S, Opus output and Pitch in both
voice modes with Interruption On or Off. On uses FD low-cost AEC with filter
length 2, temporary 6 dB analogue microphone gain with digital restoration, and
AEC bypass after 200 ms of exactly silent aligned reference. Off keeps its
microphone gate, without AEC or microphone-gain changes. On mouth updates use
200 ms; Off retains 100 ms. Wi-Fi/LwIP may allocate in PSRAM.

These audio-rate changes last for the chat session: close restores the normal
24 kHz amplifier baseline and subsequent non-chat Opus keeps its requested rate.
16 kHz reduces high-frequency playback bandwidth; FD2 covers a shorter echo
history than FD4. Web search and saved settings remain available. This promotion
adds no WebSocket or other experimental transport.

R2 invalidates queued local playback in both voice modes. Mini handles server
speech-start/output-clear events. Live uses timestamped caller fragments with
guards against delayed fragments cancelling a later reply. Renderer flush runs
on its native owner task; the audio task discards old PCM and resets Pitch.
Interrupted accepted searches return a cancelled result without resuming the old
answer. Mini uses the documented 0.5 server-VAD default.

R3 with Interruption On requests far-field input filtering for both Realtime
models before server VAD and verifies it before enabling microphone input.
Realtime also reduces post-AEC amplification by 8 dB during playback and the
existing 200 ms echo tail, restoring full listening gain afterward. USB capture
trim is additional to this production profile; reset restores that profile.
Its normal VAD threshold remains 0.5; USB diagnostics can temporarily test other
input parameters without saving them.
The published R2 images do not contain this fix.

R3 Live resumes on the first advancing assistant caption starting at or after
the caller's latest end, without requiring a 500 ms gap between assistant
fragments. It checks overlap when either speaker's captions advance and keeps
the protection against late caller fragments interrupting a later reply.
After flush completes, a Live-only fallback releases suppression after 1,500 ms
of consumed audible PCM; existing 500 ms quiet recovery remains. This is a
recovery policy, not a wall-clock stop-latency guarantee or acoustic tuning result.
Realtime keeps its explicit-resume/quiet recovery.

Playback uses the existing finite FIFOs and backpressure: On retains its 100 ms
PCM stream and 6,400-byte render FIFO. R3 removes the inactive vendor automatic
drop flag because its 200 ms threshold cannot be reached in that FIFO after
queue overhead. Accepted interruption still flushes obsolete queued audio.

With **Interruption Off**, microphone samples are gated during playback and until
the existing 500 ms received-silence gate clears: voice interruption is unavailable.
On keeps capture and AEC active. Explicit microphone mute remains separate.
Live caption delivery can lag speech; event-to-PCM-silence timing does not prove
physical speech-onset latency. On 2026-11-12, the maintainer confirmed physical
verification of the amended R2 is complete and it is working. This confirmation
is separate from unit-test results. Historical
combined-profile measurements and their limits are in [validation](validation.md#r2-selected-r8-profile-promotion).

The published R4 release pair is `StackChan-Community-v2.1.0-R4-app.bin` and
`StackChan-Community-v2.1.0-R4.bin`. Preserve supported-layout settings by writing
only the application:

```sh
esptool --chip esp32s3 --no-stub -p /dev/ttyACM0 -b 115200 write_flash -z 0x10000 StackChan-Community-v2.1.0-R4-app.bin
```

Full installation resets settings, MODs and storage:

```sh
esptool --chip esp32s3 --no-stub -p /dev/ttyACM0 -b 115200 write_flash -z 0x0 StackChan-Community-v2.1.0-R4.bin
```

Use your device port: Linux `/dev/ttyACM0` or `/dev/ttyUSB0`, Windows `COM3`, macOS
`/dev/cu.*`. See [esptool setup](https://docs.espressif.com/projects/esptool/en/latest/esp32s3/installation.html).
Do not write the full image at `0x10000`. Download the BINs from the [R4 release](https://github.com/alterdaemon/stack-chan-go/releases/tag/v2.1.0-R4).

## Historical R1 installation

Current files are in the ignored `internal/release-packages/` directory.
Run from the repository root and replace `/dev/ttyACM0` with the device port.
The corrected R1 build passed offline/build checks, and the maintainer confirmed
it is tested and working on hardware with the live API. See [validation](validation.md#21-r1).

Application update, preserving other partitions on the supported layout:

```sh
esptool --chip esp32s3 --no-stub -p /dev/ttyACM0 -b 115200 write_flash -z 0x10000 internal/release-packages/StackChan-Community-v2.1.0-R1-app.bin
```

Full installation **resets settings, MODs and storage**:

```sh
esptool --chip esp32s3 --no-stub -p /dev/ttyACM0 -b 115200 write_flash -z 0x0 internal/release-packages/StackChan-Community-v2.1.0-R1.bin
```

The destination address is in device flash, not an input-file offset. Never
write the full image at `0x10000`. The packager checks the
[supported layout](../../firmware/host/app/gpt-live-layout.json) against the
build's `flasher_args.json`. Before device tests/updates, verify the live layout
and app bounds and privately back up non-application partitions. Tests use
app-only writes; destructive installation requires explicit authorization.

Keep both BINs for direct installation. The full image already contains the
application, but [esptool writes each entire input BIN at its destination address](https://docs.espressif.com/projects/esptool/en/latest/esp32s3/esptool/basic-commands.html#write-binary-data-to-flash-write-flash).
Its CLI does not select an application range inside that input file. A single
download would require extracting and validating the app first; changing only
the flash address cannot do that. The full image contains erased data partitions,
so flashing it at `0x0` resets them. Do not use differential-flashing options to
preserve user data: they may fall back to rewriting the entire input image.

## Settings

Open the robot's Settings mode to use BLE or `http://<robot-IP>/settings/`.
The HTTP listener runs only while Settings is open. Initial WWW password
setup lasts five minutes; BLE can also set/replace the password. HTTP Basic Auth
does not encrypt LAN traffic. Passwords are not returned or logged; an empty
password field preserves the saved value.

OpenAI settings apply on the next LIVE start. Conversation mode offers
GPT-Live 1 (`gpt-live-1`), GPT-Realtime 2.1 Mini (`gpt-realtime-2.1-mini`) and
GPT-Realtime 2.1 (`gpt-realtime-2.1`). All three share credentials, context,
volume, local Pitch/Style and interruption controls. Live has its own saved voice;
the two Realtime models share the saved Realtime voice. Existing saved Live/Mini
choices retain their meaning. Auto disconnect applies only to GPT-Live. Both
Realtime models stay connected during silence and use the backend model/effort
for their `search_web` Responses call. Adding the full model does not establish
better persona adherence.
Repository cleanup does not rewrite saved preferences.
