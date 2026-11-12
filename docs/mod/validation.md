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

## Local project workspace and upstream agent instructions

On 2026-11-11, the existing implementation checkout moved intact into the local
workspace's `codebase/` directory. All 2,018 tracked Git paths were preserved;
the implementation repository does not contain a new `codebase/` prefix.
Its Git configuration, historical refs and all 27 existing private BIN hashes
were preserved. Governance and OpenSpec use separate local Git repositories.

The modified fork `AGENTS.md` was archived before restoring the implementation
copy byte-for-byte from upstream 2.1.0, commit
`b050a44592ab847f0f4c2ceb6eb350a02bcb609a`, blob
`b63884ca79d588e2a1e3f1f584ce334596a802fd`. The workspace-root instructions were
reconstructed from the archived modified file, with the coding template's
universal sections unchanged. Release impact: none.

| Local/static check | Result |
| --- | --- |
| Workspace `python3 internal/scripts/check_project_contract.py` | Passed; three independent Git roots and generated OpenCode adapters |
| `openspec validate --specs --strict --no-interactive` from the workspace | Eight accepted specs passed; requirements, archives and reconstruction audits unchanged |
| `npm run test:release-package` from `codebase/firmware/` | Nine tests passed |
| `npm run check:release -- v2.1.0-R1` from `codebase/firmware/` | Passed |
| `node scripts/mod/build-wifi-settings.mjs` from `codebase/firmware/` | Typecheck/build passed; 13 routes packed through the private artifact link; large-chunk warning retained |
| `npm run check:manifest` with the existing SDK environment | All six target preflights passed; SDK deprecation warnings retained |
| Settings and diagnostic path audit | All 13 Settings resources and ten existing diagnostic mappings resolve to the same private storage |
| Instruction provenance, Git ownership, upstream blob and whitespace checks | Passed |

The ignored local `codebase/internal -> ../internal` link preserves existing
artifact paths without changing tracked tooling or CI. Six legacy diagnostic
references still lack three fixtures: `probe-input.pcm`, `probe-opus.dat` and
`https-fixture.dat`. Their physical destinations are identical before and after
relocation; the fixtures were not regenerated or used by these checks.

The old firmware build output contained absolute paths to the previous checkout
location. All 26,953 generated files/links were privately archived and verified
before leaving the standard `firmware/dist/` directory empty for the next build.
Other standard dependency/test-output paths remain in place. Firmware source,
versions, release tags and published assets are unchanged. No firmware rebuild,
device write, device/live-API test or GitHub push/publication was performed.

## Production interruption repair: 2.1.0-R2

The production fix adds peer-owned renderer flush and audio-owner discard/Pitch reset, Mini speech-start/output-clear invalidation, timestamp-aware Live caller-turn invalidation, terminal interrupted tool results and a 0.5 Mini VAD default. A native ASan/UBSan fixture runs the actual audio task concurrently with a blocked renderer and delayed peer flush: capture advances, old output becomes zero, late old PCM stays suppressed and a fresh response resumes. Startup without a renderer, Off, mute and shutdown are checked. The native Pitch fixture checks cached and partially consumed input reset. Protocol tests cover paired-event deduplication, stale output-clear/caller fragments, next-turn recovery, idle-cancel errors, tool-result uniqueness and 0.3/0.5/semantic policy negotiation. The policies are not an acoustic false-trigger comparison.

Four protocol negative controls use the frozen R1 core at 1b632ba1 with the new behavior fixtures; all four fail as expected. Final local validation: npm run test:unit passed 703 Node/native tests and nine packaging regressions; npm run lint and npm run format passed (one pre-existing informational lint diagnostic); npm run check:manifest passed all six targets; npm run check:release -- v2.1.0-R2 and the workspace contract check passed. Managed build/image identities follow after execution. The user explicitly owns physical verification: no physical test, device flash or audible playback is performed for this change. Local PCM zeros do not establish physical speaker silence or speech-onset latency. Private logs retain commands and results under internal/work/gpt-full-duplex/r2-*.

