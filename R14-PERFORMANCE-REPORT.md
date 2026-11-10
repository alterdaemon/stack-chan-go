# R14 performance report

The published R14 image contains P01. Release impact: patch. Subsequent measurements
use separate diagnostic images and do not replace the release binaries.

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

## Follow-up measurements (2026-11-10)

- Fresh private backup: 65,536 low-region bytes and 393,216 high-region bytes;
  live partition entries match the release layout. Backups have private access.
- Headless XS settings-view runtime: PASS. LIVE-control initially failed because
  its test manifest omitted `realtimeConversation/web-search`; the manifest was
  corrected, rebuilt and the runtime emitted PASS. Logs:
  `/tmp/stackchan-r14-complete-xs-settings.log` and
  `/tmp/stackchan-r14-complete-xs-live-control.log`.
- The first diagnostic image did not start the new harness: generated module
  mappings selected earlier JS entries. The app was stopped in the bootloader;
  a new NVS read was byte-for-byte identical to the fresh backup. No experiment
  from that attempt is counted as executed. Explicit exclusions and generated
  mapping/stale-artifact checks now guard the diagnostic build.
- The next diagnostic attempt exposed a harness-only assertion: direct PCM
  injection made `liveAudioStop` flush an unstarted renderer. The backtrace
  reached `xEventGroupWaitBits` through `av_render_flush`. The second NVS read
  still matched the fresh backup byte-for-byte. Subsequent PCM replay uses the
  SDK renderer and its normal lifecycle. Serial capture follows the stable USB
  by-id device after watchdog re-enumeration.
- P04: 20 actual CPU measurements on CoreS3. Median time per 4,000 blocks of 512
  samples was 181.727, 91.505, 46.278 and 19.083 ms for every 1/2/4/10 blocks.
  The initial 48 kHz audio case completed. Its 24 kHz counterpart reported a
  runtime error before a valid comparison; the corrected probe records the
  resampler operation and numeric error and queries its required output buffer.
  [Meter CPU data](docs/performance/r14-complete-meter.json),
  [fixture errors](docs/performance/r14-complete-meter-fixtures.json).
- Headless XS native transport runtime also emitted PASS. Log:
  `/tmp/stackchan-r14-complete-xs-transport.log`.

The next device series used image SHA-256
`beaa89030f1c7c049f1d7b6de8ffe0d57d1eface3b31d8bead6addf101475c34`.
The generated mappings select the diagnostic preference module and all six
diagnostic C sources. The app write started at `0x10000`; esptool verified its
hash. The runtime guard rejected one deliberate same-value preference write.
The boot and result markers were captured through the USB serial device.

