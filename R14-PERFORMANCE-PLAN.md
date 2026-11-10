# R14 OpenAI performance verification and implementation plan

Planning date: 2026-11-10. Target product version: `2.0.1-r14`. Target tag:
`v2.0.1-r14`.

Probe, test, and implement the accepted optimizations below under **R14**. Cover
all twelve proposals, including a documented decision when a mechanism is already
present or an experiment does not justify a change. Preserve the existing
GPT-Live and GPT-Realtime Mini features, saved settings, audio behavior, and
earlier performance fixes.

Current authorization covers writing this plan. Implementation, instrumentation,
builds, test execution, API sessions, and device operations remain pending a later
instruction to execute it. Creating this document does not advance the revision.

## Progress tracking

Check a task only after its stated outcome is supported by a source, artifact, or
test record. Record the command, source/build identity, outcome, and evidence
location. A successful build or flash is not test execution. A timeout, missing
startup marker, or skipped required test is not a pass.

- [x] Read the twelve supplied proposals and relevant implementation sources.
- [x] Review prior R11, R12, and R13 investigation records.
- [x] Research hardware, SDK, protocol, and upstream constraints.
- [x] Assign future probing, testing, accepted implementation, and release work to R14.
- [x] Save this plan and its TODO checklists in the repository root.
- [ ] EXEC: Receive an instruction to begin execution before performing future tasks.
- [ ] BASE: Complete and record the baseline and measurement prerequisites.
- [ ] PROP: Give every proposal a measured result or evidence-backed disposition.
- [ ] COMB: Compare the combined accepted changes against the frozen baseline.
- [ ] REG: Complete the required automated, simulator, device, API, and acoustic checks.
- [ ] REL: Validate and finish the R14 release artifacts, documentation, commit, and tag.

Status vocabulary: **research complete**, **pending baseline**, **probing**,
**implemented pending validation**, **accepted**, **already present**,
**rejected**, or **deferred with reason**. Research completion does not establish
a measured performance improvement.

| Proposal | Research assessment | Execution status | Measured benefit and final decision |
| --- | --- | --- | --- |
| P01 SPI waiting | Viable; high investigation priority | Pending baseline | Unknown |
| P02 24 kHz hardware audio | Component support established; coordinated pipeline experiment | Pending baseline | Unknown |
| P03 AEC sample buffers in SRAM | Viable, bounded memory-placement experiment | Pending baseline | Unknown |
| P04 Cheaper level measurements | Viable, narrow hot-path reduction | Pending baseline | Unknown |
| P05 Slower mouth updates | Viable with an animation responsiveness tradeoff | Pending baseline | Unknown |
| P06 Targeted redraw reduction | Viable; actual avatar and dirty area determine scope | Pending baseline | Unknown |
| P07 Available-packet batching | Conditional on measured queue overhead | Pending baseline | Unknown |
| P08 Sample-based playback priming | Conditional on measured PCM starvation and latency | Pending baseline | Unknown |
| P09 DMA headroom | Conditional on measured peripheral service gaps | Pending baseline | Unknown |
| P10 Buffer reuse | Native PCM path already substantially reuses storage | Pending allocation audit | Unknown additional opportunity |
| P11 Suspend unused activity | Audit actual task/peripheral activity first | Pending activity audit | Unknown |
| P12 Hosted search | GPT-Live already configures hosted search; Mini is separate | Pending configuration verification | Unknown additional opportunity |

## Evidence and baseline limits

The manufacturer specifies an ESP32-S3 with two 240 MHz cores, 16 MB flash,
8 MB **Quad PSRAM**, a 320 by 240 display, an AW88298 I2S amplifier, and an
ES7210 microphone ADC. CPU service time, internal-memory capacity, PSRAM/cache
traffic, peripheral bandwidth, and network delivery must be measured separately.
[Manufacturer specifications][m5]

The generated configuration inspected during research selects 240 MHz CPU,
80 MHz PSRAM, and a 64 KB data cache with 64-byte lines. It selects size-oriented
compiler optimization and does not enable FreeRTOS runtime statistics. These are
properties of that generated build, not verification of the installed device.
Recheck the effective configuration for the chosen R14 baseline.
[Generated configuration][sdkconfig]

The reviewed native path uses 48 kHz stereo PCM16 I2S transfers in 480-frame
blocks, three DMA descriptors, and a 16 kHz AEC/input path. The AEC-facing sample
buffers reside in PSRAM. Mono decoding, low-delay encoding at complexity zero,
and internal codec/capture stacks are already configured; preserve those policies
unless a separate measured experiment justifies changing them.
[Native audio][audio], [Opus policy][opus], [Media adapter][media],
[Transport scheduling][native-transport]

Historical results are context, not validation of a new baseline:

- R11 records failed worker/priority approaches and the reason for separating
  I2S progress from delayed AEC processing. Do not reintroduce a lossy bounded
  worker or synchronous AEC on the I2S task without resolving those failures.
  [R11 record][r11]
- R12 records the XS-to-SPI priority dependency, non-equivalent sequential
  profile workloads, and serial-report interference. Its original 8/12 ms UI
  policy is distinct from the later 4/8 ms follow-up retained in R13.
  [R12 record][r12], [4/8 ms follow-up][r12-followup], [R13 record][r13]
- R13 records a completed Mini digital scenario with zero capture overruns but
  output-underrun counts of 324 with interruption On and 1 with Off. It does not
  establish uninterrupted intelligible acoustic output. Do not interpret those
  counters as a controlled comparison of interruption settings or as proof of
  missing audible speech. [R13 device results][r13]
- At the latest R13 note inspection for this plan, the subsequent Off prompt
  comparison reached completion: both modes obeyed the marker, while Mini's
  first audio turn did not exhibit the saved personality as Live did. A RAM-only
  prompt-scope candidate and replacement release validation remained pending.
  Reconcile this separate issue before selecting the baseline; API instruction
  receipt alone does not prove behavioral prompt compliance. [R13 prompt amendment][r13]

The tree contains pre-existing R13 source, test, documentation, and probe changes.
Do not discard, amend, or silently include them in an optimization change. Current
complete-suite status, acoustic baseline, installed image identity, live SRAM
headroom, and all candidate speedups remain unknown.