For Interruption On, the local PCM stream is reduced from 200 to 100 ms and the vendor render FIFO from 32,768 bytes to 200 ms of mono PCM (19,200 bytes at 48 kHz). Off keeps its original queues. allow_drop_data is enabled only for On; the pinned vendor audio_drop_before_render skips at >=200 ms of queued bytes in sync-none mode. FIFO accounting includes frame overhead, so this is not an end-to-end latency bound or proof the drop threshold will be reached. The native fixture fills the finite stream and blocks its writer, verifies ordinary PCM order, interruption while flush waits seven audio blocks, continued capture, a second interruption, stale-tail suppression and fresh-turn recovery with and without encoded silence. Dropping all audio after an ordinary underrun is not selected: there is no response identity/PTS at that PCM boundary to distinguish a delayed valid word from a cancelled turn. Cancellation alone invalidates the old tail. Physical continuity/overflow quality and acoustic false-trigger comparisons remain unperformed.

Managed R2 build and independent image validation completed from 7a7d859bd29757d539b438fe9172fbff455f7200 (normal main 48 kHz/FD4): application 8,564,800 bytes, SHA-256 741d1c46136504690ef1b52883ddc6d599c64f3edb031bc7512eb58f481cd879; full image 16,777,216 bytes, SHA-256 68c229c76868bb45a4fc6a9845535d1af7124b224d50e94fa399df2c31d08c2f. Build/app/full correspondence, same-build bootloader/table, chip/layout/write bounds, erased gaps, normal integrated modules and diagnostic/credential exclusion passed. Local private provenance includes ELF, effective SDK configuration, flattened manifest, build makefile and flasher offsets. No publication was performed.

The optional XS LIVE-control check initially failed its unchanged opacity predicate. The frozen R1 baseline passed; an R2 rerun with the same predicate and an expanded failure message passed in 12.6 s. The first failure is intermittent and unexplained. The diagnostic-only test message was then reverted; no product/UI source changed. Native/protocol regressions and firmware compilation are separate from this UI result. Experimental parity at 6aa9c966dc95435bad58dd54f400126a32c94af1 passed 723 Node/native tests, nine packaging tests, 49 final protocol checks and both XS startup manifests; the requested rebuilt R8 identity is recorded with its private package. Physical verification remains with the user; no device write, audible playback or new live-API trial was run here.

The repaired normal R8 pair is now installed in the private comparison folder (not flashed to a device). It was built from experimental source 6aa9c966dc95435bad58dd54f400126a32c94af1 with an explicit R8 metadata overlay and 16 kHz/FD2 configuration. App: 8,570,992 bytes, SHA-256 122d3ab92cd09496f80cb1106414dbf181fe478ceaa5d2180b6c9fba1ef8ee43. Full: 16,777,216 bytes, SHA-256 536f535e111a00be6078ae3f63253ae00ab6865084da9720fc7fab4306fa9f80. All 94 exact-overlay focused regressions passed, along with managed build/packaging and independent provenance/layout/bounds/erased-gap/diagnostic-exclusion checks. The prior pair was copied and rehashed before replacement; its app SHA-256 remains 846dbe36ba4ffb0a8637269a408e9849b7b90f44941f3be363dcabcfbe21c907 in the archive. No new benchmark, device run or acoustic acceptance is claimed.


## R2 selected R8 profile promotion

The unpublished 2.1.0-R2 now includes the selected R8 profile: 16 kHz I2S/render/direct Opus/Pitch in both modes and On/Off, FD2 plus temporary 6 dB ADC gain/digital restoration only On, a 200 ms silent-reference tail before bypass, Wi-Fi/LwIP PSRAM allocation and 200 ms On mouth updates (100 ms Off). The Opus rate override is scoped to the chat lease; later non-chat decoders retain their requested rate. Saved settings, web search, task placement and the R2 interruption repair are retained. Other experimental prototypes are excluded.

Local/static validation: `npm run test:unit` passed 705 Node/native tests and nine packaging regressions. This includes delayed native capture/playback, interruption, Pitch, gain-register restoration with partial-operation faults and a decoder before/during/after-session regression. `npm run lint`, `npm run format`, six-target `npm run check:manifest`, `npm run check:release -- v2.1.0-R2` and the workspace contract check passed; lint retains one pre-existing informational diagnostic. The first manifest preflight lacked an activated SDK; rerunning in the SDK environment passed. The capture fixture was corrected to expect bypass when playback is silent, while microphone mute alone leaves playback/AEC active.

