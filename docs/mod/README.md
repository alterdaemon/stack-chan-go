# Stack-chan Community fork

[Repository](https://github.com/alterdaemon/stack-chan-mod) ·
[Changelog](../../CHANGELOG-MOD.md) · [Validation](validation.md)

Current product version: **2.1.0-R2**. Standard hardware: M5StackChan CoreS3.
The published stable release remains R1; the maintainer has physically verified
the local R2 build and confirmed it is working.

The goal is to provide simple, preconfigured firmware images for a quick start,
optimize performance, and keep the fork up to date and in sync with upstream.

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
  currently `v2.0.1-r15` and `v2.1.0-R1`. Tags identify release builds;
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

With **Interruption Off**, microphone samples are gated during playback and until
the existing 500 ms received-silence gate clears: voice interruption is unavailable.
On keeps capture and AEC active. Explicit microphone mute remains separate.
Live caption delivery can lag speech; event-to-PCM-silence timing does not prove
physical speech-onset latency. On 2026-11-12, the maintainer confirmed physical
verification of the amended R2 is complete and it is working. This confirmation
is separate from unit-test results. Historical
combined-profile measurements and their limits are in [validation](validation.md#r2-selected-r8-profile-promotion).

The local R2 pair is `StackChan-Community-v2.1.0-R2-app.bin` and
`StackChan-Community-v2.1.0-R2.bin`. Preserve supported-layout settings by writing
only the application:

```sh
esptool --chip esp32s3 --no-stub -p /dev/ttyACM0 -b 115200 write_flash -z 0x10000 StackChan-Community-v2.1.0-R2-app.bin
```

Full installation resets settings, MODs and storage:

```sh
esptool --chip esp32s3 --no-stub -p /dev/ttyACM0 -b 115200 write_flash -z 0x0 StackChan-Community-v2.1.0-R2.bin
```

Use your device port: Linux `/dev/ttyACM0` or `/dev/ttyUSB0`, Windows `COM3`, macOS
`/dev/cu.*`. See [esptool setup](https://docs.espressif.com/projects/esptool/en/latest/esp32s3/installation.html).
Do not write the full image at `0x10000`. R2 has not been published.

## Install the published R1

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

OpenAI settings apply on the next LIVE start. Both modes share credentials,
context, volume and local Pitch/Style; voices are saved independently.
Auto disconnect applies only to GPT-Live. Mini stays connected during silence
and uses the backend model/effort for its `search_web` Responses call.
Repository cleanup does not rewrite saved preferences.
