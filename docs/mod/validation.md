# Fork validation record

Historical results consolidated from former fork release notes and the R14
report. These are recorded executions, not tests rerun during documentation
cleanup. The [changelog](../../CHANGELOG-MOD.md) owns revision history;
the [guide](README.md) owns current instructions. Raw logs, credentials and device
backups remain private outside Git.

## 2.1 R1

### Corrected response-conflict build

Correction: `ad5c3e03`; release/validation commit: `6a00bd26`.
On initial production firmware, a passive collector recorded Realtime Off
closing at 779.828 s and `conversation_already_has_active_response` at 782.116 s.
These are collector times. The event ID and retry count were unavailable;
the exact ordering is unknown. Realtime did not arm Live's standby timer.

The correction keeps this error recoverable in both modes/interruption settings.
Mini retries only its pending continuation, waits for an active response and
limits speculative sends to three. It never resends tool output. STOP, speech
interruption and completion cancel obsolete retry timers; unrelated/stale errors
do not revive work. Other errors retain existing handling.

Recorded commands run from `firmware/`:

| Check | Result |
| --- | --- |
| `node --test host/modules/realtime-conversation/__tests__/realtime.test.mjs` | 26 passed; all 16 new cases failed against initial R1 at `49ae3939` |
| `npm run test:unit`, with Node `--test-concurrency=1` | 684 Node/native tests and nine packaging tests passed |
| `npm run lint`, `npm run format`, `npm run check:release -- v2.1.0-R1` | Passed; existing informational test-code lint diagnostic retained |
| `npm run build -- --mode=release` in the short release worktree | Passed; `realtimeConversation/core.xsb` rebuilt |
| Independent image comparison | App, bootloader, table, layout, bounds and unused `0xFF` bytes matched |

Rejected unit-harness startups (`NODE_OPTIONS` concurrency and missing executable
PATH) ran no tests. Compiler/SDK deprecation, font-glyph and C-qualifier warnings
remained in the successful build.

| Image | Bytes | SHA-256 |
| --- | ---: | --- |
| Corrected app | 8,558,992 | `dd5c21d0287fabf093216703401dfe514fceea25d7d997d4f1e9bc3fcf13bcbc` |
| Corrected full | 16,777,216 | `4662384e4c87ac26d613cb825eac72cb150f65c90a7b5fd2a8600de3e675a05f` |
| Archived initial app | 8,558,992 | `b2335bcc4eecf24d88cb3da3ec569302dd96cbf1edcd8f5c3adf99d310e3eddb` |
| Archived initial full | 16,777,216 | `65335a9c2193a3ed42d35c88fe3d72f1c1c69c2e4eca44584b637da87fde5a2c` |

Initial images/build symbols and tag were privately archived before replacement.
On 2026-11-11, the maintainer confirmed that the corrected R1 build was tested
on hardware with the live API and is working. This runtime confirmation is
separate from the automated results above. Earlier forced-playback probes did
not reproduce extended natural silence.

### Initial R1 qualification

[Sanitized record](performance/v2.1.0-R1.json). Baseline: R15/Moddable 10.0.2;
candidate: R1/10.1.0; both use ESP-IDF 6.1 on the same CoreS3. Final generated
configurations selected QIO, 80 MHz PSRAM, 240 MHz CPU and `-Os`. The early 40 MHz
configuration was excluded. Saved Pitch was +3; final B36 used authorized volume
0 with DSP/I2S/capture/AEC enabled and synthetic microphone input.

| Five-run display / 50-cycle camera comparison | R15 | R1 |
| --- | ---: | ---: |
| Median SPI submissions | 1,857 | 219 |
| Median SPI bytes | 785,816 | 862,532 |
| XS+SPI service normalized to one core | 26.932% | 22.805% |
| Idle free PSRAM | 6,765,996 B | 7,276,976 B |
| Camera stop median | 50.576 ms | 52.144 ms |
| PSRAM recovered per stop | 115,436 B | 115,436 B |