## Baseline and measurement prerequisites

- [ ] B01: Reconcile the intended R13 baseline, outstanding prompt work, and existing uncommitted changes; record exactly what is included.
- [ ] B02: Record the baseline commit, local differences, firmware/app image hashes, manifest, fixture hashes, toolchain identities, component versions, and build mode.
- [ ] B03: Preserve the baseline, earlier revision commits/tags, and existing BINs. Use isolated candidate changes and repository-managed build output.
- [ ] B04: Inspect effective generated `sdkconfig`, compiler commands, linked libraries, ELF/image metadata, CPU/PSRAM clocks, caches, task priorities, and task affinities.
- [ ] B05: Confirm linked implementations and adapter overrides; a task configuration callback alone may not determine effective placement.
- [ ] B06: Establish baseline automated test results and distinguish inherited failures from optimization regressions. Resolve or explicitly record failures before comparisons.
- [ ] B07: Establish physical speaker/microphone behavior, intelligibility, echo, interruption, touch, and avatar behavior on the baseline.
- [ ] B08: Inventory active tasks, timers, workers, peripherals, allocations, and queue occupancy during idle, capture, playback, full duplex, and search.
- [ ] B09: Add bounded diagnostic-only CPU runtime accounting or equivalent validated profiling. Keep per-task/per-core CPU service separate from wall-clock latency and periodic task samples.
- [ ] B10: Measure instrumentation overhead with matched instrumented control runs. Keep expensive accounting, heap inspection, and logging off audio/UI timing paths.
- [ ] B11: Extend the existing probe mechanisms where sufficient; do not introduce a permanent worker, service, queue, or persistence layer for measurement.
- [ ] B12: Keep measurements, profile overrides, synthetic microphone data, and prompt overrides in bounded RAM. Buffer summaries and print after timed playback.
- [ ] B13: Define expected test-start/progress/completion markers, timeouts, and output bounds. The current collector has a 30-second startup guard; retain or explicitly justify a replacement.
- [ ] B14: Define separate deterministic PCM/packet-replay experiments and live API experiments. Capture private replay fixtures only when needed, outside Git.
- [ ] B15: Fix model/mode, voice, pitch, volume, instructions, interruption, avatar, Wi-Fi conditions, UI workload, warm-up, and scenario duration within each comparison.
- [ ] B16: Alternate repeated baseline/candidate runs; begin with five paired runs and extend when variation obscures the result. Record distributions and run-to-run spread.
- [ ] B17: Set baseline-derived acceptance margins for audio quality, latency, memory, and responsiveness before interpreting candidate results. Preserve useful small gains when measurable; do not invent a minimum percentage.
- [ ] B18: Correlate packet arrival, decode/PCM availability, I2S submission, intentional silence, and actual audible output so starvation categories remain distinguishable.

Use scheduler-accounted CPU time for utilization claims. Timing a function under
preemption measures elapsed time, including interruption and waiting. Espressif
also cautions that cycle counters are per-core. More buffering, a different
priority, or a different core redistributes service and latency; it does not add
processing capacity. [Espressif measurement guidance][speed]

For each run record CPU milliseconds per second by task/core; processing and
service-gap p50/p95/p99 and maximum; queue fill in samples and milliseconds;
input loss; output shortage duration; first-sound and interruption latency;
touch-to-visible latency; SPI traffic; allocation/copy activity; minimum internal
and external free heap; largest free blocks; and stack high-water use where
relevant. Sample sizes must support the reported percentiles. Use acoustic
recordings for speech quality and microphone-to-speaker interruption latency.
[Heap measurement APIs][heap]

## P01 Replace SPI busy waiting

**Assessment:** viable; investigate early because the installed SDK contains
busy-yield waits in both `modSPIFlush()` and `modSPITxCommon()`. Completion-driven
blocking could release CPU during transfer waits. It cannot increase SPI wire
bandwidth. The local SDK source was inspected through the dependency path in the
generated `modSPI.c.d`; the R12 record independently documents the flush loop and
the scheduling dependency. [R12 investigation][r12]

- [x] P01.1: Review both waits and the earlier main-only/SPI-only priority attempts.
- [ ] P01.2: Measure CPU service consumed in each wait, blocked time, transfer completion, SPI bytes, UI latency, and concurrent audio continuity.
- [ ] P01.3: Design synchronized condition checks and completion/capacity notifications covering missed wakeups, already-complete transfers, configuration changes, and shared-bus arbitration.
- [ ] P01.4: If justified, implement a reproducible repository-managed SDK integration; avoid an undocumented modification of a shared toolchain checkout.
- [ ] P01.5: Test notifications before/during waiter registration, repeated transfers, competing SPI users, failure/shutdown behavior, and delayed SPI progress.
- [ ] P01.6: Keep the existing UI priority/windows fixed for the first comparison; verify display, touch, I2S, capture, codec, and network progress while each dependency is delayed.
- [ ] P01.7: Record baseline/candidate CPU time and latency, run relevant XS/native/UI/device regressions, then accept or reject with evidence.

Accept only when waiting consumes measurably less CPU without transfer corruption,
deadlock, starvation, impaired touch, or worse audio. Covering only one wait is
insufficient if the other remains material.

## P02 Evaluate the complete 24 kHz hardware audio path

**Assessment:** component support is established; integration and acoustic quality
require testing. Espressif audio codec 2.5.0 supports 24 kHz Opus decoding, and its
ES7210 driver lists 24 kHz clock configurations. Our audio, pitch, and amplifier
setup contain 48 kHz assumptions. AEC remains at 16 kHz.
[Codec support][codec], [ES7210 clocks][es7210], [Audio path][audio],
[Pitch path][pitch], [Session amplifier setup][session]

Calculated stereo PCM16 I2S traffic per direction changes from 192,000 to
96,000 bytes/s. Mono playback traffic changes from 96,000 to 48,000 bytes/s.
These are sample-traffic reductions, not predictions of total CPU savings.
AEC and the current 16 kHz encoded input do not halve their sample workload.
Opus RTP timestamps must retain a 48 kHz clock at either hardware rate.
[RTP clock requirement][rtp]

