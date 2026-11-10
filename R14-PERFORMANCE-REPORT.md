# R14 performance report

Status: selected R14 work complete; manual verification limits remain below. Release impact: patch.

Toolchain identities are recorded in [r14-toolchain.json](docs/performance/r14-toolchain.json).
The archive does not provide Git metadata; its commit identity is unknown.

## Scope and retained change

Baseline: clean `f88992b1`; the installed app matched the preserved R13 image
SHA-256 `6b913df30fb3ee5a3cbab92703742e35b9547bdee7531c64445890bb9023488d`.
The retained production change is P01: completion/capacity waits in realtime
CoreS3 SPI. Both wait predicates are checked under the SPI mutex. Persistent
level bits cover completion before waiter registration and broadcast to waiters;
a wakeup never substitutes for a predicate recheck. DMA, SPI conversions, existing
priorities, UI budgets, WebRTC and audio source remain in use.

The SDK source is owned by this repository, selected through the realtime
manifest, with upstream LGPL notice and identity in
[`spi/UPSTREAM.md`](firmware/host/platforms/m5stackchan_cores3/spi/UPSTREAM.md).
No shared toolchain source is modified. Non-realtime targets retain the SDK SPI.

## Measurements and their limits

The diagnostic manifest enables ESP-timer FreeRTOS CPU runtime counters. Normal
production does not enable them. Wall duration, per-task CPU service and audio
continuity are separate results. Paired SPI variants share one instrumented image,
UI budget and mouth/drawer sequence. The baseline branch retains original yields
and bypasses event-group updates, so notification overhead is charged to the
candidate. The one-time diagnostic allocation and profiling remain common.

A first five-pair series had appreciable spread. One bounded fifteen-pair series
was selected before its results, with no subsequent benchmark loop. The
fifteen-pair confirmation measured a **4.388% median paired reduction** in
combined `main` + `spiLoop` CPU service, positive in **13/15 pairs**. The paired
range was **−3.722% to +11.818%**; there is no claim of a gain in every run.
Median saved CPU service was **11,927 microseconds per wall second**. Median
combined service was 27.286% versus 26.108% of a one-core equivalent; these are
task sums, not measured whole-chip utilization. The median of individual frame
maxima was 24.179 versus 24.129 ms, worst 25.004 versus 24.839 ms. See
[all paired results](docs/performance/r14-confirmation.json).
The corrected Mini On comparison passes for both original and blocking waits;
[device evidence](docs/performance/r14-mini-barge.json) records speech-start and
output-clear events after injection during confirmed audible playback. The UI-only SPI
experiment does not establish a whole-device/audio speedup, power reduction or
acoustic improvement. Normal-image CPU service is not measured.

The AEC experiment uses fresh identical filter state, aligned planes, deterministic
input and five pairs in alternating order. Every output checksum matched. CPU
cost was about 1.2% lower with the sample planes in SRAM, while an integrated
candidate reported 7,796 bytes minimum internal free memory. The later PSRAM run
also reported that global minimum, so it does not establish that SRAM placement
caused the minimum. The allocation consumes 3,072 payload bytes of internal memory and removes
the same payload from PSRAM. That capacity cost is calculated; the sessions are
not a matched peak-memory comparison. The 3,072-byte
placement change is reverted; an actual out-of-memory failure is not claimed.
See [candidate measurements](docs/performance/r14-aec-candidate.json).

## Decisions for all twelve proposals