| Proposal | Comparison on CoreS3 | Interpretation |
| --- | --- | --- |
| P01 | Fifteen pairs: median combined main+SPI CPU reduction 4.388%, positive in 13/15 pairs, with 11,927 µs CPU saved per wall second. | Retain the completion and capacity waits in the published R14 app. The gain is scoped to the measured tasks and workload. |
| P02 | Five paired 48/24 kHz PCM runs: I2S task median 11.849% → 9.085% of one core, median paired reduction 21.623%; measured task sum 122.980% → 118.479% of one core; internal free memory 60,835 → 67,211 B. Both rates ran all 13 pitch values. Three Opus replays per rate: I2S 11.201% → 8.834%, decoder 9.506% → 8.557%, tracked task sum 143.403% → 142.489%, and median free internal memory 43,511 → 49,859 B. | Retain 48 kHz. The task sum changed by 0.914 percentage points on the Opus workload. Both rates produced the expected sample counts and the same median 148 captured Opus frames; the lower rate did not establish comparable acoustic quality or live provider behavior. |
| P03 | Five paired PSRAM/SRAM runs: capture task median 44.144% → 43.538% of one core; median paired reduction 2.548% (range −0.596% to 3.243%). Median run-local internal minimum 60,631 → 57,607 B. | Retain PSRAM. The measured service saving trades away about 3 KB of internal headroom; the local test does not measure live TLS peaks. |
| P04 | Every 1/2/4/10 full blocks: 181.727/91.505/46.278/19.083 ms CPU per 4,000 blocks. Stride four loses the 2 kHz fixture; every four full blocks can miss the one-block impulse. | Retain exact statistics at the current rate. |
| P05 | Three runs each at 100/150/180/200 ms: median main+SPI CPU 37.862/34.261/33.280/32.820% of one core; median SPI bytes 396,720/271,440/229,680/219,240; median mouth changes 38/26/22/20. | Slower sampling buys CPU and SPI time by dropping visual updates. The workload is a controlled level envelope; it does not establish acceptable lip timing on speech. |
| P06 | Three pairs of the same 60 mouth updates: dirty/full median 626,400/9,216,000 SPI bytes and 701.947/1,751.419 ms main+SPI CPU. | Preserve dirty updates. The full redraw is an experimental control; the saving already exists in R14. |
| P07 | Five pairs replaying 112 identical Opus packets through SDK queue and decoder primitives: 1/3 packet groups used 882.580/881.536 µs CPU per packet; median elapsed time was 98.903/98.936 ms. Each decoded 107,520 samples with the same hash. Both cancelled after 17 packets with matching output. | Keep per-packet processing. Group count fell from 112 to 38, but queue and cancellation checks still occur per packet. The isolated result does not justify modifying the live renderer worker. |
| P08 | 48 corrected replays, three per pattern and threshold. For equal-interval arrivals, median first PCM dequeue at 0/20/40/60 ms targets was 6.324/15.143/34.844/56.092 ms. For gap replays it was 4.671/15.968/35.725/52.900 ms. Each pattern preserved its payload count and hash; the 30 ms tail released at every threshold. | Keep immediate playback. Startup delay increased; gap results did not show a repeatable continuity gain. Some replay timer lateness exceeded 100 ms, and the missing-PCM counter includes trailing silence. These are measurements of the delivered replay, not a controlled network jitter guarantee. |
| P09 | 27 runs: three repetitions per combination of 3/4/6 DMA descriptors and injected 0/25/45 ms service stalls. With no stall or 25 ms, median RX and TX queue overflows were zero at all depths. At 45 ms, medians per direction were 12/6/0. With no stall, median internal minimum was 60,703/56,727/49,027 B. | Keep three descriptors for R14. Added descriptors absorb the induced fault, but consume up to 11,676 B of measured internal headroom. These runs do not show a natural service gap that needs more capacity. |
| P10 | Three Opus replays per rate. At 48/24 kHz, median startup allocation count was 578/582 and steady count 1,156/1,147; steady allocated bytes 114,260/109,029 and frees 1,157/1,148. Actual PCM dequeue was 215,040/107,520 B for identical packet input. | Retain existing reuse. Heap hooks count the whole instrumented workload, including JS/UI and queue activity. Lower-rate PCM traffic does not demonstrate a removable copy; the independent producer/consumer buffers remain necessary under the current ownership scheme. |
| P11 | No camera tasks before first use. The two camera tasks used 11.755% of one core after capture, 11.825% after `stop()`, 11.803% after restart and 0.522% in the `close()` window. All five local media cases encoded audio with zero capture FIFO or RX DMA overflow. Free internal memory remained 27,936 B below the pre-camera snapshot after close. | The post-preview work is real. The installed native driver sends stop through a notification that its running loop does not consume on every path. Close did not establish immediate task/heap recovery or reopen safety. Keep the current feature behavior until the native lifecycle is fixed and validated. |
| P12 | Both real API searches returned a source: GPT-Live recorded hosted tool events in 4.839 s with zero device Responses calls; Mini took 14.653 s and made one device Responses call. | These are two observed latencies from distinct models and paths, not a controlled speed comparison. Keep hosted Live search and the bounded Mini worker. In these post-camera runs search completed, but capture progress did not: both samples had zero captured/forwarded samples. |

The first P08 replay had an invalid priming gate: an empty queue could mark
priming complete before the first packet. Its 48 rows are not used for the
threshold comparison. The corrected replay measured distinct thresholds but the
timer-driven cancellation setup did not satisfy its precondition. A final
targeted run held one real PCM block with no tail marker: 960 bytes queued,
zero dequeued before STOP. A replacement session released all 2,880 bytes of
the short tail and matched the immediate-playback hash.

The LAN TLS fixture answered a host self-check, but recorded no request from
CoreS3. The un-cancelled device request timed out after 18.64 s while the capture
encoder produced 958 frames; cancellation returned after 418 ms while encoding
continued. This does not establish successful delayed TLS delivery. The focused
image ran a controlled delayed response in the actual worker queue: one source
returned in 2.154 s. Cancellation at 350 ms settled in 361 ms and a subsequent
request completed in 96 ms. Both workloads encoded 201 frames, with zero capture
FIFO overflow and 3.32–3.36 s of digitally detected playback. The replay
exercises the real worker/queue/summary but supplies the response without TLS.

The microphone recording at the host picked up the Opus fixture with peak
envelope alignment at similar times across both rates. The median best
20 ms envelope correlation was 0.535 at 48 kHz and 0.420 at 24 kHz; ambient
controls ranged 0.291–0.424. This is weak, uncalibrated evidence of playback,
not an intelligibility, echo, or physical interruption latency acceptance test.
See [acoustic aggregates](docs/performance/r14-complete-acoustic.json) and
[focused device measurements](docs/performance/r14-complete-focused.json).

All 50 planned start/stop attempts ran after camera use: 13 in each provider
with interruption Off reached capture progress and local inactive state;
12 in each provider with interruption On did not reach capture progress.
The first 20-second capture window of the long run failed in both modes.
That series was ended before repeating more identical no-progress windows.
Those results are diagnostic failures. They do not show that the normal
release or an equivalent fresh-boot run has the same behavior. See
[device series measurements](docs/performance/r14-complete-device.json).