- [x] P02.1: Review hardware/codec support and identify the coordinated-rate requirement.
- [ ] P02.2: Enumerate every rate-dependent clock, frame/block size, buffer capacity, time conversion, pitch setting, render format, sample counter, and reference-delay assumption.
- [ ] P02.3: Verify AW88298 and ES7210 MCLK/BCLK/WS ratios and register settings; do not assume changing the I2S or amplifier rate alone is sufficient.
- [ ] P02.4: Establish whether native Opus output at 24 kHz avoids a renderer conversion; preserve mono decoding and the existing 16 kHz capture/encoding policy.
- [ ] P02.5: If justified, implement the coordinated pipeline variant with the same buffer durations and 10 ms hardware service period initially; keep protocol/RTP clocks correct.
- [ ] P02.6: Preserve post-pitch/post-volume speaker-reference alignment, including DMA delay, silence, mute, interruption, and cancellation.
- [ ] P02.7: Compare decoder, pitch, resampler, PCM-copy and I2S CPU time, memory, queue fill, sample continuity, startup/stop latency, and output duration.
- [ ] P02.8: Verify all supported pitch values, voices/settings, transitions back to host audio, and both providers with interruption On/Off.
- [ ] P02.9: Record physical clock/sample behavior and acoustic intelligibility, pitch, echo suppression, double talk, and interruption latency.
- [ ] P02.10: Accept or reject using measured whole-pipeline benefit and acoustic results; identify any bandwidth/quality tradeoff explicitly.

Do not claim a 50% system speedup or unchanged audible quality from the reduction
in sample traffic. Re-evaluate P03/P08/P09 memory and timing calculations after
any accepted rate change.

## P03 Move small AEC sample buffers into internal SRAM

**Assessment:** viable bounded allocation experiment. At the recorded 512-sample
chunk, three PCM16 planes occupy `3 * 512 * 2 = 3072` payload bytes. They currently
reside in the PSRAM workspace. Move only the justified sample planes initially,
keeping the AEC filter state unchanged. [Allocation][audio], [Chunk record][r11]

Cached PSRAM accesses can approach internal-memory speed, while larger working
sets and cache contention can reduce performance. Moving 3 KB does not establish
that AEC's limiting accesses move with it. Internal RAM headroom must be measured.
[External RAM constraints][psram]

- [x] P03.1: Identify AEC-facing planes, ownership, alignment, and current placement.
- [ ] P03.2: Measure AEC CPU/elapsed-time distributions under equivalent UI, codec, and TLS load; record actual chunk size and heap/stack margins.
- [ ] P03.3: If justified, allocate the three planes with explicit internal-memory capabilities and required alignment, avoiding duplicate retained storage.
- [ ] P03.4: Preserve the producer/consumer separation, sample/reference order, cached output tail, and capture-before-free teardown order.
- [ ] P03.5: Test allocation failures and partial initialization; select and document a safe fallback or explicit failure policy based on measured headroom.
- [ ] P03.6: Verify deterministic output equivalence and delayed-AEC/I2S progress; compare minimum internal heap and largest blocks during startup, TLS, playback, and close.
- [ ] P03.7: Accept only a reproducible benefit within measured internal-memory margins; otherwise retain PSRAM placement and record the result.

## P04 Reduce audio level measurement work

**Assessment:** viable narrow reduction. `captureStats()` computes microphone,
reference, and cleaned levels by traversing each sample. It also performs mute
handling and sample accounting, which must remain complete. The mouth uses a
different playback meter already accumulated in the output loop.
[Capture and playback statistics][audio], [Mouth consumer][mod]

At 16 kHz, the three level accumulations involve approximately 48,000 sample
accumulations/s. A stride of four reduces that to approximately 12,000/s: 75%
fewer sampled accumulations, not 75% less audio CPU work.

- [x] P04.1: Verify level consumers and distinguish statistics from audio processing/gating.
- [ ] P04.2: Measure the current statistics cost separately from AEC, mute clearing, and sample accounting.
- [ ] P04.3: Compare full-rate statistics, stride sampling, and less-frequent full-frame measurement on speech, silence, tones, transients, and clipping fixtures.
- [ ] P04.4: If justified, implement the least complex measured option with correct normalization, bounded arithmetic, and handling of chunk sizes not divisible by the stride.
- [ ] P04.5: Verify unchanged PCM, timestamps, sample counters, mute/quiesce behavior, and AEC/encoder input; quantify level error and missed transients.
- [ ] P04.6: Record cycle/CPU savings and whole-pipeline results; retain only a measurable benefit without an unacceptable meter regression.

## P05 Evaluate less frequent mouth updates

**Assessment:** viable with a visible responsiveness tradeoff. The current 100 ms
timer schedules 10 callbacks/s and suppresses unchanged quantized values. At
180/200 ms, nominal callbacks become about 5.56/5 per second. Redraw savings may
be smaller because unchanged values already produce no mouth update. [Mouth logic][mod]

- [x] P05.1: Review timer lifecycle, quantization, unchanged-value suppression, and playback-level input.
- [ ] P05.2: Compare 100, 150, 180, and 200 ms with identical output and avatar workloads; keep touch polling and screen scheduling fixed.
- [ ] P05.3: Measure callback CPU, changed-mouth updates, dirty pixels, SPI bytes, and visible opening/closing delay.
- [ ] P05.4: If justified, implement the selected interval without disabling required animation or slowing touch.
- [ ] P05.5: Verify timer cleanup and immediate neutral mouth restoration on closing/error/standby; ensure restart creates no duplicate timer.
- [ ] P05.6: Record the CPU/traffic benefit and visual assessment; reject or disclose an unacceptable responsiveness tradeoff.

## P06 Reduce actual redraw area and rendering work

**Assessment:** viable targeted investigation. The inherited display uses RGB565;
Jitome already updates changed geometry and invalidates individual dirty regions.
The foreign RGB565/partial-refresh settings are not themselves missing features.
[Display inheritance][platform], [Jitome rendering][jitome],
[Foreign display configuration][foreign-display]