XS simulator validation: both startup manifests passed in 9.8 s, including actual Timer mouth cadence/cleanup for On and Off, audio lease/restart, standby and amplifier restoration. The initial runs exposed stale fixture imports and status labels; the fixture now includes the existing web-search module and current Live 1 label. No production search/status logic was changed.

Historical performance evidence, not a new R2 benchmark: `r12-live-on-performance-comparison.json` records the combined 16 kHz profile versus R1 during actual Live On capture/playback and TLS work. AUD_SRC was 61.526% versus 25.322% of one core, decoder 33.234% versus 25.193%, and live_audio 13.772% versus 5.952%; input overruns were 34 versus 0. R1 did not complete the whole capture/search workload, so this is not an equal-completed-work or isolated FD2 benchmark. Neither record qualifies physical distortion or stop latency. This port performs no device write, audible playback or live-API run; physical acceptance remains with the user.

The earlier unpublished R2 pair and provenance were copied and independently rehashed into a private archive before rebuilding. Its original hashes remain recorded above; the amended pair has a separate build identity below. Automatic release/prerelease publishing is removed; Pages deployment is manual and automatic Cloudflare triggers are removed. No remote mutation is part of this work.

Amended R2 build/image verification completed from `d46614edab0690961e6102be76ba389190baf99e`, with no source overlay. App: 8,565,920 bytes, SHA-256 `63334c77f9d3f385f6bec9e5cd9e70fedc64ce72f6e54cefd103a2c050f82e42`. Full: 16,777,216 bytes, SHA-256 `62d59d6a91222164b4fdac48b1083262e4c2e0c40e7b12f0abe6a423d7e969f9`. The managed `npm run build:m5stackchan_cores3 -- --mode=release` produced the pair. Independent byte/layout/sector-bound/erased-gap checks, same-build bootloader/table/app correspondence and esptool checksums/validation hashes passed. Effective SDK configuration enables Wi-Fi/LwIP PSRAM; generated makefile, compiler progress, linked objects and source hashes identify the fixed 16 kHz/FD2 build. The native compiler uses Moddable's makefile rather than the IDF compile-command list. Existing USB diagnostics remain present, as in the prior normal R2; experimental probes/guards are absent. The image retains preconfigured web search and contains no embedded API key in its configured defaults or matching credential pattern. The independent verifier was corrected for the existing no-MD5 partition-table setting and normal USB diagnostics; these were verifier assumptions, with no firmware change.

Six parsed workflow definitions were reviewed: tag CI has read-only permissions and only builds/stores images; Pages deployment jobs require manual dispatch; Cloudflare has no automatic trigger. Fresh GitHub API checks confirmed unchanged remote branch/tag/release state and no R2 release/tag. These publication guards are local until a requested push. The private release plan and notes are prepared; no push, publication, draft or workflow dispatch occurred. Physical quality and interruption acceptance are still unverified by this port. Build evidence is retained privately; no new runtime performance result is claimed.

Cleanup: the task-owned short build worktree, generated build output, compiler cache and simulator scratch directories were removed after retained-file hash checks. Useful runtime/build logs, exact image provenance, the old R2 archive and reusable tests remain. Existing SDK/dependencies, device backups and experimental images were preserved.


R2 maintainer confirmation, 2026-11-12: the maintainer stated that physical verification is complete and the firmware is working. This supersedes the earlier pending-acceptance status. No additional agent-run device test or quantified acoustic/latency measurement is claimed.


R2 publication, 2026-11-12: published the explicitly requested regular Latest release at `https://github.com/alterdaemon/stack-chan-mod/releases/tag/v2.1.0-R2`. The immutable tag points to `42e2790e786ff585c7db8b3eb09c1dcef71e1966`, including the maintainer's confirmation; firmware/web inputs match validated build `d46614ed` exactly. Both uploaded assets were downloaded and their sizes and SHA-256 hashes matched the retained build identity; public release/asset URLs, type, Latest selection and description were verified. GitHub returned no Actions runs or commit checks, so no remote CI pass is claimed. Local validation and the maintainer's physical confirmation are recorded above. R2 description formatting follows the preceding releases; installation text matches R1 apart from BIN filenames, with the same one-line platform-specific PORT explanation added to all three releases. The R2 changelog contains behavior changes only; administrative notes and Unreleased were removed at the user's request. No firmware rebuild, reflash or published-tag move accompanied these documentation edits.

## Realtime echo filtering: R3