This is 88.2% fewer submissions, 9.8% more bytes and a 4.127-point reduction
in measured task service; it is not whole-chip utilization or acoustic quality.
Camera stop increased by 1.568 ms. Both builds released camera tasks in 50 cycles
and retained readable copied frame data.

Final B36 completed Live On/Off and Mini On/Off for
933.851/919.236/931.619/918.493 s: 360 capture windows, 56 playback checks and
62 drawer exercises, all with zero reported input FIFO overruns. The collector
reported no provider failure, close diagnostic or fatal runtime marker.
Local stops took 1.070–2.474 s. Voice `onIdle` reached 160.870 ms; a twenty-wait
drawer exercise took up to 3.926 s. Live/Mini search completed in 4.065/22.147 s
with sources while capture advanced. Times include network/model execution.
Each On case had a 64-sample difference between capture/encoder snapshot sums;
these counters do not measure network delivery.

B39, using the verified B38 image without another write, passed all four digital
speech checks. Earlier B37 Off input lacked a transcript; requiring 3,000 ms
sustained output idle corrected the fixture. B38 Live On hit its playback deadline
despite capture progress; the cause is unknown. B39 passed with the same image.

Retain these failed variants and harness findings for future investigations:

- Priority-10 Live control stopped accumulating service while media/UI advanced.
  Priority 18 restored the focused playback/control check.
- Decoder on core 0, AEC at 15 and an earlier UI/core arrangement reported
  8/59/65 input FIFO overruns respectively and were rejected.
- HTTPS at 6 sent no body before failure. HTTPS at 7 with AEC at 7 completed
  search but reported 64 overruns. Final capture/HTTPS 8/7 passed Mini search
  continuity checks. Keep the 1,024-slot XS stack and build-profile invalidation.
- B19 watchdog failure occurred at 384.049 s. The heartbeat-before-clock fix
  passed its deterministic regression, but B20 still failed at 100.455 s.
  Later stack/scheduling changes were present in passing B36; that fix alone
  was insufficient.
- Diagnostic records are bounded at 132 per case and buffered until audio stops,
  then printed in paced chunks. Verbose live USB output previously lost data.

Before the amendment, 668 Node/native tests plus nine packager, 11 RFID,
76 architecture and three provider tests passed. Six manifest targets, Avatar
native checks, 240 web legacy tests (two optional skips), 99 React tests,
editor artifacts, web build and both CoreS3 bundle targets passed. A delayed-AEC
fixture timed out during concurrent builds, then passed 20 isolated repetitions
and the serial full suite.

Initial production installation wrote only the app at `0x10000` and verified it
independently. Uncompressed 4 KiB transfers with 4 ms pauses resolved MD5-transfer
failures; their cause is unknown. An early diagnostic accidentally selected the
production preference module and rewrote the same volume value: 35 NVS bytes
changed while 29 active payloads matched. A later PHY refresh had an unknown
trigger. The final audit matched 25 remaining active NVS entries excluding
authorized volume/PHY changes and all protected bytes outside NVS. Normal boot
reached `app behaviors ready`; protected bytes matched across the later smoke.

## 2.0 R10–R13

| Revision | Recorded checks | Limits |
| --- | --- | --- |
| R10 | 580 unit tests plus nine packager; 70 React tests; lint/format, embedded Settings, release and signal-test builds passed | Signal test unexecuted; initial XS startup blocked by D-Bus; no device/API pass |
| R11 | 594 unit tests plus nine; native negative controls, lint/format, release/build/image and ELF checks passed | DSP/RTOS doubles do not establish physical margins; user still reported UI/avatar issues |
| Original R12 | 597 unit tests plus nine; lint/format, release/build/image and normal boot passed | NVS changed; no content backup existed after the user declined one, leaving records/cause unknown |
| R12 4/8 ms amendment | Release build and both images validated | No unit/simulator/device/API execution or installation |
| R13 | Serial unit suite: 612 plus nine; 73 React tests, typecheck, web build, lint/format and release checks passed | Earlier parallel timeouts passed in isolated/final serial runs |