The first fresh-provider flash verified but did not produce a captured startup
marker. A reset without a flash write started the same image and confirmed its
preference guard. Mini then passed the digital On case (one new speech-start
event and one output-clear event), and both Off cases produced playback.
Fresh Live On reached audio output and forwarded input, but the probe waited
for a Realtime-specific speech-start event. That predicate cannot determine
Live input acceptance; [the Live session guide](https://developers.openai.com/api/docs/guides/live-conversations)
and the repository core use `session.input_transcript.delta` for Live user
speech. In the final focused run, audio was playing, input was forwarded and
three nonempty user transcript fragments arrived after injection. The same
run reported 17 capture FIFO overruns. It confirms digital input acceptance,
but does not pass continuous capture or physical interruption latency. See
[buffered STOP and Live input results](docs/performance/r14-complete-final-probe.json).

Fresh Live capture advanced to 33,280 samples and then stopped increasing in
the next 20-second window. Mini capture advanced for the observed 161.151 s
with zero capture FIFO overflow. The 60-minute stability gate failed on Live;
the contrasting Mini window was stopped to finish the targeted checks. The
hour target was not reached. Close timeout and hangup diagnostics are retained
separately from local capture evidence. See [fresh-provider results](docs/performance/r14-complete-provider.json).

The R14 recommendation is to keep P01 and the current WebRTC/audio defaults.
P11 is the clearest next performance investigation: the measured post-stop
camera work and retained memory justify fixing and testing the native
stop/close path, including frame ownership, touch recovery, reopen, and live
capture after camera use. P02 is a smaller measured CPU opportunity with a
useful memory benefit, but requires a representative audio and live provider
comparison before changing the hardware rate. The other tested alternatives
either repeat existing behavior, save little, or change visible/audio behavior.

The R15 follow-up fixed the P11 camera lifecycle. Both tasks exited after stop,
the preview and eight reopen cycles passed, and both real API modes advanced
their audio sample counters in the short post-camera test.
[R15 device results](docs/release-notes/v2.0.1-r15.md)

### Reproduce the diagnostic build

From `firmware/`, use the same activated toolchain as the normal release.
Supply a nonprivate 16 kHz mono PCM16 speech fixture at `dist/probe-input.pcm`.
The measured fixture SHA-256 was
`46b48a29d7f14a07ca8dc7f7bb1c406fd124ba6cf7e582fd8b6b6a2c709ff41d`;
its length was 71,032 bytes. The Opus generator reproduced 112 packets and
5,211 bytes with SHA-256
`5e401a83cf298c0880e5bb49d8996e938b88f39dbead8f4e43434db7ad1302f5`.
Run the bounded TLS fixture separately, using a private directory for its key
and `dist/r14-complete/https-fixture.dat` for the public test configuration.

```sh
probe=mods/examples/openai_live_webrtc/__tests__/live-performance/r14-complete
python3 "$probe/prepare.py"
python3 "$probe/opus-fixture.py" dist/probe-input.pcm dist/r14-complete/probe-opus.dat
STACKCHAN_REALTIME_WEBRTC=1 npm run build -- --mode=release --manifest host/app/manifest_openai_r14_complete.json
python3 "$probe/validate.py"
```

Set `STACKCHAN_R14_FOLLOWUP=1` for the focused P08/P10/P12 worker replay,
`provider` for the fresh-boot provider tests, or `priming-cancel` for the
single buffered-stop/replacement and GPT-Live input-transcript checks.
These builds do not package or flash the device. Check the live table and
image bounds before a diagnostic write, back up
protected regions, and collect the boot/guard/progress markers with
`scripts/capture-r14-complete.py`. Summarize the captured records with
`scripts/analyze-r14-complete.py` and restore the verified normal app.

## Initial release validation

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
- Settings view, Live control and native transport ran successfully with the
  existing headless screen runner. The earlier Xvfb-based runtime did not start;
  compilation in that earlier attempt is not counted as runtime execution.
- Web: 217 legacy tests passed; 72 React tests passed in the first run and one
  hit its five-second timeout. Only that case was rerun with one worker: passed
  in a 2.10-second process (989 ms test). All 73 React cases have passing results.
- Web editor artifact check and TypeScript/Vite production build passed.
- Headless rendering plus actual-device/native SPI checks cover the changed
  implementation. Unchanged web visuals and unrelated peripheral runtime suites
  were not rerun. This release validation did not include acoustic recording
  or battery/power measurement. Follow-up device results are recorded above.

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

## Device data and release images

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

The initial R14 release session's protected-region comparison found identical bootloader, partition table, PHY,
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

The normal R14 manifest disables FreeRTOS runtime accounting; diagnostic
manifests enable it only for probes. The local `v2.0.1-r14` tag identifies the
published R14 image. Normal-image CPU consumption, physical interruption latency
and acoustic quality equivalence remain unverified.

After the follow-up, the original R14 app (SHA-256
`d95ad96d97b9dd0ce0e549411115c15e9b66b2c2c6d4fcb30d0e4769ad07cd41`)
was written at `0x10000`. Esptool verified the write and the device emitted
`[main] app behaviors ready` after restoration and again after the audit read.
All 458,752 protected bytes matched the fresh backup, including NVS, xs, storage,
bootloader, partition table and PHY. This comparison is for the follow-up
session and is separate from the initial release's NVS deviation above.
No protected partition was written. See [the follow-up data audit](docs/performance/r14-complete-data-audit.json).

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
