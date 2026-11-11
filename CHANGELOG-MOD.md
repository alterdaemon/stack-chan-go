# Stack-chan Community changelog

Changes made by [alterdaemon/stack-chan-mod](https://github.com/alterdaemon/stack-chan-mod).
Upstream release notes remain in [docs/release-notes](docs/release-notes/).
The fork started at upstream `v2.0.1`, commit
`6a8f7553610e5d91770901e76fd93a0c50cfd970`. Upstream history and licenses are retained.

[Build/install/branch guide](docs/mod/README.md) · [Detailed validation](docs/mod/validation.md)

This is the only source of fork release notes. Publication extracts the section
headed `### <product-version>` for the requested tag.

## Unreleased

Release impact: none. Consolidate documentation and release notes, isolate fork
tools, configure `main` instead of `develop`, and archive obsolete local worktrees.
Firmware behavior, product versions, release images and release tags are unchanged.
Store fork-only packages, diagnostics, embedded Settings output, scratch work
and private archives under ignored `internal/`. Preserve upstream source and
standard build/dependency layouts.
Clarify agent artifact rules: keep existing build/test output paths, place ad hoc
working files under `internal/`, and retain reusable tests and validation evidence.
Name release BINs `StackChan-Community-v<version>.bin` and
`StackChan-Community-v<version>-app.bin` under `internal/release-packages/`.
Keep full-install and app-update images; preserve their bytes when renaming.

## 2.1.0

### 2.1.0-R1

Release impact: minor.

Merge upstream 2.1.0 and Moddable 10.1.0 with the complete R1–R15 fork. Retain both conversation modes, Wi-Fi/BLE Settings, Pitch, 48 kHz audio, SPI waits and camera release/reopen; include upstream display batching, TLS/HTTP fixes, WebRTC cleanup and Avatar DSL tools. Correct generated SDK configuration, stale build profiles, XS stack/affinity, poll-watchdog ordering, Live control priority and capture/HTTPS scheduling. Skip AEC after local quiescence during close. Amend R1: treat `conversation_already_has_active_response` as recoverable in both modes and interruption settings; bound Mini continuation retries and never replay tool output.

Validation and limits: The correction passed 684 Node/native tests, nine packaging tests, lint, format, release validation and release/image checks. Initial R1 completed four API cases exceeding 15 minutes each, zero input FIFO overruns in 360 windows, and normal-device/data checks. These device/API results do not validate the corrected build: it is not installed or live-API tested. Acoustic quality and physical interruption/touch latency remain unverified.

## 2.0.1

R1–R9 metadata was reconstructed from archived patches, snapshots and local Git.
Original binaries were not rebuilt or renamed to match retrospective versions.
Per-revision execution results are not recorded in the recovered release notes;
coverage described below does not imply a runtime pass.

### 2.0.1-r15

Release impact: patch.

Stop CoreS3 camera tasks after capture, release driver buffers, retain copied preview/standalone frames and reopen on demand. Resume touch after outstanding captures finish.

Validation and limits: 618 unit tests, nine packaging tests, 11 RFID tests, three provider tests, lint/format, six-target manifest and release/image checks passed. Device checks covered eight reopen cycles, overlapping captures, short post-camera API progress and matching protected data after app-only installation. Acoustic quality, physical touch latency and sustained stability were not established.

### 2.0.1-r14

Release impact: patch.

Replace realtime CoreS3 SPI busy waits with completion/capacity events. Retain PSRAM AEC planes after evaluating SRAM, WebRTC, 48 kHz audio and existing UI windows. Record decisions and measured limits for all twelve performance proposals.

Validation and limits: 617 Node/native tests, nine packaging tests and 11 RFID tests passed after AEC reversion, along with native SPI/render, architecture/manifest, web and release/image checks. Fifteen paired display runs measured 4.388% median main+SPI CPU-service reduction, positive in 13 pairs. Follow-up Live capture and hour-long stability gates failed; no whole-device or acoustic improvement is established.

### 2.0.1-r13

Release impact: minor.

Add GPT-Realtime 2.1 Mini alongside GPT-Live 1, independent saved voices, server VAD and bounded cancellable Responses search. Mini does not use Live standby. Preserve saved settings, Pitch and interruption On/Off. Amend Mini startup to verify echoed instructions before opening the microphone and frame the saved persona as a dialogue task without changing its text.

Validation and limits: 612 Node tests, nine packaging tests, 73 React tests, type/build, lint/format and release checks passed. Final Mini On/Off/search/cancel checks reported zero input overruns. The prompt amendment passed Off-only device/API probes; images were validated and normal firmware restored. Output-underrun/UI-gap counters and unconfirmed hangups remain recorded. Constant persona intensity, acoustic quality and long stability were not established.

### 2.0.1-r12

Release impact: patch.

Add full-duplex UI windows, post-Pitch/post-volume mouth metering and retained standby history after local cleanup without remote acknowledgment. Amend to 4/8 ms windows and a three-second close grace period, quiesce locally at STOP and cancel startup before WebRTC when audio setup is stopped. Preserve original stable source `82eb5d45` and its stable images.

Validation and limits: Original R12 passed 597 unit tests, nine packaging tests, lint/format, release/build/image checks and app-only installation. Device tests advanced digital speech and standby/resume, but NVS changed with unknown records/cause. The 4/8 ms amendment received build/image validation only: no runtime test or installation. Earlier 8/12 ms measurements do not validate the amendment.

### 2.0.1-r11

Release impact: minor.

Add STANDBY, bounded RAM history and saved Auto disconnect seconds. Only nonblank assistant output transcripts renew the timer; pending delegated Responses work pauses it. Explicit STOP clears history. Replace the earlier AEC worker with processing in the existing capture reader, preserving paired microphone/reference data and keeping I2S independent of delayed DSP.

Validation and limits: 594 unit tests, nine packaging tests, native delayed-AEC/negative controls, lint/format and release/build/image checks passed. The user confirmed standby/history and later reported a relatively working state after restart. Physical UI/avatar behavior and acoustic margins remained unresolved; the installed image was not byte-verified at the checkpoint.

### 2.0.1-r10

Release impact: minor.

Add **Voice** (31 voices, default `marin`), **Pitch** (−6…+6 semitones, default `0`) and **Style** (Default/Calm/Expressive) to OpenAI Settings. Validate Wi-Fi/BLE writes and older-firmware capabilities. Apply saved settings on the next session; process pitch locally with Sonic and retain the processed AEC reference. Move full-duplex AEC to a background task below UI priority, keeping I2S submission non-blocking, with bounded buffering and worker regressions. Add DSP/session/form tests and a device signal test. Align product versions, locks, flash manifests, release validation and prerelease publication; restore per-revision English commits/tags and document fork provenance.

Validation and limits: 580 unit tests, nine packaging tests, 70 React tests, embedded Settings build, lint/format, CoreS3 release and signal-test builds passed. Both images matched the build. The signal test was not executed; initial XS runtime startup was blocked by unavailable D-Bus. No device/live-API pass was recorded.

### 2.0.1-r9

Release impact: minor.

Add experimental **Voice interruption**, default Off, for Wi-Fi/BLE Settings. On streams microphone audio during playback through full-duplex AEC; Off retains the microphone gate without allocating AEC. The corrected R9 removes local VAD-triggered playback muting and stop commands; GPT-Live decides when to yield. Add validation, capability checks and regressions.

### 2.0.1-r8

Release impact: minor.

Serve the shared Settings form and embedded assets over Wi-Fi at `/settings/` while device Settings is open. Add HTTP preference transport, WWW password/Basic Auth, limited initial password setup, URL/IP display and BLE compatibility. Fix generated HTTP header-buffer growth without modifying the installed SDK. Add build integration and server/form tests.

### 2.0.1-r7

Release impact: patch.

Automatically package matching full 16 MiB and app-only images after integrated release builds. Validate boot files and offsets; reject changed contents under a published revision. Put STARTED/STOPPED/ERROR/SET KEY notices inside LIVE, cancel stale notice timers, remove swipe toggling and give the button a 75% transparent background.

### 2.0.1-r6

Release impact: minor.

Add OpenAI **Model** and **Thinking effort** to web Settings, between AI and MCP Server. Persist preferences and use saved values or firmware defaults on the next GPT-Live start. Add translations, preference and form tests.

### 2.0.1-r5

Release impact: patch.

Make integrated GPT-Live the default CoreS3 build. Remove fixed machine paths from the build wrapper. Validate updates against a tracked flash layout; simplify output to BIN files and remove obsolete audit/package output. Add the bottom-left LIVE control, shared drawer toggling and touch/state tests. Document build/publication rules.

### 2.0.1-r4

Release impact: patch.

Fix `TypeError: read only value (in stringify)` by copying ROM-backed configuration into RAM before serializing tools. Add operation/exception diagnostics and XS startup regressions for Terra/search and the Luna baseline. Keep Terra, `medium` and `web_search`.

### 2.0.1-r3

Release impact: patch.

Show startup error stage, code and HTTP status on the robot. Add an application-only update with partition/write-range checks to preserve settings. Model settings remain those of R2.

### 2.0.1-r2

Release impact: minor.

Change backend to `gpt-6.1-terra`, reasoning to `medium`, default context to empty and volume to `1`. Add hosted `web_search` with automatic tool choice and pass tools through session configuration. Add build, packaging and artifact-audit scripts.

### 2.0.1-r1

Release impact: minor.

Integrate the GPT-Live MOD into CoreS3 firmware and its drawer. Read AI token, context and saved volume at session start. Defaults: `gpt-live-1`, `gpt-6-luna`, `low`, `marin`, Polish brief-answer instructions, volume `0.1`, no tools. Add settings tests.

## Compare

`main` contains current fork work. `v2.1.0-mod` follows the current series;
`v2.0.1-mod` preserves the historical R15 line. Only the latest release tag per
series is kept locally: `v2.0.1-r15` and `v2.1.0-R1`. Earlier tag references are
archived privately; their commits remain in history. Documentation commits do
not move release tags.

| Upstream base | Fork branch | Comparison |
| --- | --- | --- |
| `6a8f7553610e5d91770901e76fd93a0c50cfd970` (2.0.1) | `v2.0.1-mod` | `git diff 6a8f7553 v2.0.1-mod` |
| `b050a44592ab847f0f4c2ceb6eb350a02bcb609a` (2.1.0) | `v2.1.0-mod` | `git diff b050a445 v2.1.0-mod` |

Fixed commit IDs work without restoring upstream tags. Driver provenance and
license files remain beside the affected implementations.