R11's native fixture holds AEC for 100 ms of virtual time while checking I2S,
every paired sample, FIFO wraps, timestamps, mute and stop/restart across all
Pitch/interruption settings. Historical controls detect shared-I2S DSP blocking
and the priority-3 worker dropping a fourth 32 ms frame. Earlier user checks
confirmed interruption with severe UI lag for synchronous priority-20 AEC,
then playback stuttering after lowering priority in that same task.

Original R12 observed a 2,855.095 ms control UI gap and 159.432 ms with 8/12 ms
windows. The longer selected-policy call reached 427.538 ms, with zero capture
overruns and 11.215/11.427 ms maximum I2S write/read gaps. Digital input,
standby and six-fragment resume worked. Profiles ran sequentially under different
remote workloads. The later 4/8 ms build cannot inherit these results. Stable
commit `82eb5d45` and `*-GPT-Live-stable*.bin` images remain preserved.

R13's final Mini On/Off/search/cancel collector reached `done`, HTTP 200 and sources
with zero input overruns, including delayed-result checks. On/Off maximum UI gaps
were 1,555.088/536.027 ms and output-underrun counters 324/1. Some hangups were
unconfirmed. Earlier priority-19/high-priority-HTTP candidates lost input;
core-0 HTTPS below Mini AEC restored the measured continuity checks.

The R13 prompt amendment's Off-only probe passed ten Live/Mini/persona/marker
results. Both Mini sessions acknowledged all 1,135 instruction characters and
produced sarcastic first responses; tone intensity was not constant. Model-side
cause was unknown. A search probe completed cited audio without a jab. Extra
prompt copies, examples and higher reasoning were not retained. Saved settings
were unchanged; Unicode instructions survived restarts without accumulating
framing. No post-amendment On probe ran after the Off-only request.

Amended R13 app SHA-256:
`6b913df30fb3ee5a3cbab92703742e35b9547bdee7531c64445890bb9023488d`;
full: `c857e11a4b7c577b648f71531f8044983015bea320c870aa96a7c87f4a850198`.
Images were byte-validated, prior images retained and normal firmware restored
at `0x10000` with verified flash hash/normal boot.

## 2.0 R14

Retained change: completion/capacity SPI waits, level conditions under the mutex
and predicate rechecks. [Provenance and licenses](../../firmware/host/platforms/m5stackchan_cores3/spi/UPSTREAM.md)
remain beside the driver. Fifteen display pairs measured 4.388% median main+SPI
CPU-service reduction (range −3.722% to +11.818%, 13/15 positive).
Normal-image CPU consumption was not measured.

| Proposal | Decision and measured limit |
| --- | --- |
| P01 SPI waits | Retained; measured UI task-service benefit, without whole-device/audio claims |
| P02 24/48 kHz | Keep 48 kHz. Opus task-sum saving was only 0.914 points of one core; representative acoustic/provider equivalence unproven |
| P03 SRAM/PSRAM | Keep PSRAM. Five pairs saved 2.548% median capture service at about 3 KB internal headroom cost; TLS peaks unmeasured |
| P04 Meter work | Keep exact statistics. Striding missed a 2 kHz fixture; less frequent scans missed a one-block impulse |
| P05 Mouth interval | Keep current timing. Slower updates saved work by dropping visual updates; speech lip timing unvalidated |
| P06 Dirty redraw | Preserve existing dirty updates: 626,400 versus 9,216,000 SPI bytes for the same 60 changes |
| P07 Packet batches | Keep per-packet processing: identical decoded/cancel payloads with negligible CPU difference |
| P08 Priming | Keep immediate playback: 48 corrected replays added delay without repeatable continuity gain; focused STOP/replacement preserved tail/hash |
| P09 DMA depth | Keep three descriptors: larger queues absorbed induced 45 ms stalls but cost up to 11,676 B internal memory without a measured natural need |
| P10 Allocations/copies | Preserve ownership/reuse: whole-workload hooks did not isolate an unnecessary copy |
| P11 Camera | Post-stop task work was measured; corrected and separately verified in R15 |
| P12 Search | Keep hosted Live search and bounded Mini worker: sources returned but post-camera capture did not advance |