The inspected generated display configuration is 320 by 240 at 40 MHz SPI. A
full RGB565 frame has `320 * 240 * 2 = 153600` bytes and takes at least
`153600 * 8 / 40000000 = 30.72 ms` on the wire before commands/gaps. A 20-line
payload is 12,800 bytes, or 2.56 ms at that clock. These are calculated wire times,
not measured rendering or full-frame latency. [Generated definitions][defines]

- [x] P06.1: Review current pixel format, SPI/DMA path, dirty-region behavior, and screen scheduling.
- [ ] P06.2: Identify the actual configured avatar and active effects; measure invalidated area, transferred bytes, geometry/raster CPU, and frame-completion latency.
- [ ] P06.3: Inspect repeated unchanged-state delivery, redundant geometry, overly broad invalidation, overlapping effects, and unnecessary full redraws.
- [ ] P06.4: If measured, implement surgical reuse/caching/invalidation corrections for the affected components; preserve current features and bounded memory.
- [ ] P06.5: Compare mouth motion, eyes/blinks, expressions, drawer/buttons, overlays, hiding/restoring content, and repeated transitions with visual evidence.
- [ ] P06.6: Run applicable face-render and UI tests plus device audio/touch comparisons; confirm no stale pixels, tearing, missing effects, or new allocation pressure.
- [ ] P06.7: Record actual bytes and CPU saved; avoid a renderer replacement unless the measurements establish its necessity.

The existing Jitome benchmark README describes an older Moddable setup. Reuse its
scenarios only after reconciling the current toolchain and safe device-write
requirements; do not copy its flashing command as an unreviewed test procedure.
[Benchmark description][jitome-benchmark]

## P07 Batch only already available Opus packets

**Assessment:** conditional on measured queue overhead. The foreign patch takes
up to three already queued compatible packets, caps represented audio at 60 ms,
then still decodes and locks the decoder separately for each packet. The potential
gain is surrounding queue/output handling, not three decodes for one decode's
cost. Our SDK has a decode queue and reusable output storage.
[Foreign patch][foreign-patch], [SDK decoder][sdk-decoder]

The installed `av_render.c` and `audio_decoder.c` matched the referenced
Espressif commit by Git blob SHA-1 during research: respectively
`9d00540e6fc50c3b798f675ebffd6e9ef2635d40` and
`e541c6b394b7fb30eb76aaabb13cd8a9869760d0`. Recheck before any SDK change.

- [x] P07.1: Distinguish individual codec work from queue/lock/output overhead in both architectures.
- [ ] P07.2: Measure queue operations, mutex CPU/wait time, packet arrivals, decode time, output copies, and occupancy during the actual symptom.
- [ ] P07.3: Continue only if surrounding overhead is material; otherwise record an evidence-backed deferral/rejection.
- [ ] P07.4: If justified, implement bounded draining of immediately available compatible packets with no wait for additional arrivals and cancellation checks between packets.
- [ ] P07.5: Preserve individual Opus packet boundaries, timestamps, loss handling, response/session identity, and generation-based cancellation; do not concatenate arbitrary compressed bytes.
- [ ] P07.6: Test sparse arrivals, bursts, mixed durations/formats, packet loss, short replies, stop/interruption mid-batch, and late data from a prior session.
- [ ] P07.7: Compare decoder/output CPU and first-sound/interruption latency, sample order and end-to-end audio; reject extra latency or resource growth without sufficient benefit.

## P08 Evaluate sample based playback priming and short tail release

**Assessment:** viable design only when PCM starvation is demonstrated. The
current output FIFO already counts bytes, and `renderLatency()` converts its
occupancy to time. The custom PCM output FIFO holds 19,200 bytes, nominally
200 ms at 48 kHz mono PCM16; this is not the total buffering across RTP and SDK
layers. [Playback FIFO and latency][audio], [RTP cache configuration][native-transport]

The SDK threshold mechanism checks queue bytes and later entry count, sleeping
10 ms when the threshold is not satisfied. It does not directly implement the
proposed sample-based, completion-aware policy. The foreign 700 ms start threshold
is unsuitable as an unmeasured default and exceeds our custom output FIFO's
current capacity. [SDK threshold behavior][sdk-render], [Foreign priming][foreign-patch]

- [x] P08.1: Review existing buffer layers and distinguish FIFO capacity, current occupancy, priming delay, and network jitter handling.
- [ ] P08.2: Correlate missing PCM with arrival/decode/I2S evidence; distinguish intentional silence, CPU starvation, and network delivery gaps.
- [ ] P08.3: Define a bounded sample-count policy and verify reliable turn-completion semantics against RTP/decoded PCM; a control event alone must not be assumed to mean that PCM has drained.
- [ ] P08.4: Compare proposed 0/20/40/60 ms targets using identical replay traces; treat these as experimental points, not established optima.
- [ ] P08.5: If justified, implement priming with early release for a completed short tail while keeping I2S clocks, silence output, and AEC reference timing continuous.
- [ ] P08.6: Verify variable frame sizes, short replies below threshold, pauses, bursts, completion before/after the final packet, interruption/STOP during priming, and response/session reset.
- [ ] P08.7: Measure first-sound latency, missing-audio duration, rebuffering, queue memory, and interruption latency; accept only an explicit continuity/latency improvement.

## P09 Size DMA headroom from measured service gaps

**Assessment:** viable for tolerance to service delays; descriptor count alone is
not a CPU-speed optimization. Current three 480-frame stereo PCM16 descriptors
represent 10 ms each at 48 kHz. Across TX/RX, payload storage is
`3 * 480 * 2 * 2 * 2 = 11520` bytes before descriptor/driver overhead.
One additional descriptor in both directions plus the current reference ring
costs `480 * 2 * 2 * 2 + 480 * 2 = 4800` payload bytes and adds 10 ms nominal
capacity. Descriptor count alone does not change the interrupt interval.
[DMA and reference implementation][audio], [IDF sizing rules][i2s]