2026-11-12. Request `audio.input.noise_reduction` with `type: far_field` and
`strength: 1` for both Realtime models with Interruption On, in both call creation and
startup correction. Keep the microphone muted until the server acknowledges the
filter, instructions and VAD configuration. Retain the 0.5 server-VAD threshold
and genuine voice interruption. [OpenAI's client-event reference](https://developers.openai.com/api/reference/resources/realtime/client-events)
documents input filtering before VAD and its intended reduction of false speech
detections.

Local/static verification: the six selected regression checks failed against the
old implementation as expected. After the patch, all 46 Realtime protocol tests
passed. The focused command below passed all 142 Node test-runner cases, including
the native audio harnesses; the legacy core file also reported its 30 internal
checks passing. Biome check passed for both changed JavaScript files.

```sh
# From firmware/, with TMPDIR and PYTHONPYCACHEPREFIX under workspace internal/:
node --test --test-reporter=spec host/modules/realtime-conversation/__tests__/*.test.mjs mods/examples/openai_live_webrtc/*.test.mjs
./node_modules/.bin/biome check host/modules/realtime-conversation/core.js host/modules/realtime-conversation/__tests__/realtime.test.mjs
```

Browser/live-API controls used the real Conversation core over WebRTC, generated
speech, an archived echo residual and an explicit silent output sink. With the
old code, the two echo-only controls produced one and three false speech starts,
local flushes and server output clears. Diagnostic far-field filtering produced
zero in both repetitions. Two quieter-stop controls mixed speech at -12 dB into
the same echo and each produced one interruption after that speech began, with
no extra interruption. A 0.7-threshold alternative suppressed the echo-only
fixture but its mixed-speech control produced an additional false interruption;
it was not selected.

Final browser/live-API verification exercised the patched Mini core without policy
overrides in four WebRTC sessions. Both echo-only repetitions had zero false
speech starts, local flushes, server output clears or replacement responses.
Both quieter-stop repetitions detected exactly one interruption, 1,309.0 and
1,280.9 ms after the mixture began (speech starts at 1,000 ms), with no extra
interruption. All four sessions retained normal opening/stop/question detection,
acknowledged far-field strength 1 and VAD threshold 0.5, stayed connected, reported
no API errors and completed HTTP 200 hangup. Source hashes, event identities and
automated assertions are retained in the private `fix-verification.json` record.

Scope: the echo fixture is seconds 2-8 of the archived FD2, 30 ms reference-delay,
9 dB microphone-gain component recording, digitally restored before replay.
Current firmware uses 6 dB microphone gain. The quieter-stop mixture is synthetic
post-AEC input, not a physical double-talk recording. These tests establish the
reproduced false-VAD path and the tested filter's behavior, not the exact cause
of the reported physical incident or protection in every acoustic environment.
No device, physical speaker, saved preferences or OpenSpec change was touched.
Initial patch verification built no firmware image and installed nothing.
The requested R2 rebuild was cancelled before image creation or replacement.
The fix is retained in R3. Its protocol/session tests, Biome check of the two
changed JavaScript files and `npm run check:release -- v2.1.0-R3` passed before
committing the fix. Private probe sources, fixture hashes
and event evidence are retained under
`internal/work/realtime-stop-probes-20261112/`.
The workspace contract and whitespace checks passed. The task-downloaded browser
runtime was removed; reusable probes and evidence were retained.


## R3 Realtime model choice

R3 adds GPT-Realtime 2.1 (`gpt-realtime-2.1`) beside Live and Mini. The saved
`realtime` value still selects Mini; `realtime-full` selects the full model and
normalizes to the existing Realtime lifecycle. Both Realtime choices share the
saved Realtime voice, prompt framing/acknowledgement, search, interruption and
cleanup. No native audio implementation or saved settings migration is added.
The source worktree also retains the separately developed input-filter fix above.

Local/static checks on 2026-11-12: `npm run test:unit` from `firmware/` passed
716 tests and nine packaging tests; `npm run lint`, `npm run format`,
`npm run check:manifest` (six targets), and
`npm run check:release -- v2.1.0-R3` passed. From `web/`, `npm run typecheck`,
`npm run test:legacy` (240 passed, two skipped),
`npm run test:react -- --maxWorkers=2` (103 passed) and `npm run build` passed.
The initial web check caught an unsupported test-query typing option, which was
removed. A combined menu test exceeded its five-second deadline under concurrent
load; separate Mini/full cases passed without increasing the timeout.

The managed `npm run build -- --mode=release` passed in a temporary short-path
checkout of source base `59d8566299fbecf4295ffef4557d092552602562` plus the recorded
worktree overlay. The regular path first failed at the SDK shell argument limit.
The successful build rebuilt the embedded Settings page and packaged both BINs.
Independent checks confirmed chip, flash settings, partition entries, bounds,
same-build bootloader/table/app correspondence and unused `0xFF` bytes. Esptool
reported valid checksums/validation hashes. The first independent check wrongly
required a table MD5 record; the effective SDK explicitly disables that record,
as in R2, and the corrected check verifies that configuration and the full table.

| R3 image | Bytes | SHA-256 |
| --- | ---: | --- |
| Application | 8,565,920 | `dfb5f06d79017f4a0cf321cbf20564c139d068f869606f4ebee0a834027121d6` |
| Full | 16,777,216 | `7b1a1b6ba19a1b719e1407ba5aca1b4dd8dd16c02c5ac384b98419ac121c24b3` |

Installable images are in workspace `internal/release-packages/`; source overlay,
compiled module hashes and image evidence are in
`internal/work/r3-realtime-model-choice/`. The image includes the separately
developed local R2 input-filter fix; its source overlay is explicit rather than
represented as a clean commit build.

The two XS startup manifests could not run: `xvfb-run` is missing from this shell,
and the host portal is unavailable. They are NOT RUN. No physical-device or
live-API test of this new option has been performed; local tests and compilation
do not establish better persona adherence or acoustic performance. No device
write, settings change, push, tag or publication occurred.

Cleanup: the task-owned short checkout, compiler cache and simulator scratch
were removed after image/source hash checks. Installable R3 images, build logs,
source overlay and image evidence were retained. Pre-existing work and images
were preserved.


## R3 Live interruption recovery

Scope: amend R3 with Live continuation/overlap recovery, a Live-only 1,500 ms
suppressed-audible-PCM fallback and removal of the inactive vendor-drop flag.
Keep R3's three model choices, Realtime far-field filtering, search, 16 kHz/FD2,
FIFO sizes, Off gating, explicit microphone mute and saved settings.

Before implementation, the three protocol regressions A/B/C and continuous-PCM
native recovery regression all failed on `85c52479`, matching the prior read-only
reproduction (495 continued speech blocks consumed with no audible output).
After the fix, `node --test host/modules/realtime-conversation/__tests__/*.test.mjs`
from `firmware/` passed 108 tests. The native fixture compiles the real audio task
with hardware/RTOS boundaries doubled and address/undefined-behavior sanitizers.
It now checks recovery at 1,500 ms with one audio block of observation tolerance,
reset by a newer interruption, continued Realtime suppression past that cap,
explicit Realtime resume and quiesced silence. Existing flush/capture/Pitch,
late-caller, mute/Off, echo-filter, search and full-model regressions remain.

The current native PCM stream is 3,200 bytes with On and render FIFO 6,400 bytes.
The vendor queue query includes frame headers but excludes each four-byte queue
header, so its reported size cannot reach 6,400 in that FIFO. Its 200 ms drop
condition at 16 kHz mono PCM16 was unreachable. R3 removes the flag and retains
backpressure and explicit cancellation flushing. The earlier R2 record of the
flag being enabled describes historical configuration, not proof it dropped
ordinary backlog; no performance gain is attributed to removing an inactive flag.

The native cap counts consumed audible PCM after flushing, not elapsed wall time
or detected user speech. It can restore continued model output; physical
backchannel, sustained double-talk and stop behavior still need verification.
No physical-device or live-API acceptance is claimed for this change. No device
writes, saved preference changes or audible tests are performed.


Broader local/static verification: `npm run test:unit` passed 719 tests and nine
packaging tests. `npm run lint`, `npm run format`, scoped `biome check`,
`npm run check:manifest` (six targets), `npm run check:release -- v2.1.0-R3`,
project contract and whitespace checks passed. Commands ran from `firmware/`
with the SDK environment for manifest checks and private temporary/cache paths.
XS simulator checks are unavailable because `xvfb-run` is absent; no simulator
pass is claimed. Web source/settings behavior is unchanged; the release wrapper
rebuilds the embedded Settings assets.
