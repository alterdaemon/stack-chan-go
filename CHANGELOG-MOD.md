# stackchan-community-mod changes

Fork of [stack-chan/stack-chan](https://github.com/stack-chan/stack-chan), starting
at [v2.0.1](https://github.com/stack-chan/stack-chan/tree/v2.0.1), commit
[`6a8f7553610e5d91770901e76fd93a0c50cfd970`](https://github.com/stack-chan/stack-chan/commit/6a8f7553610e5d91770901e76fd93a0c50cfd970).
The upstream history, credits and licenses are retained. The changes below belong
to this fork; upstream browser links still serve the upstream project.

Current series: **2.1.0-R<N>**, tagged `v2.1.0-R<N>`. The historical 2.0.1
series uses `v2.0.1-r<N>` tags.

## 2.1.0 series

| Version | Changes |
| --- | --- |
| **2.1.0-R1** | Merge upstream 2.1.0 with the complete R1–R15 fork and use Moddable 10.1.0. Preserve both conversation modes, saved Settings, 48 kHz audio, Pitch, SPI completion waits and R15 camera teardown. Include upstream display batching, WebRTC cleanup, TLS/HTTP fixes and Avatar DSL tooling. Fix effective SDK configuration and stale build profiles, pin realtime XS to core 0, increase its stack, correct the poll-watchdog ordering, prioritize Live control and schedule capture/HTTPS ahead of normal XS work. Skip AEC after local quiescence while media clocks continue through close. The paired display probe records 88.2% fewer SPI submissions, a 4.127-point reduction in XS/SPI runtime normalized to one core, and 510,980 B more free idle PSRAM. SPI bytes rise 9.8% and camera-stop median rises 1.568 ms. Four real-API cases of over 15 minutes passed with zero reported input FIFO overruns in 360 windows, alongside all-mode digital speech and search/UI checks. The validated app is installed, with saved volume 0, retained settings and normal boot verified. [Release and performance record](./docs/release-notes/v2.1.0-R1.md). |

## 2.0.1 revisions

| Version | Changes relative to the preceding revision |
| --- | --- |
| **2.0.1-r1** | Integrate the GPT-Live MOD into CoreS3 firmware and its drawer. Read AI token, context and saved volume at session start. Defaults: `gpt-live-1`, `gpt-6-luna`, `low`, `marin`, Polish brief-answer instructions, volume `0.1`, no tools. Add settings tests. |
| **2.0.1-r2** | Change backend to `gpt-6.1-terra`, reasoning to `medium`, default context to empty and volume to `1`. Add hosted `web_search` with automatic tool choice and pass tools through session configuration. Add build, packaging and artifact-audit scripts. |
| **2.0.1-r3** | Show startup error stage, code and HTTP status on the robot. Add an application-only update with partition/write-range checks to preserve settings. Model settings remain those of R2. |
| **2.0.1-r4** | Fix `TypeError: read only value (in stringify)` by copying ROM-backed configuration into RAM before serializing tools. Add operation/exception diagnostics and XS startup regressions for Terra/search and the Luna baseline. Keep Terra, `medium` and `web_search`. |
| **2.0.1-r5** | Make integrated GPT-Live the default CoreS3 build. Remove fixed machine paths from the build wrapper. Validate updates against a tracked flash layout; simplify output to BIN files and remove obsolete audit/package output. Add the bottom-left LIVE control, shared drawer toggling and touch/state tests. Document build/publication rules. |
| **2.0.1-r6** | Add OpenAI **Model** and **Thinking effort** to web Settings, between AI and MCP Server. Persist preferences and use saved values or firmware defaults on the next GPT-Live start. Add translations, preference and form tests. |
| **2.0.1-r7** | Automatically package matching full 16 MiB and app-only images after integrated release builds. Validate boot files and offsets; reject changed contents under a published revision. Put STARTED/STOPPED/ERROR/SET KEY notices inside LIVE, cancel stale notice timers, remove swipe toggling and give the button a 75% transparent background. |
| **2.0.1-r8** | Serve the shared Settings form and embedded assets over Wi-Fi at `/settings/` while device Settings is open. Add HTTP preference transport, WWW password/Basic Auth, limited initial password setup, URL/IP display and BLE compatibility. Fix generated HTTP header-buffer growth without modifying the installed SDK. Add build integration and server/form tests. |
| **2.0.1-r9** | Add experimental **Voice interruption**, default Off, for Wi-Fi/BLE Settings. On streams microphone audio during playback through full-duplex AEC; Off retains the microphone gate without allocating AEC. The corrected R9 removes local VAD-triggered playback muting and stop commands; GPT-Live decides when to yield. Add validation, capability checks and regressions. |
| **2.0.1-r10** | Add **Voice** (31 voices, default `marin`), **Pitch** (−6…+6 semitones, default `0`) and **Style** (Default/Calm/Expressive) to OpenAI Settings. Validate Wi-Fi/BLE writes and older-firmware capabilities. Apply saved settings on the next session; process pitch locally with Sonic and retain the processed AEC reference. Move full-duplex AEC to a background task below UI priority, keeping I2S submission non-blocking, with bounded buffering and worker regressions. Add DSP/session/form tests and a device signal test. Align product versions, locks, flash manifests, release validation and prerelease publication; restore per-revision English commits/tags and document fork provenance. |
| **2.0.1-r11** | Add STANDBY and bounded RAM conversation resume. The final user-requested amendment uses one timer renewed only by nonblank assistant output transcripts, paused while a delegated Responses request is pending. Ignore microphone noise, incoming speech, audio counters and usage heartbeats; remove local standby VAD. Add OpenAI **Auto disconnect (seconds)** to Wi-Fi/BLE Settings, default 60, range 1–3600, read on the next start. The same rule applies at every Pitch with interruption On/Off. Confirm remote close and release native resources before showing STANDBY. Retain up to 6 transcript fragments / 2048 characters; explicit STOP clears context. Preserve Voice/Pitch/Style. Restore R9's direct microphone/AEC/capture path and remove the later AEC worker and its drop-on-full queue. Keep I2S/Pitch at priority 20 on core 1 and process full-duplex AEC sequentially in the existing capture reader on core 0, sharing UI priority only during DSP. Reuse the input FIFO for paired microphone/reference frames with the same nominal 200 ms capacity; retain processed tails across encoder reads. Give On's capture task an 8 KiB SRAM stack. Off and UI retain their scheduling. Preserve AEC settings and continuous capture during playback. Add a concurrent native regression that holds AEC for 100 ms of virtual time while verifying uninterrupted I2S progress and every microphone sample. Review the failed priority-3 worker/core-move attempts and compile negative controls for queue loss and speaker/DSP coupling. Physical audio/UI/interruption verification remains required. Keep the user-confirmed standby and RAM history implementation unchanged. Capture-source framing stays on its pre-R11 core. Replace both R11 images by explicit request. |
| **2.0.1-r12** | Give full-duplex LIVE native 8/12 ms UI windows per 20 ms with a touch deadline, shared I2S priority and a runnable SPI dependency; leave Off scheduling unchanged. Drive the mouth from post-Pitch, post-volume speaker PCM independently of capture DSP. Keep media clocks running silently during graceful close. Preserve standby RAM context when remote finalization is unconfirmed, while retaining cleanup errors. Preserve the R11 checkpoint and both images. See the R12 validation record for device measurements and verification limits. |
| **2.0.1-r13** | Add GPT-Realtime 2.1 Mini alongside GPT-Live 1, with one mode selector, independent voice selections, server VAD and no Live standby timer in Mini mode. Share LIVE, credentials, instructions, volume and native audio. Bridge Realtime search calls directly to Responses with bounded cancellable HTTPS. Amend: frame the saved Mini persona as its dialogue task without changing preferences; verify the echoed system prompt before enabling Mini microphone input; reapply mismatched startup instructions and reject an incorrect acknowledgment. See the [R13 validation record](./docs/release-notes/v2.0.1-r13.md) for completed checks and remaining verification. |
| **2.0.1-r14** | Replace both realtime CoreS3 SPI busy waits with completion/capacity events. Evaluate and reject AEC-plane SRAM placement after measuring its small gain and reduced internal-memory margin. Preserve WebRTC, 48 kHz hardware audio, codec policies, UI budgets and saved settings. Add paired device measurements and native concurrency/payload regressions. See the [R14 report](./R14-PERFORMANCE-REPORT.md) for measured scope and dispositions of all twelve proposals. |
| **2.0.1-r15** | Stop CoreS3 camera capture after preview, release driver buffers, and reopen on demand. Cover preview rendering, repeated capture, held frame disposal, touch restoration and voice capture after camera use. See the [R15 validation record](./docs/release-notes/v2.0.1-r15.md). |

R14 diagnostic follow-up: measure all twelve proposals and record device,
provider, stability and data preservation results in the
[R14 report](./R14-PERFORMANCE-REPORT.md). The release images and tag are unchanged.

R12 follow-up, **4/8 ms UI windows and faster local STOP** (amended follow-up,
no revision bump by explicit user request): shorten elevated UI priority from
8/12 ms to 4/8 ms per 20 ms. Keep connected-session microphone/AEC processing,
priorities and affinities. Quiesce locally at close entry, reduce remote-close
grace from 15 to 3 s, and skip WebRTC startup if audio initialization was
cancelled. After successful local teardown, STOP returns idle with an unconfirmed
finalization diagnostic rather than ERROR; standby still retains RAM history.
Build only, without tests/device writes. No audio, interruption or start/stop
latency improvement is claimed verified. Stable reference `82eb5d45` /
`v2.0.1-r12` and both original `*-GPT-Live-stable.bin` /
`*-GPT-Live-stable-app.bin` contents are preserved.
The prior uninstalled 6/10 ms candidate is superseded. Standard R12 filenames
contain this amended variant. See the
[follow-up record](./docs/release-notes/v2.0.1-r12-ui-4-8ms.md).

R11 checkpoint (2026-11-10): firmware `923efc8f`, tag `v2.0.1-r11`, and both
existing BINs are retained unchanged. The user reports relatively working
behavior after a restart; UI/avatar performance remains unresolved. See the
[device feedback and validation record](./docs/release-notes/v2.0.1-r11.md).

Revision metadata was assigned retrospectively. R1–R2 sources were recovered from their
archived patches, R3 from its saved source snapshot, and R4–R9 from local Git.
R6 settings changes were separated from the combined R6/R7 commit. This history
does not claim that the original BINs were built with the newly assigned version names.
Earlier BINs retain their legacy filenames; new R10 files use the R10 product version.

## Compare

`main` tracks the official upstream. The mod branches record each supported
upstream base and the release tags identify the published revisions.

| Upstream base | Mod branch | GitHub comparison path within this fork |
| --- | --- | --- |
| `v2.0.1` | `v2.0.1-mod` | `/compare/v2.0.1...v2.0.1-mod` |
| `v2.1.0` | `v2.1.0-mod` | `/compare/v2.1.0...v2.1.0-mod` |
| `v2.1.0` | Release tag `v2.1.0-R1` | `/compare/v2.1.0...v2.1.0-R1` |

```sh
git diff --stat v2.0.1 v2.0.1-mod
git diff --stat v2.1.0 v2.1.0-mod
git diff v2.1.0 v2.1.0-mod
```

Detailed notes are in [docs/release-notes](./docs/release-notes/).

## Install

For **M5StackChan CoreS3**, from the repository root. Choose one command; replace
`/dev/ttyACM0` if needed.

**Full image — resets settings, MODs and storage:**

```sh
esptool --chip esp32s3 --no-stub -p /dev/ttyACM0 -b 115200 write_flash -z 0x0 gpt-live-package/StackChan-Community-v2.1.0-R1-GPT-Live.bin
```

**App only — preserves other partitions on this project's supported flash layout:**

```sh
esptool --chip esp32s3 --no-stub -p /dev/ttyACM0 -b 115200 write_flash -z 0x10000 gpt-live-package/StackChan-Community-v2.1.0-R1-GPT-Live-app.bin
```

Press **RST** briefly afterwards. Full images go at `0x0`; app-only images go at
`0x10000`. Use the full image when replacing firmware with a different layout.
Build commands and layout details: [GPT-LIVE.txt](./GPT-LIVE.txt).

The historical R12 4/8 ms follow-up was build-only at the user's request. No tests,
installation or audio-quality assessment were performed for this variant;
see the [follow-up record](./docs/release-notes/v2.0.1-r12-ui-4-8ms.md).

R13's builds, Mini API/interruption tests and application-only installation are
recorded in the [R13 validation record](./docs/release-notes/v2.0.1-r13.md).
