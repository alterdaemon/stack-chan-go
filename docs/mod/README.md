# Stack-chan Community fork

[Repository](https://github.com/alterdaemon/stack-chan-mod) ·
[Changelog](../../CHANGELOG-MOD.md) · [Validation](validation.md)

Current product version: **2.1.0-R1**. Standard hardware: M5StackChan CoreS3.
This fork adds integrated GPT-Live/GPT-Realtime Mini, Wi-Fi Settings and the
changes recorded in the changelog. Upstream is
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

The release workflow extracts the exact version section from `CHANGELOG-MOD.md`.
The application descriptor keeps the independent Moddable/host API compatibility
version used by MOD loading.

## Install

Current files are in the ignored `internal/release-packages/` directory.
Run from the repository root and replace `/dev/ttyACM0` with the device port.
The corrected R1 build passed offline/build checks; its hardware/API behavior
has not been tested. See [validation](validation.md#21-r1).

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