The foreign release claims 6 to 12 descriptors, but its pinned Xiaozhi header
defines six. Treat the release claim as conflicting evidence, not a configuration
to copy. [Release claim][foreign-release], [Pinned header][foreign-dma]

- [x] P09.1: Review current descriptor/frame settings, memory arithmetic, reference delay, and the external-source conflict.
- [ ] P09.2: Measure maximum servicing gaps and actual hardware input loss separately from capture-FIFO overruns or empty decoded output.
- [ ] P09.3: Calculate descriptor/frame/receive-buffer requirements using the actual IDF version, channel layout, contiguous DMA-capable memory, and measured intervals.
- [ ] P09.4: If needed, compare three descriptors with bounded candidates such as four/six while holding block duration fixed; measure capacity, not assumed CPU savings.
- [ ] P09.5: Keep reference-delay storage and latency reporting consistent with actual submitted/heard audio and verify acoustically rather than assuming count times block duration is exact physical delay.
- [ ] P09.6: Test allocation failure, startup/teardown, mute/quiesce, cancellation and post-session host audio; measure SRAM/stack margins and input/output continuity.
- [ ] P09.7: Accept only a measured continuity benefit within latency/memory limits; reject added buffering that hides a sustained processing deficit.

## P10 Audit remaining audio allocations and copies

**Assessment:** native PCM storage, stream buffers, and pitch state already reuse
session allocations. The SDK decoder reuses output storage and can enlarge it
when needed. A replacement vector or another audio queue is not justified by the
foreign implementation alone. [Native buffers][audio], [Pitch storage][pitch],
[SDK output buffer][sdk-decoder], [Foreign PCM assembly][foreign-pcm]

- [x] P10.1: Review existing reuse and distinguish control-message allocations from PCM streaming.
- [ ] P10.2: Trace allocation count/bytes/cost and PCM copies during startup, warm-up, steady streaming, search, and close with bounded measurement overhead.
- [ ] P10.3: Identify repeated hot-path allocations or copies; distinguish one-time decoder enlargement from per-packet activity.
- [ ] P10.4: If measured, remove or reuse only those allocations/copies while bounding retained capacity and preserving cross-task ownership.
- [ ] P10.5: Verify partial initialization, allocation failures, teardown ordering, long sessions, repeated start/stop, and absence of stale data between sessions.
- [ ] P10.6: Record CPU/copy reductions, internal/PSRAM minima, largest free blocks, and retained memory; otherwise close as already present with audit evidence.

## P11 Audit and suspend genuinely unused activity

**Assessment:** audit first. LIVE already disables autonomous face motion while
active. Camera construction is lazy, but `capture()` can start the native camera
and does not itself stop it. Measure conversations both after a fresh boot and
after camera/preview use; this source behavior does not prove current runtime
camera load. [LIVE face policy][mod], [Camera implementation][camera],
[Runtime camera wrapper][runtime-camera]

- [x] P11.1: Review existing face suspension and lazy camera lifecycle.
- [ ] P11.2: Attribute actual CPU time, wakeups, I/O and retained buffers to optional activity in fresh-boot, post-camera, preview, idle and conversation scenarios.
- [ ] P11.3: Identify user-required behavior and distinguish service presence from active work; avoid blanket service shutdown or launcher removal.
- [ ] P11.4: If justified, suspend only measured unused activity through existing lifecycle mechanisms, with explicit ownership and restoration.
- [ ] P11.5: Verify restoration on normal STOP, automatic standby, startup error, network failure and restart; preserve settings and requested camera/tool functions.
- [ ] P11.6: Compare task CPU, cache/memory traffic, audio/touch quality and reactivation latency; close unused candidates with evidence when no activity is found.

## P12 Preserve hosted GPT Live search and evaluate Mini separately

**Assessment:** hosted `web_search` is already present in GPT-Live defaults and
forwarded into Responses delegation. Reapplying the same configuration adds no
offload. Mini currently exposes a function that invokes Responses through the
device HTTP worker. OpenAI also documents server-executed remote MCP tools for
Realtime, but adopting a remote service is a separate integration decision.
[Defaults][live-settings], [Delegation forwarding][session], [Mini search][search],
[OpenAI Live delegation][live-delegation], [Realtime tools][realtime-tools]

- [x] P12.1: Verify the source configuration and API distinction; classify GPT-Live hosted search as already present.
- [ ] P12.2: Verify baseline session configuration and search completion with bounded answers/sources, cancellation, errors, and no duplicate device request for hosted Live search.
- [ ] P12.3: Measure Mini search-worker CPU/heap, TLS/JSON activity, request count and latency while checking media/UI progress through an intentionally delayed result.
- [ ] P12.4: Implement an offload change only if measurements justify it and its service/feature requirements are within the later authorized scope; otherwise retain the existing worker and document the decision.
- [ ] P12.5: Preserve query/result bounds, one-request policy, timeout, source URLs, interruption/STOP cancellation, late-result suppression, prompt behavior and standby rules.
- [ ] P12.6: Compare like-for-like search workloads within each mode; do not label different models/providers as an equivalent speed comparison.
- [ ] P12.7: Report search-specific benefit separately from ordinary audio performance; close GPT-Live work as already present when verified.

## Quantitative comparison limits

The following calculations establish workload/storage changes only. Actual CPU,
latency, quality, and total memory effects must be recorded per candidate.

| Proposal | Baseline and candidate | Calculated consequence |
| --- | --- | --- |
| P01 | Yielding waits versus completion-driven blocking | Unknown CPU saving until time spent running in waits is measured |
| P02 | 48 to 24 kHz stereo PCM16 I2S | 192,000 to 96,000 bytes/s per direction; AEC remains 16 kHz |
| P03 | Three 512-sample PCM16 planes in PSRAM versus SRAM | 3,072 payload bytes change placement; internal headroom decreases |
| P04 | Every sample versus every fourth sample in three 16 kHz meters | About 48,000 to 12,000 accumulations/s |
| P05 | 100 versus 180/200 ms mouth interval | 10 to about 5.56/5 callbacks/s; actual redraw change unknown |
| P06 | Full 320 by 240 RGB565 transfer at 40 MHz | 153,600 bytes and at least 30.72 ms wire time; dirty-region savings depend on measured area |
| P07 | One versus up to three immediately available compatible packets | Codec work remains per packet; surrounding overhead saving unknown |
| P08 | Immediate playback versus small sample-count priming target | Continuity/latency tradeoff, not AEC/codec CPU removal |
| P09 | One additional descriptor per direction at current format | About 4,800 extra payload bytes including reference storage; 10 ms extra nominal capacity |
| P10 | Existing reuse versus identified remaining allocations/copies | Additional opportunity unknown until tracing |
| P11 | Current activity versus measured optional suspension | Benefit depends on actual active work |
| P12 | Existing hosted Live search versus duplicate configuration | No additional offload from reapplying the existing mechanism |

