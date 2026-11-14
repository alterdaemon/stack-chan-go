# Stack-chan Community fork

[Repository](https://github.com/alterdaemon/stack-chan-go) ·
[Changelog](../../CHANGELOG-MOD.md)

Current product version: **2.1.0-R5**. Standard hardware: M5StackChan CoreS3.
The published stable release is **[2.1.0-R4](https://github.com/alterdaemon/stack-chan-go/releases/tag/v2.1.0-R4)**.

The goal is to provide simple, preconfigured firmware images for a quick start,
optimize performance, and keep the fork up to date and in sync with upstream.

## What this fork adds

Main differences in **2.1.0-R5** compared with upstream **2.1.0**:

| Area | What you get |
| --- | --- |
| Easy installation | Ready-to-use full-install and app-update BINs. App updates preserve settings, MODs and storage on the supported layout. |
| Firmware identity | GO and the full fork version appear on startup; the version also appears beside the address in the robot's startup Settings menu. |
| Voice chat and search | GPT-Live 1, Realtime Mini and GPT-Realtime 2.1, all with web search. Start or stop with LIVE or the drawer. |
| Conversation feedback | Dim/bright green shows ready input and incoming speech; purple shows pending work and cyan shows audible replies. Small head movements accompany longer replies on CoreS3 and can resume after a servo error. |
| Personal settings | Password-protected Wi-Fi Settings and Bluetooth. One AI connection selector, shared instructions and voice controls, with an experimental ChatGPT sign-in flow in R5. |
| Interruption and resume | Enable spoken interruption, with fixes for repeated or stuck replies. Resume Live after idle standby with recent context. |
| Everyday fixes | Fixes for screen/touch handling during chat, camera reopening and recoverable chat errors. |
| USB troubleshooting | Off by default. Enable logs and temporary audio adjustments when needed, without reinstalling firmware or changing saved settings. |

See the [R5 changes](../../CHANGELOG-MOD.md#210-r5) for the local candidate and the
[published R4 release notes](https://github.com/alterdaemon/stack-chan-go/releases/tag/v2.1.0-R4) for comparison links.

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
tests and licenses stay tracked. Validation records and performance reports
remain private outside Git.
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

For automated connection checks in that same capture process, `diag live start`
and `diag live stop` use the existing LIVE session and saved AI connection.
Wait for the `live` control record: `phase: applied` confirms connection or stop;
`phase: failed` reports a safe error code. Stop is accepted during startup.
Diagnostics Off, USB disconnect and lease expiry stop a session started through
USB. A session started with the touch control remains under the user's control.
These commands do not change saved settings or select another provider.

`diag live warmup` renews/caches the selected ChatGPT subscription grant without
opening media. It rejects API-key mode. This separates authorization time from
peer startup without transferring credentials to the host.

Two next-start transport trials are available while LIVE is stopped:

```text
diag set tcp 1
diag set dtls actpass
diag status
diag live start
diag live stop
diag reset
```

Change one variable per trial. TCP accepts 0/1; DTLS accepts `active`/`actpass`.
Defaults are TCP 0 and DTLS active. Wait for `set`/`applied` and check status
before starting. Active owners reject these changes. Reset, Off, lease loss and
reboot restore defaults for future starts; an active call keeps its startup
snapshot. These controls do not change certificates, saved settings or providers.
They expose existing [Espressif peer options](https://github.com/espressif/esp-webrtc-solution/blob/main/components/esp_peer/include/esp_peer_default.h)
and the SDP setup role defined by [RFC 5763](https://www.rfc-editor.org/rfc/rfc5763#section-5).

Enable capture before starting and use the running ELF hash to select matching
build provenance. Startup evidence is grouped by component:

| Component/events | Evidence |
| --- | --- |
| `auth` | Protected record availability/load/save, cached access, refresh phase and numeric HTTP status. No account labels or tokens. |
| `https` | Request IDs, worker creation/post/response/cancellation, actual idle acknowledgement and release. |
| `subscription` | Call status/header presence, offer/answer codec rates, candidate counts and DTLS role; control DNS/TCP/TLS/upgrade/readiness and backend terminal states. |
| `audio` | Native SDP acceptance result, fine-grained `peer.state`, coarse `peer.event`, audio stop and worker cleanup. |
| `device` / final audio snapshot | Free/minimum heap, largest internal block, PSRAM, queue occupancy and native worker stack minimum. |

`peer.state` uses the bundled Espressif peer enum; `peer.event` uses the distinct
WebRTC wrapper enum. The build corrects the SDK wrapper's ignored `peer_impl`
in generated output so the state observer runs; it does not edit the installed SDK.
Subscription calls negotiate audio alone and use their existing sideband for control.
API-key calls retain their data channel. Decode both enums against the matching build's SDK headers. For
`esp_peer` 1.5.5, peer states 3/4/5/6/7/8 mean gathering/pairing/paired/connecting/
connected/failed. A failure before pairing does not establish a DTLS failure.
During diagnostic ICE pairing, `ice.datagram` records at most 8 UDP observations
per transport: `request` is 1 for send or 0 for receive; `value` is the STUN binding
type (1 request, 257 success, 273 error), or 0 for a socket error. `result` is the
datagram byte count, a numeric STUN error when present, or negative socket errno.
Final counters `iceSent`, `iceReceived`, `iceRejected` and `iceErrors` include all
observations while pairing, beyond the record cap. These identify STUN-shaped
traffic; the SDK still validates integrity and nomination. Sends without replies
do not establish which network component failed. Generated SDK UDP observers
preserve return values and errno; they retain no datagrams or addresses.
`iceUdpSent`/`iceUdpReceived` count all successful UDP operations during pairing,
including unrecognized messages. Each of the first 20 observations also emits
`ice.checks`: `request` is direction, `result` is USERNAME length and `value` is a
bit mask: 1 PRIORITY, 2 USE-CANDIDATE, 4 ICE-CONTROLLING, 8 ICE-CONTROLLED,
16 MESSAGE-INTEGRITY present, 32 FINGERPRINT present, 64 FINGERPRINT CRC valid,
128 all-zero MESSAGE-INTEGRITY, 256 USERNAME present. These do not authenticate
the message. One `ice.crypto` value 1 confirms the actual SDK HMAC-SHA1 primitive
passes RFC 2202 case 1 using public synthetic data; value 0 means failure.
Candidate metadata includes only numeric port ranges, RFC 1918 and zero-address
counts; no addresses or additional credentials are retained.
`icePolls`/`iceReady`/`icePollErrors` count UDP select calls, readiness and errors.
`ice.poll` reports the first select and at most three failures: `value` is its
highest descriptor (negative means no valid descriptor), `result` is select's
result or negative errno. A negative descriptor has no socket errno guarantee.
`ice.tcp` is capped at 10 scalar observations: `request` 0/1/2 means socket
allocation/connect/completion (`value` is port); 3/4 means send/receive (`value`
is requested bytes); 5 means an asynchronous connect-select error; 6 means
receive select (`value` is highest descriptor, `result` readiness or negative errno). `result` is 0 for
connection success, an I/O byte count, or negative errno. EINPROGRESS at stage1
is pending, not failure. Counters `iceTcpStarted`/`iceTcpConnected`/`iceTcpErrors`,
`iceTcpSent`/`iceTcpReceived` and `iceTcpPolls`/`iceTcpReady` cover these operations
beyond the record cap. Polling stays visible without recording every poll.
`iceTcpReadPolls`/`iceTcpReadReady`/`iceTcpReadErrors` count TCP receive select
separately. `ice.binding` runs once at the actual SDK HMAC boundary: value bits
1/2/4/8/16/32 mean password matches the answer, USERNAME remote prefix matches
the answer, STUN header includes MESSAGE-INTEGRITY length, answer digests were
available, local suffix matches the offer, and local offer digest was available. `result` is the local USERNAME suffix length. Only boolean flags and
lengths leave the device; borrowed ICE credentials and RAM-only SHA-256 digests
are never logged or persisted. This startup crypto check is outside the
allocation-free socket observers.
For an audible request-parameter baseline, run `diag reset` then `diag live standard`; use the quiet workflow below at night.
This uses the saved subscription grant/current Codex model with Cove, pitch0,
volume0.1, empty instructions, no history and Interruption Off. Normal manual
starts keep saved settings. Use `diag set interruption on|off|saved` while stopped
for a future USB start; reset/Off clears it. `diag set voice <name>|saved` selects a bounded Codex V3 voice candidate for USB starts only, requires stopped LIVE, and clears on reset/Off/reboot. Test documented candidates before exposing subscription voices; preserve independent API voices. `call.session` reports only the
actual model, voice and instruction/history lengths. Structured rejections
preserve validated providerCode/param, never provider messages or raw bodies.
The SDK closes rejected WebSockets before reading error bodies; observation is
limited to4096 already-readable bytes before close, without an extra request or
wait. Incomplete bodies retain only the HTTP status.
While LIVE is stopped, `diag set stun 1` enables next-start public-address
collection for subscription mode using only the SDK STUN client and
`stun.cloudflare.com:3478` ([provider documentation](https://developers.cloudflare.com/realtime/turn/)).
It sends no account credential or media to that endpoint and introduces no TURN
relay or additional runtime. STUN0 is the default; API-key mode is unchanged.
Off/reset/reboot discard the trial. Gathering uses the same bounded UDP counters
and observations. The host capture reports maximum dropped/nativeDropped values
and fails if either is nonzero. Off/status retain the completed capture loss
count until the next enable or reboot, so Off cannot hide a late native loss.
SDP logs contain capability numbers only: no addresses, ICE passwords,
fingerprints, session descriptions or speech content. Dropped records or an
unexpected diagnostic Off invalidate a trial. Consult matching primary SDK and
provider sources before selecting a repair; upstream issue reports alone do not
establish the robot's cause.

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

Diagnostic parameter profiles `diag live voice`, `diag live prompt` and
`diag live pitch` restore saved voice, then prompt, then pitch cumulatively.
`diag live start` restores the full configured session. Standard/voice keep
instructions empty when comparing local Interruption Off and On.

The reusable USB qualification tool is `firmware/scripts/mod/qualify-live.py` (prefix `codebase/` from the workspace root). Run with `--port`, the validated ELF `--expected-sha`, a new private `--output` directory, and `--suite voices|parameters|backend|audio|matched|cycles|soak`. It uses one capture child, sequential acknowledgements, image/loss checks and final Off. Defaults are representative checks: Cove for voices, Terra/medium for backend, configured starts for parameters, with interruption Off/On. Use `--voices`, `--models`, `--efforts` or `--parameter pitch|style|volume|standby|prompt` only for a concrete question. A multiple-model/multiple-effort Cartesian product is rejected; failed baselines stop the run. Source-backed voice catalogs do not require another live sweep. Results separate startup and total trial time. Saved settings remain unchanged; connection/soak checks do not establish audible quality.

`--suite matched` performs one fixed English probe on API Live and subscription,
with interruption Off/On, volume0.1, pitch0 and the same short system prompt.
Use `--connection chatgpt --language polish` for the corresponding Polish check.
It waits for transcript evidence and rendered audio followed by native output
idle, within60seconds; transcript arrival alone is not an audio pass. Private
subscription probes also validate their fixed final transcript. Metrics report
transcript arrival and the existing5-second native snapshot, not microphone EOT
or calibrated acoustic latency. Use `--session-volume 0.1` for low-volume
configured cycle/soak trials. Explicit volume qualification can use other bounded
values; `--quiet` remains available for silent connection trials.

For an explicit matched API-Live baseline, stop LIVE, run `diag reset`, then
`diag set connection api-live`, `diag set volume 0.1`, `diag set pitch 0`,
`diag set prompt standard` and `diag set interruption off` (or `on`). Start with
`diag live start`; `diag set probe english` or `polish` requests a fixed speech
sample using the selected connection's event dialect. Use `connection chatgpt`
for the subscription comparison. Subscription-only voice/model/effort overrides
and standard profiles are rejected for an API trial. `connection saved`, reset,
Off, lease loss and reboot discard the override. Manual starts always reload the
saved connection; trials never change preferences or export credentials.
Startup history alone does not request speech. Transcript timing and native
output counters do not establish subjective acoustic quality.

While enabled, diagnostics retain an image-bound panic code address, core and
exception category and up to eight validated executable caller addresses in 84
bytes of RTC RAM, then use the normal SDK panic handler.
After a panic reboot, `diag status` reports a separate `debug/panic` record.
Symbolize `panicPC` and `panicCaller0`–`panicCaller7` against that record's exact matching ELF with
`xtensa-esp-elf-addr2line -pfiaC -e <matching-ELF> <hex-PC>`. No stack, register,
credential or flash dump is made. Off disarms capture; power loss clears RTC RAM.
Audio snapshots are split under the existing USB line and queue limits. HTTPS
byte counts distinguish raw TCP, decrypted TLS and consumed HTTP/SSE data.
`diag set probe minimal` tests terminal inference with only required request
fields and no configured reasoning/tool/history overrides. `diag live backend`
runs that fixed backend check while stopped, with no media/control socket, using
the same grant/worker and low-latency Wi-Fi lease. Its45-second bound and Stop/Off
cancellation apply without credential export or preference writes. TLS record
counts distinguish incomplete encrypted records from stalled HTTP/SSE parsing;
no record contents are logged. HTTP observations
retain only a validated status and bounded header/line-ending byte counts,
never header or body values. The first decoded boundary is retained once even
if a later native failure prevents the final worker observation; no sampling
timer is added.

`--quiet` uses the configured start profile with both RAM session volume0 and speaker trim0 acknowledged before startup. Session volume stays zero when Off/lease loss restores the trim. Quiet mode rejects audio/volume qualification; it does not establish acoustic quality or guarantee a silent reboot. Do not flash/reboot or keep trying after an unexpected reset during quiet hours. Batch compatible repairs before rebuilding and reuse passing evidence for unchanged paths.

On an active subscription call, `diag set probe reasoning|search` runs fixed diagnostic questions through the existing backend worker, requires enabled USB diagnostics and one idle job, and reports validation without exporting answers or credentials. `diag set probe english|polish` appends fixed speech-check context through the reference Codex dialect; queued acknowledgement is not proof of speech. The harness records matching output events separately. Reset/Off/disconnect cancels probes and discards their state. Use `--voices <names...>` and `--interruption off|on|both` for targeted voice retests.

USB backend parameter trials use `diag set model gpt-6.1-terra|gpt-6-luna|saved` and `diag set effort none|low|medium|high|xhigh|max|saved` while LIVE is stopped. They affect only subscription backend fields in RAM. `--suite backend` runs one Terra/medium reasoning-and-cited-search baseline with interruption Off/On; explicit filters select targeted alternatives. Do not run the complete model/effort matrix. Native failures, capture loss, account limits and failed baselines stop the run. Verify effective `backend.start` settings and terminal validated results; a sent request is not a pass.

HTTP captures emit bounded `https/job.progress` milestones for first request write,
response headers and first body bytes only while USB diagnostics are enabled.
A timeout retains its last observed phase/status; the first-body byte count is not
the complete response size. Any `progressDropped` invalidates qualification.
`tlsDrains` counts completion-driven buffered TLS read resumptions; that count
alone does not identify a server error or prove an empty record occurred.
Native abort capture retains only code PCs/core/backtrace addresses for private
symbolication against the matching validated ELF, excluding registers, stack words
and other console text.


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
unchanged. A failed servo operation cancels the current gesture; fresh speech can
start another after two to three seconds, using a newly read pose. Speaking
feedback allows 200 ms for servo acknowledgements; ordinary motion retains 120 ms.
Feedback reuses the existing 100/200 ms UI tick; LEDs are written only
when their displayed color changes.

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

Local R5 builds produce `StackChan-Community-v2.1.0-R5-app.bin` and
`StackChan-Community-v2.1.0-R5.bin` in `internal/release-packages/`.
R5 is a local candidate; the published preconfigured pair remains available from
the [R4 release](https://github.com/alterdaemon/stack-chan-go/releases/tag/v2.1.0-R4).

To package an existing release in the same environment:

```sh
python3 firmware/scripts/mod/package-release.py
```

For a new revision, advance package/lockfile versions, web flash manifests,
`config.firmwareVersion` in `firmware/host/app/manifest.json` and
`manifest_wasm.json`, the packager revision and filenames; add its numbered
changelog section. Both device version labels read this embedded configuration;
release validation rejects a missing or mismatched display version.
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
physical speech-onset latency.

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

At startup, the welcome screen shows `GO` with the full fork version immediately
below it in smaller text. The robot's startup Settings main menu also shows the
version at the bottom right, beside the Wi-Fi address on the left. The version
remains visible while disconnected; browser Settings is unchanged.

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


### ChatGPT subscription in R5

On the robot, open Settings and connect a phone or computer to
`http://<robot-IP>/settings/`. Configure the WWW password before account sign-in.
In **AI → AI connection**, choose **ChatGPT subscription**, then **Continue with
ChatGPT**. Open the displayed OpenAI sign-in link, enter the displayed code and
approve the account on OpenAI's page. Return to the robot's Settings page to see
the account status. Cancel a pending attempt or retry after expiry; reload the
page to recover the robot's current sign-in status. **Sign out** clears the
robot's grant and ends its active subscription call. If LIVE shows **SIGN IN**,
return to this Wi-Fi page to authorize again.

The same **System prompt** remains editable under AI. The same **OpenAI** section
contains a separate ChatGPT voice list, Pitch, Style, interruption and auto disconnect for subscription
operation. Cove is the subscription default; API Live/Realtime voice choices remain independent. Subscription has independent **Model** and **Thinking effort** fields for reasoning, WebSearch and tools, defaulting to `gpt-6.1-terra` and `medium`. API-only conversation mode and key controls are hidden while subscription is selected. Their saved values remain
available when returning to **OpenAI (API key)**. Save settings, leave Settings
and manually start LIVE. Switching the saved choice does not restart a call.
Neither connection automatically falls back to the other, including for search.

R5 can retain ChatGPT sign-in across restarts using a separate encrypted record
in existing NVS storage. It saves only the refresh credential and bound account
identity, sealed with AES-256-GCM using a device-bound key derived by the ESP32-S3
HMAC peripheral. Access and identity tokens remain in RAM. After reboot, the
robot renews independently before making a subscription request. No grant is
returned to the browser or embedded in an image; the browser only handles sign-in.

Secure storage requires an existing HMAC_UP eFuse key with read, write and purpose
protection. If none is available, Settings shows **Secure sign-in storage needs
setup** and refuses sign-in; it never writes plaintext subscription credentials.
The application does not provision keys, burn fuses, activate flash encryption,
change partitions or migrate existing API keys. Existing API-key preferences
remain unencrypted. Hardware provisioning requires a separate device-specific
decision; installing this application does not establish that the robot has a key.
This storage protects against reading or editing the credential blob in a flash
dump; it does not establish Secure Boot or protect against malicious firmware
running on the robot. See Espressif's [HMAC](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-reference/peripherals/hmac.html)
and [NVS security](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-reference/storage/nvs_flash.html#security-tampering-and-robustness) documentation.

Before renewal, the robot commits an invalidation record. An interrupted rotation
therefore restores either the complete replacement or a signed-out state requiring
authorization again. **Sign out** deletes the local grant; if storage fails,
Settings reports it and offers **Retry sign-out** rather than claiming deletion
succeeded. Ordinary session Stop retains sign-in. Cloud grant revocation is not
performed by local sign-out.

The subscription path uses the private Codex Live contract and a single
explicitly selected subscription Responses backend (default `gpt-6.1-terra`), with hosted web search. It requires
account access to those services. It does not make every API model available.
Answers are bounded and search is reported as verified only after completed tool
execution with HTTP(S) citation URLs. Service errors end or fail the selected
operation; they do not use a saved API key. Real account/device qualification,
including actual protected-key availability and power-loss tests, remains required.