The LAN TLS fixture served its host self-check but received no CoreS3 request.
The device timed out while encoding advanced. Controlled actual-worker replay
completed/cancelled while playback and encoding progressed, but supplied the
response without TLS. Successful delayed TLS delivery remains unverified.
Host-microphone correlations were weak, uncalibrated playback evidence,
not intelligibility or physical interruption acceptance.

All 50 post-camera start/stop attempts ran: 26 Off cases reached capture/local
inactive state; 24 On cases did not reach capture progress. Fresh Live advanced
to 33,280 samples then stopped increasing in the next 20 s window. Mini advanced
161.151 s without capture overruns. The hour target was not reached. Focused
Live injection confirmed transcripts with 17 overruns. These diagnostic failures
remain failures; equivalent normal-release behavior was unknown.

Initial release checks passed 617 Node/native, nine packager and 11 RFID tests
after AEC reversion, architecture/manifest/provider/package-MOD, native SPI,
Jitome/headless Settings/Live/transport and web/editor/build checks. A React
timeout passed in isolation. Earlier unavailable-Xvfb startup was not execution.
Release/image checks and normal boot passed. Initial NVS differed by 109 bytes,
with only volume changed among decoded values; the cause was unknown. Restoring
that value through Preferences restored effective values. A separate follow-up
audit matched all 458,752 protected bytes. Raw NVS was never flashed.

Open measurement work remains: normal-image whole-device CPU/load baselines,
representative acoustic equivalence and physical interruption/touch latency,
successful delayed TLS delivery, and controlled sustained capture after the
camera fix. Later R1 checks and the maintainer's corrected-R1 confirmation
cover their stated workloads; they do not supply these missing measurements.

All evidence below is sanitized historical data retained unchanged:

- [SPI confirmation](performance/r14-confirmation.json),
  [Mini interruption](performance/r14-mini-barge.json),
  [AEC candidate](performance/r14-aec-candidate.json),
  [toolchain identities](performance/r14-toolchain.json).
- [Meter CPU](performance/r14-complete-meter.json),
  [meter fixtures](performance/r14-complete-meter-fixtures.json),
  [meter analysis](performance/r14-meter-analysis.json).
- [Device series](performance/r14-complete-device.json),
  [focused replay](performance/r14-complete-focused.json),
  [final input/STOP probe](performance/r14-complete-final-probe.json),
  [fresh providers](performance/r14-complete-provider.json),
  [acoustic aggregates](performance/r14-complete-acoustic.json).
- [Release images](performance/r14-release-artifacts.json),
  [initial data audit](performance/r14-device-data.json),
  [follow-up data audit](performance/r14-complete-data-audit.json).

## 2.0 R15

[Device/image record](performance/r15-camera-device.json). Both camera tasks
exited after eight reopen/stop cycles. Two overlapping standalone calls returned
readable 38,400-byte copies after teardown. Internal free memory rose
29,972–30,604 B and PSRAM by 115,436 B after stop. Stop took 38.1–70.5 ms,
median 56.3 ms. Preview rendering and touch-resume markers were observed.

Both API modes advanced samples in short post-camera synthetic-input checks,
with zero capture overruns. Mini logged an unconfirmed hangup. Sustained
stability, acoustic input/output and physical touch latency were not measured.

