# stackchan-community-mod changes

Fork of [stack-chan/stack-chan](https://github.com/stack-chan/stack-chan), starting
at [v2.0.1](https://github.com/stack-chan/stack-chan/tree/v2.0.1), commit
[`6a8f7553610e5d91770901e76fd93a0c50cfd970`](https://github.com/stack-chan/stack-chan/commit/6a8f7553610e5d91770901e76fd93a0c50cfd970).
The upstream history, credits and licenses are retained. The changes below belong
to this fork; upstream browser links still serve the upstream project.

Current version: **2.0.1-r10**. R<N> corresponds to `2.0.1-r<N>` and Git tag
`v2.0.1-r<N>`. These are fork versions, not releases published by upstream.

## Revisions

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

Revision metadata was assigned retrospectively. R1–R2 sources were recovered from their
archived patches, R3 from its saved source snapshot, and R4–R9 from local Git.
R6 settings changes were separated from the combined R6/R7 commit. This history
does not claim that the original BINs were built with the newly assigned version names.
Earlier BINs retain their legacy filenames; new R10 files use the R10 product version.

## Compare

```sh
git log --oneline upstream/v2.0.1..main
git diff --stat upstream/v2.0.1..main
git diff v2.0.1-r9..v2.0.1-r10
```

Use any two revision tags to compare revisions. `upstream` points to the original
repository; `upstream/v2.0.1` and the original `v2.0.1` tag mark the fork base.
Detailed feature notes are in [docs/release-notes](./docs/release-notes/).

## Install

For **M5StackChan CoreS3**, from the repository root. Choose one command; replace
`/dev/ttyACM0` if needed.

**Full image — resets settings, MODs and storage:**

```sh
esptool --chip esp32s3 --no-stub -p /dev/ttyACM0 -b 115200 write_flash -z 0x0 gpt-live-package/StackChan-Community-v2.0.1-r10-GPT-Live.bin
```

**App only — preserves other partitions on this project's supported flash layout:**

```sh
esptool --chip esp32s3 --no-stub -p /dev/ttyACM0 -b 115200 write_flash -z 0x10000 gpt-live-package/StackChan-Community-v2.0.1-r10-GPT-Live-app.bin
```

Press **RST** briefly afterwards. Full images go at `0x0`; app-only images go at
`0x10000`. Use the full image when replacing firmware with a different layout.
Build commands and layout details: [GPT-LIVE.txt](./GPT-LIVE.txt).

Physical installation, live API calls and R10 acoustic performance have not been
tested here; see the [R10 validation record](./docs/release-notes/gpt-live-voice-r10.md).