## Experiment order and integration

- [ ] O01: Finish B01-B18, including P11 activity and P10 allocation audits, before selecting optimization changes.
- [ ] O02: Investigate P01 and P06 for avoidable UI/SPI work; run bounded P03/P04 experiments individually.
- [ ] O03: Evaluate P02 as a complete pipeline variant with full acoustic and settings coverage.
- [ ] O04: Proceed with P07/P08/P09 only when measurements identify their corresponding overhead or starvation; recalculate them for any accepted sample-rate change.
- [ ] O05: Evaluate P05 separately as an animation tradeoff; preserve already implemented P10/P12 mechanisms.
- [ ] O06: Keep one conceptual variable per initial comparison. Record failed/rejected variants so later work does not repeat them without new evidence.
- [ ] O07: Integrate accepted candidates incrementally, rerun affected checks, and compare the final combination with the original frozen baseline.
- [ ] O08: Check interactions among SPI blocking/redraw, meter/mouth changes, memory placement/DMA, and sample rate/pitch/buffering/reference alignment.
- [ ] O09: Re-rank remaining work using measured limiting resources; record why any proposal is deferred, rejected, or already present.

## Regression and device acceptance

Passing software tests is necessary but does not establish acoustic quality or
absence of every regression. Cover both providers and interruption settings,
with required features enabled. Changing or disabling a required feature is a
functional tradeoff and must be identified as such.

- [ ] V01: Record the complete firmware test inventory, expected completion markers, and outcomes on the frozen baseline and final R14 candidate.
- [ ] V02: Preserve delayed-AEC regression coverage: independent I2S advances while DSP is held; every paired input/reference sample and encoder-sized output read remains ordered through FIFO wraps and cached tails.
- [ ] V03: Retain meaningful sanitizer coverage and test boundaries/relationships rather than source-literal constants or text fragments.
- [ ] V04: Verify GPT-Live and Mini startup, negotiated/echoed configuration, saved prompt behavior on the first audio turn, and microphone gating before startup validation completes.
- [ ] V05: Verify saved mode, independent voices, every supported pitch value, style, backend/reasoning, volume, interruption and standby options without migrations or persistence changes.
- [ ] V06: Verify mute/unmute acknowledgments, input gates, quiesce, continuous silent clocks during close, cleanup failure, remote-close diagnostics, and replacement-session isolation.
- [ ] V07: Verify STOP during Wi-Fi wait, initialization, signaling, playback, priming, decode batch, pending search, and repeated start/stop; no late callback may affect a replacement session.
- [ ] V08: Verify GPT-Live automatic standby, backend-work tracking, bounded RAM history and resume, and explicit STOP history clearing; preserve Mini's distinct standby/history behavior.
- [ ] V09: Verify search success/sources, bounded failures/timeouts, cancellation, late-result suppression, and audio/UI progress during delayed HTTP/search work.
- [ ] V10: Verify audio-resource ownership, restoration of amplifier/host audio, timers/tasks stopped before resources are freed, and partial-initialization cleanup.
- [ ] V11: Verify avatar rendering, expressions/effects, drawers, touch/release recovery, camera lifecycle, network settings, BLE/Wi-Fi preference paths, and unchanged required services.
- [ ] V12: Use real microphone/speaker recordings for intelligibility, echo suppression, far-end-only silence/false interruption, near-end-only speech and double talk at matched volume/distance/room conditions.
- [ ] V13: Measure microphone-onset-to-speaker-stop latency separately from server-event-to-local-silence latency; identify capture/VAD/network components rather than conflating them.
- [ ] V14: Measure first-sound, start/close/restart, touch-to-visible and mouth onset/closure latency alongside CPU, continuity and memory results.
- [ ] V15: Run the final combined candidate through a proposed minimum 60-minute representative soak and 50 start/stop cycles; log heap/stack/queue trends and leaks. Extend when failures or variability require it.
- [ ] V16: Repeat final acoustic/device scenarios on the normal production image without diagnostic probes; confirm instrumentation and fixture removal.
- [ ] V17: Restore the agreed normal application after diagnostic sessions and verify normal boot and settings. Record every unresolved limitation explicitly.

Existing regression entry points include [native audio][audio-test],
[pitch streaming][pitch-test], [core/session/tool behavior][core-test],
[Mini behavior][realtime-test], [transport][transport-test],
[HTTP][http-test], [HTTP queue][queue-test], [search][search-test],
[session lifecycle][session-test], [saved options][settings-test],
[UI scheduling][ui-test], and [screen scheduling][screen-test].

### Commands for later execution

Run firmware commands from `firmware/` in the matching environment. These are
checklist commands, not checks performed while writing this plan.

- [ ] C01: `npm test` for the complete firmware Node/native/Python packaging and RFID tests.
- [ ] C02: `npm run check:legacy-names` and `npm run check:architecture`.
- [ ] C03: `npm run check:manifest` with the correct Moddable environment.
- [ ] C04: `npm run test:moddable`; require runtime completion, not just manifest compilation.
- [ ] C05: `npm run test:package-mod`.
- [ ] C06: `npm run smoke:lin` and `npm run smoke:mini-app:lin`.
- [ ] C07: `npm run test:providers` and applicable focused UI/face-render checks for touched components.
- [ ] C08: `npm run lint` and `npm run format`; record existing informational diagnostics accurately.
- [ ] C09: From `web/`, `npm test`, `npm run typecheck`, `npm run check:editor-artifacts`, and `npm run build`.
- [ ] C10: Run applicable `web/` `npm run test:visual` and `npm run test:i18n-visual` with matching generated WASM/editor artifacts when browser/settings/UI behavior is affected.
- [ ] C11: Run affected target builds through named npm scripts; preserve provider/platform boundaries for shared-code changes.
- [ ] C12: Run the relevant device/API probes with explicit startup/progress/result validation, then the acoustic and soak checks above.