| ID | Decision | Evidence and reason |
| --- | --- | --- |
| P01 | Retained | 4.388% median paired reduction in main+SPI CPU service, 13/15 positive pairs; native payload continuity and corrected Mini On comparison pass. |
| P02 | Deferred; no rate change | A coordinated 24 kHz hardware/pitch/resampling/reference change needs acoustic acceptance. Halved PCM traffic is not a measured system speedup. Preserve 48 kHz. |
| P03 | Probed and reverted | Small isolated CPU reduction, identical DSP output, reduced internal-memory margin. Retain PSRAM pending stronger concurrent-memory evidence. |
| P04 | Stride-four variant rejected | At 2 kHz the sampled meter reads zero against full mean magnitude 9,888. Speech errors also occur. Keep exact full-rate levels; other meter changes deferred. |
| P05 | Deferred; no slower animation | Already quantized, unchanged-value suppression; slowing the 100 ms timer is a visible tradeoff without established whole-device benefit. |
| P06 | Existing mechanism retained | Jitome already uses changed geometry/dirty regions; headless test verifies 16 partial/full framebuffer pairs and unchanged-frame skipping. No measured extra redraw correction. |
| P07 | Deferred | No measured material queue/lock overhead justifies additional batching. Preserve packet boundaries and cancellation. |
| P08 | Deferred | Underrun counters alone do not distinguish intentional silence, network delivery and starvation. No unmeasured start threshold is introduced. |
| P09 | Deferred | No measured hardware service-gap/loss evidence justifies more SRAM and buffering latency. FIFO-overrun absence is not proof of zero hardware loss. |
| P10 | Existing reuse retained | Native PCM buffers, pitch state and SDK decoder storage already reuse allocations. FIFO copies preserve independent I2S/AEC ownership; no extra copy is removed without evidence. |
| P11 | No activity suspended | No verified unused workload warrants disabling services. Post-camera activity remains unmeasured; preserve camera/tool lifecycle and settings. |
| P12 | Existing GPT-Live offload retained; Mini change deferred | GPT-Live already delegates hosted search; Mini's bounded cancellable HTTP worker is unchanged. No new remote service or duplicate search request. |

The implementation/source references and per-proposal TODOs are in
[R14-PERFORMANCE-PLAN.md](R14-PERFORMANCE-PLAN.md). The numeric meter analysis is
[recorded separately](docs/performance/r14-meter-analysis.json).

## Validation record

- Baseline `npm test`: 616 Node/native tests, 9 packager tests, 11 RFID tests passed.
- Candidate `npm test`: 617 Node/native tests, 9 packager tests, 11 RFID tests passed.
  The full 617/9/11 suite was rerun after the AEC reversion and passed.
- Native ASan/UBSan SPI test: completion before registration, two waiters, fifty
  delayed cycles, capacity versus idle, producer blocking, actual SPI loop refill
  and byte-for-byte payload continuity. Existing delayed-AEC test also passes.
- `npm run check:legacy-names`, `check:architecture`, `check:manifest`,
  `test:providers`, `test:package-mod`: passed. Manifest preflight covers six targets.
  Initial missing FONTBM/XS path failures were corrected by environment exports.
- `npm run test:jitome-face-render`: passed; 16 partial/full framebuffer pairs.
- Two selected `npm run test:moddable` manifests compiled but runtime did not
  start because `xvfb-run` is absent. These are unavailable, not passed. No further
  retries of the missing executable. Full unrelated simulator builds are omitted.
- Web: 217 legacy tests passed; 72 React tests passed in the first run and one
  hit its five-second timeout. Only that case was rerun with one worker: passed
  in a 2.10-second process (989 ms test). All 73 React cases have passing results.
- Web editor artifact check and TypeScript/Vite production build passed.
- Headless rendering plus actual-device/native SPI checks cover the changed
  implementation. Unchanged web visuals and unrelated peripheral runtime suites
  are not rerun. No acoustic recording or battery/power measurement was performed.
- The planned sixty-minute soak and fifty-cycle check are not claimed complete. The user explicitly requested
  rational, fast testing; no long soak is silently converted to a pass.