`npm test` passed 618 unit, nine packaging and 11 RFID tests. Three providers,
lint/format, six manifest targets, release and image checks passed. After app-only
installation and normal boot, all 458,752 protected bytes matched pre-test data.
Private temporary readback/NVS copies were deleted after comparison.

## Diagnostic reproduction

Current diagnostic manifests end in `.test.json`. Build through npm wrappers in
the configured SDK environment. Keep settings/measurement overrides in RAM;
require the preference-write guard and bounded startup/progress/completion
markers. Build/packaging does not flash. Back up protected data before testing.

From `firmware/`, with a nonprivate 16 kHz mono PCM16 fixture at
`../internal/diagnostics/probe-input.pcm`:

```sh
probe=mods/examples/openai_live_webrtc/__tests__/live-performance/r14-complete
python3 "$probe/prepare.py"
python3 "$probe/opus-fixture.py" ../internal/diagnostics/probe-input.pcm ../internal/diagnostics/r14-complete/probe-opus.dat
STACKCHAN_REALTIME_WEBRTC=1 npm run build -- --mode=release --manifest host/app/manifest_openai_r14_complete.test.json
python3 "$probe/validate.py"
```

Measured speech fixture: 71,032 bytes, SHA-256
`46b48a29d7f14a07ca8dc7f7bb1c406fd124ba6cf7e582fd8b6b6a2c709ff41d`.
Opus fixture: 112 packets/5,211 bytes, SHA-256
`5e401a83cf298c0880e5bb49d8996e938b88f39dbead8f4e43434db7ad1302f5`.
Use `scripts/mod/capture-r14-complete.py` and `scripts/mod/analyze-r14-complete.py`
for R14/camera collection and summaries; `scripts/mod/capture-live-probe.py`
selects Live, Realtime or prompt scenarios. Run `--help` for arguments.
Restore normal firmware and audit protected data after a device session.

## Repository cleanup

Release impact: none. Documentation, release extraction, fork-tool paths,
test text and branch/CI configuration are reorganized without changing production
firmware or existing images. Verification on 2026-11-11:

Packaging commands below use their current names after the release-tool rename.

| Command/check | Result |
| --- | --- |
| `node --test scripts/lib/release-validation.test.mjs scripts/lib/firmware-command.test.mjs scripts/lib/firmware-bundle.test.mjs` from `firmware/` | 29 passed |
| `npm run test:release-package` from `firmware/` | Nine passed after tool relocation |
| `node --test --test-concurrency=1 mods/examples/openai_live_webrtc/session.test.mjs mods/examples/openai_live_webrtc/settings.test.mjs host/modules/realtime-conversation/__tests__/realtime.test.mjs` from `firmware/` | 65 passed with English prompts and retained Unicode coverage |
| `npx tsc --project tsconfig.test.json`, then `node --test dist-tests/host/modules/preferences/openai-live-options.test.js` from `firmware/` | Compilation and four tests passed |
| `node scripts/mod/build-wifi-settings.mjs` from `firmware/` | Typecheck and embedded Settings build passed; 13 routes packed; existing large-chunk warning retained |
| `npm run lint` and `npm run format` from `firmware/` | Passed across 969 files; existing informational connectivity-test constructor finding retained |
| `npm run check:release -- v2.1.0-R1` from `firmware/` | Passed with consolidated notes |
| Extract every revision with `releaseNotesForTag`; compare publication CLI `--notes` output | All 16 revision sections passed; output contains only the requested notes |
| Parse all four changed workflows; check active branch filters | YAML passed; no active `develop` filter |
| Local Markdown destinations/anchors | 69 checked, no missing targets |
| Moved Python collectors/packager/analyzer `--help`, `bash -n` and fake-SDK/npm wrapper smoke | Passed without device access or compiling firmware |

Before/after SHA-256 comparisons preserved all 27 existing BINs, all 17 JSON
measurement records and both annotated release-tag objects. Production sources
and versions are unchanged; only five test/diagnostic prompt files and the
packaging-test npm path changed within the audited firmware/web trees. The
retained upstream release notes match upstream commit `b050a445` byte-for-byte.