Use repository wrappers and their managed output; do not invoke raw Moddable build
commands or supply custom output/target overrides. `test:unit` already includes
the relevant OpenAI suites and Python packaging tests, so avoid unnecessary
duplicate runs. R13 records host-load-related timeouts; if test concurrency must
be reduced, retain the full suite and record the exact concurrency-only change,
failures and final complete result. Do not count an isolated rerun as a full-suite
pass or weaken deadlines to hide a production stall.
[Firmware scripts][firmware-package], [Web scripts][web-package], [CI checks][ci],
[R13 test history][r13], [Repository requirements][agents]

## Device data preservation

These requirements apply to every later probe/test session, not only the final
release. Follow the current repository rules and applicable explicit user
instructions. A historical note about declining backups is not by itself a new
session instruction. [Repository device rules][agents]

- [ ] D01: Before the first write, read/check the live partition layout, matching build table, application bounds, and image identity without exposing device data or credentials.
- [ ] D02: Back up non-application partitions privately outside Git unless the user explicitly declines backups for the applicable session.
- [ ] D03: Write only the validated application BIN at `0x10000`; confirm the actual flash operation respects that boundary.
- [ ] D04: Never erase flash, write the full image at `0x0`, rewrite bootloader/table, or write NVS/xs/storage without a separate explicit instruction permitting that destructive operation.
- [ ] D05: Keep probe settings/instructions and measurement state in RAM; do not reset, migrate, or modify saved preferences.
- [ ] D06: Check safe partition digests/settings behavior after testing. Record unexplained differences as unknown; absence of an explicit NVS flash write does not prove byte-for-byte NVS preservation.
- [ ] D07: Keep private backups, credentials, prompts, and recordings out of Git and public diagnostic output.

## Per proposal result record

Add one completed record for each proposal, including rejected and already-present
items. Link logs/artifacts to their actual local or durable locations; do not place
generated reports or helper files in `gpt-live-package/`.

| Field | Required record |
| --- | --- |
| Proposal and disposition | P01-P12; accepted, already present, rejected, or deferred with reason |
| Baseline identity | Commit/local changes, image hash, toolchain/component identities, manifest and effective configuration |
| Candidate identity | Exact isolated change/parameters and image hash |
| Workload | Mode, interruption, voice/pitch/style/volume, instructions identity, avatar, fixture, network and UI conditions |
| Execution evidence | Exact commands, date, startup/progress/completion markers, exit status, log/artifact location |
| CPU | Per-task/per-core service time and cycles where valid; distinguish wall-clock latency |
| Latency and continuity | p50/p95/p99/max with sample counts; queue samples/ms; lost samples; output shortage duration; acoustic evidence |
| Resources | Internal/PSRAM minima and largest blocks, DMA bytes, stack margins, allocations/copies, retained history/queues |
| Comparison | Baseline and candidate values, absolute delta, relative change, repeated-run variation, instrumentation cost |
| Regression coverage | Unit/native, XS/simulator, hardware, live API, acoustic, visual and soak outcomes separately |
| Decision | Measured benefit, tradeoffs, acceptance margins, unresolved gaps, and rollback reference |

For a cost metric, calculate reduction as
`(baseline - candidate) / baseline * 100%` only when the baseline is nonzero and
the workloads/units are comparable. Report CPU utilization changes in percentage
points as well as relative percentages. Do not add isolated speedup percentages
to predict the combined result. Use **unknown** when no valid measurement exists.

## R14 release completion

All accepted probes, tests, and implementations belong to R14. Record a final
disposition for all twelve proposals; do not force changes for mechanisms already
present or experiments that fail acceptance. Documentation alone does not advance
firmware versions or require rebuilding. [Revision requirements][agents]

- [ ] R01: Finish individual and combined comparisons, required tests, acoustic assessment, and the final proposal-disposition table.
- [ ] R02: Before the first new normal published release build, confirm R14 is still unused. Preserve existing artifacts; stop on conflicting revision contents rather than overwrite them or silently select a different revision.
- [ ] R03: Synchronize firmware/web package and lockfile versions to `2.0.1-r14`, web flash manifests, packager `REVISION`, `GPT-LIVE.txt` filenames/commands, AGENTS revision reference, changelog, and R14 release notes.
- [ ] R04: Record release impact, exact commands/outcomes, tested targets, measured improvements, accepted tradeoffs, rejected candidates, and remaining limitations in English.
- [ ] R05: Run `npm run check:release -- v2.0.1-r14` and the required final lint/format/test checks after the changes they validate.
- [ ] R06: Build the normal integrated release through `npm run build -- --mode=release` from `firmware/`, or `STACKCHAN_TOOLCHAINS=<existing-toolchains> bash build-gpt-live.sh --mode=release` from the root, using the existing toolchain and required environment.
- [ ] R07: Require automatic packaging to succeed and produce both `StackChan-Community-v2.0.1-r14-GPT-Live.bin` and `StackChan-Community-v2.0.1-r14-GPT-Live-app.bin` from the same build under `gpt-live-package/`.
- [ ] R08: Independently verify app equality with the build output and the full-image bytes at `0x10000`; verify full size exactly 16,777,216 bytes, matching bootloader/table/offsets, and `0xFF` in all other bytes.
- [ ] R09: Verify production manifest/ELF/image contain no diagnostic probe, synthetic input clip, or runtime tuning/measurement payload; preserve earlier BIN hashes.
- [ ] R10: Publish only the two validated BINs in the generated package directory; keep `gpt-live-package/` and `firmware/dist/` outside Git and keep reports/checksums/ZIPs/helpers out of that package directory.
- [ ] R11: If device installation is part of the later instruction, use the validated app-only write and data-preservation checklist; verify normal production boot, settings and representative conversation behavior.
- [ ] R12: After validation, create the separate English R14 commit and matching local `v2.0.1-r14` tag; preserve earlier commits/tags and do not move R13 tags.
- [ ] R13: Provide the actual R14 application-update command from `GPT-LIVE.txt` and identify tested versus unknown results. Full installation is a separate data-destructive operation and is not authorized by this plan.
- [ ] R14: Mark completion only when every required task has evidence or an explicit justified non-applicability decision, and accepted implementations satisfy the final regression gates.