Device/API candidate checks: Live Off, Live On and Mini Off completed, with capture
and output progress and zero reported capture-FIFO overruns in their snapshots.
The first Live attempt used an incorrect one-second probe standby deadline and
was fixed. Mini On later failed with `event_loop_watchdog`/`input_missing`;
the follow-up exposed an invalid harness expectation: Realtime input speech is
observable through `onEvent`, while this implementation forwards user transcripts
through `onTranscript` only for Live. Both Mini On variants timed out on that
incorrect transcript predicate without an event-loop watchdog. The corrected
comparison waits for active playback, then checks new speech-start and output-clear
events after injection; both cases passed: new speech-start and output-clear events, continued capture/output and zero reported FIFO overruns. The collector exited 0. No repeated CPU benchmark was needed for this correction. API model output is not deterministic,
and these cases are not controlled audio-quality or latency comparisons.

Live close timeout and Mini hangup diagnostics occurred during STOP; they are
recorded in the private logs. No claim of confirmed server finalization is made.

## Device data, release and remaining work

Live partition entries matched the tracked release layout. Before writes, 458,752
non-application bytes were backed up privately outside Git. Every diagnostic
write targeted only the validated app image at `0x10000`; no erase/full-image,
bootloader/table/NVS/xs/storage write was issued. Esptool resets were disclosed.
Test model, instructions, voice and interruption overrides stay in RAM.

The normal release build and automatic packaging passed. Independent validation
matched the app against both build outputs and the full-image application bytes;
the full image is exactly 16,777,216 bytes, uses the same bootloader/table and has
0xFF everywhere else. No probe symbols/resource or runtime accounting remain.
Earlier R13 image hashes are unchanged. Hashes and sizes are recorded in
[r14-release-artifacts.json](docs/performance/r14-release-artifacts.json).

The app-only R14 image was installed and its flash hash verified. The first boot
capture missed its marker after chained stub operations; a standard reset then
reached `[main] app behaviors ready`. No production code change was needed.

Protected-region comparison found identical bootloader, partition table, PHY,
xs and storage bytes. NVS differed by 109 bytes. The official ESP-IDF parser
found all effective values unchanged except `tts.volume`; its cause is unknown.
A guarded one-setting restoration through the existing Preferences API restored
the original volume string in a private isolated worktree. No raw NVS image is flashed. The
measurement harness now detects a volume preference change instead of silently
reporting completion. This new audit guard was syntax/format checked without
repeating device measurements. After restoration and a normal R14 boot, all
18 decoded physical entries (17 grouped keys, including both PHY data chunks)
match the original saved values. NVS bytes are not claimed identical because
normal NVS updates append/erase records. No credentials or preference values
were printed. See [the data audit](docs/performance/r14-device-data.json).

The validated normal R14 app is reinstalled, its flash hash is verified, and
`[main] app behaviors ready` was observed again. No restoration-only image is
left on the device. This revision is recorded by the local `v2.0.1-r14` tag. The final normal manifest explicitly disables
FreeRTOS runtime accounting; the diagnostic manifest overrides it only for probes. Acoustic quality, physical interruption latency,
post-camera runtime load, normal-image CPU consumption and long-duration stability
remain unknown. Open TODOs are tracked in the plan and are not reported as passes.

## Reproduction and installation

From the repository root with the existing toolchain:

```sh
STACKCHAN_TOOLCHAINS=<existing-toolchains> bash build-gpt-live.sh --mode=release
```

Do not rebuild different contents under the published R14 filenames. The normal
release images above are already built and validated. Diagnostic reconstruction
uses the alternate R14 manifest and `STACKCHAN_REALTIME_WEBRTC=1`; its current
configuration selects the corrected two-case Mini On check. Restore the normal
app after any diagnostic session and perform the protected-data audit.

The app-only installation command from `GPT-LIVE.txt` is:

```sh
esptool --chip esp32s3 --port /dev/ttyACM0 --baud 921600 --before default-reset --after hard-reset write-flash --flash-mode dio --flash-size 16MB --flash-freq 80m 0x10000 gpt-live-package/StackChan-Community-v2.0.1-r14-GPT-Live-app.bin
```

The generated package contains both the application and the full 16 MiB image;
only the application was installed. The full image was never flashed.