Five detached worktrees were archived in full outside Git, including uncommitted
and generated files, with HEAD/status/diff metadata. Their registrations were
removed; only the main worktree remains. No new firmware build, device write,
device test, live API test or GitHub publication was performed for this cleanup.

## Internal artifact storage

On 2026-11-11, fork scratch work, GPT-Live packages, generated Settings/R14
assets, Python caches and private cleanup/tag archives moved under ignored
`internal/`. All 27 BIN SHA-256 values and both release-tag objects were preserved.
The cleanup archive was compressed and compared file-by-file before deleting its
old copy. No tracked source file, shared build directory or dependency directory
was moved. Standard upstream build paths remain unchanged.

`npm run test:release-package` passed nine tests with its bytecode cache under
`internal/`. The embedded Settings build passed and packed 13 routes at the new
path. All 13 generated resource files and ten generated R14 source mappings
resolved. Python syntax, release YAML, Git exclusions, firmware lint/format and
`npm run check:release -- v2.1.0-R1` passed. `npm run check:manifest` passed all
six targets after activating the existing SDK paths; the earlier attempts
failed on missing mcconfig or IDF/FONTBM environment settings. No toolchain files
were changed. This relocation did not rebuild or flash firmware or run device/API
tests. Future generated inputs, logs and backups follow the rules in `AGENTS.md`.

A follow-up artifact audit on 2026-11-11 found no untracked, nonignored files and
no additional ad hoc fork artifacts requiring relocation. The remaining ignored
directories are `internal/`, standard build/test outputs and installed dependencies.
Upstream already defines `web/avatar-dsl/.test-output/` and its output-producing
acceptance test. The 17 retained fork measurement JSON files total 213,408 bytes
and remain published validation evidence. Agent instructions now explicitly
distinguish ad hoc artifacts from tool-managed outputs and reusable source/tests.

## Release package names and installation modes

On 2026-11-11, the R15 and corrected R1 full/app pairs were renamed to
`StackChan-Community-v<version>.bin` and `StackChan-Community-v<version>-app.bin`
under ignored `internal/release-packages/`. The other 23 images retain their
original names under `internal/archives/legacy-release-packages/`. SHA-256
comparisons preserved all 27 images; release tags and firmware bytes are unchanged.

Installed esptool 5.6.0 CLI help and `write_flash`/`get_bytes` implementation
confirmed whole-file writes at the destination address, without a CLI input-range
selector. Both actual release pairs passed image checksum/digest inspection,
tag-specific partition validation and byte comparison of the app inside the full
image. All protected data regions in the full images contain `0xFF`. App-only
sector ranges are `[0x10000, 0x830000)` for R15 and `[0x10000, 0x83a000)` for R1,
with no protected-partition overlap. Either full image at `0x10000` would extend
to `0x1010000`, beyond the 16 MiB flash, and is rejected as an app update.

Nine packaging tests passed, including the real CLI default output/name contract
and existing overwrite protection. Workflow YAML, firmware lint/format and
`check:release -- v2.1.0-R1` passed. No firmware rebuild, device access or flash
write was performed. One downloadable full BIN is technically sufficient only
with a separate validated app-extraction step; the two BINs retain direct full
installation and app-only update commands.

Build and packaging tools now use `build-firmware.sh`, `package-release.py`,
`test_package_release.py` and `npm run test:release-package`. On 2026-11-11,
nine packaging tests and 15 firmware-command tests passed after renaming.
Mock-toolchain wrapper checks verified release/debug argument forwarding,
environment setup and propagation of a failed build's exit status. Shell syntax,
firmware lint/format and `check:release -- v2.1.0-R1` passed. The build and
packaging script contents are unchanged; no firmware was rebuilt or flashed.