## Sources

Repository links identify the implementation and records reviewed. Generated
artifacts are local evidence snapshots and must be regenerated/rechecked for the
selected baseline. Installed SDK locations are expressed through environment
roots so this plan does not encode machine-specific toolchain paths. Remote
implementation comparisons use the reviewed commit where available. Manufacturer
documentation and API documentation establish supported mechanisms, not measured
StackChan performance.

[agents]: AGENTS.md
[firmware-package]: firmware/package.json
[web-package]: web/package.json
[ci]: .github/workflows/build.yml
[r11]: docs/release-notes/v2.0.1-r11.md
[r12]: docs/release-notes/v2.0.1-r12.md
[r12-followup]: docs/release-notes/v2.0.1-r12-ui-4-8ms.md
[r13]: docs/release-notes/v2.0.1-r13.md
[audio]: firmware/host/modules/realtime-conversation/esp32/liveAudio.c
[pitch]: firmware/host/modules/realtime-conversation/esp32/livePitch.c
[native-transport]: firmware/host/modules/realtime-conversation/esp32/transport.c
[opus]: firmware/host/platforms/m5stackchan_cores3/opus-policy.c
[media]: firmware/host/platforms/m5stackchan_cores3/media-scheduler.c
[platform]: firmware/host/platforms/m5stackchan_cores3/manifest.json
[mod]: firmware/mods/examples/openai_live_webrtc/mod.js
[session]: firmware/mods/examples/openai_live_webrtc/session.js
[live-settings]: firmware/host/app/manifest_openai_live_settings.json
[search]: firmware/host/modules/realtime-conversation/web-search.js
[jitome]: firmware/host/modules/ui/components/face/jitome/jitome-face.ts
[jitome-benchmark]: firmware/benchmarks/jitome-face/README.md
[camera]: firmware/host/modules/camera/device/camera.ts
[runtime-camera]: firmware/host/app/runtime-camera.ts
[sdkconfig]: firmware/dist/tmp/esp32/m5stackchan_cores3/release/stack-chan-host/xsProj-esp32s3/sdkconfig
[defines]: firmware/dist/tmp/esp32/m5stackchan_cores3/release/stack-chan-host/mc.defines.h
[audio-test]: firmware/host/modules/realtime-conversation/__tests__/live-audio.test.mjs
[pitch-test]: firmware/host/modules/realtime-conversation/__tests__/live-pitch.test.mjs
[core-test]: firmware/host/modules/realtime-conversation/__tests__/core.test.mjs
[realtime-test]: firmware/host/modules/realtime-conversation/__tests__/realtime.test.mjs
[transport-test]: firmware/host/modules/realtime-conversation/__tests__/transport.test.mjs
[http-test]: firmware/host/modules/realtime-conversation/__tests__/http.test.mjs
[queue-test]: firmware/host/modules/realtime-conversation/__tests__/http-queue.test.mjs
[search-test]: firmware/host/modules/realtime-conversation/__tests__/web-search.test.mjs
[session-test]: firmware/mods/examples/openai_live_webrtc/session.test.mjs
[settings-test]: firmware/mods/examples/openai_live_webrtc/settings.test.mjs
[ui-test]: firmware/host/platforms/m5stackchan_cores3/io-performance.test.mjs
[screen-test]: firmware/host/platforms/m5stackchan_cores3/screen-scheduler.test.mjs
[m5]: https://docs.m5stack.com/en/core/StackChan_Core
[speed]: https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-guides/performance/speed.html
[psram]: https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-guides/external-ram.html
[heap]: https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-reference/system/heap_debug.html
[i2s]: https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/peripherals/i2s.html#how-to-prevent-data-lost
[codec]: https://components.espressif.com/components/espressif/esp_audio_codec/versions/2.5.0/readme
[es7210]: https://github.com/espressif/esp-audio-dev/blob/main/esp_codec_dev/device/es7210/es7210.c
[rtp]: https://www.rfc-editor.org/rfc/rfc7587.html#section-4.1
[sdk-render]: https://github.com/espressif/esp-webrtc-solution/blob/c8650846b512e6e1375e5f78c1c41619b8d645eb/components/av_render/src/av_render.c#L683-L705
[sdk-decoder]: https://github.com/espressif/esp-webrtc-solution/blob/c8650846b512e6e1375e5f78c1c41619b8d645eb/components/av_render/src/audio_decoder.c#L179-L221
[foreign-patch]: https://github.com/j15marti/StackChan-GPT/blob/94906754fd9dd5f2dfb075b99e70e5ac1ddeec49/firmware/patches/xiaozhi-esp32.patch
[foreign-display]: https://github.com/j15marti/StackChan-GPT/blob/94906754fd9dd5f2dfb075b99e70e5ac1ddeec49/firmware/main/hal/board/stackchan_display.cc#L132-L156
[foreign-pcm]: https://github.com/j15marti/StackChan-GPT/blob/94906754fd9dd5f2dfb075b99e70e5ac1ddeec49/firmware/main/hal/openai_protocol.cpp#L1495-L1625
[foreign-release]: https://github.com/j15marti/StackChan-GPT/releases/tag/v1.8.5
[foreign-dma]: https://github.com/78/xiaozhi-esp32/blob/49b4380b3faa0ceadd28a3e78aaf0f311c46c57e/main/audio/audio_codec.h#L15-L16
[live-delegation]: https://developers.openai.com/api/docs/guides/live-delegation#add-hosted-tools
[realtime-tools]: https://developers.openai.com/api/docs/guides/realtime-mcp
