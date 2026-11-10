# AGENTS.md

This file provides repository-wide guidance for coding agents working in this repository.

## Project Overview

This repository is stackchan-community-mod, a fork of https://github.com/stack-chan/stack-chan
from v2.0.1 (6a8f7553610e5d91770901e76fd93a0c50cfd970). Preserve upstream history
and attribution. Keep fork changes in subsequent English commits and document them
in CHANGELOG-MOD.md. Revision R<N> uses product version 2.0.1-r<N> and tag
v2.0.1-r<N>; synchronize firmware/web package and lockfile versions, web flash
manifests, release notes and GPT-Live package filenames when advancing a revision.

Stack-chan is a JavaScript-driven M5Stack-embedded robot. The codebase is primarily TypeScript/JavaScript built on the Moddable SDK platform for ESP32 microcontrollers.

## Working Principles

- Keep changes surgical and proportional to the request. Reuse existing mechanisms; add abstractions, background work or persistence only when needed.
- Preserve existing features, saved settings and performance fixes outside the requested scope.
- Review earlier attempts and their recorded outcomes before retrying an approach. For concurrency changes, verify progress and data continuity while work is delayed; compilation and configuration checks alone are insufficient. Match measurements to the reported symptom; timing counters alone do not establish end-to-end output quality.
- Bound buffers, queues and retained history. Keep expensive or blocking work off UI and audio timing paths; explicitly stop session tasks and timers before releasing their resources.
- Verify material claims against source code, generated artifacts, test logs or primary documentation. Distinguish inference from verified behavior; report unverified results as unknown.
- Distinguish successful compilation, simulator execution, physical-device tests and live API tests. Record actual commands, outcomes and remaining verification in release notes; do not repeat passing checks unless changes or unresolved failures justify it.
- Confirm test startup and progress. Keep measurements low-overhead and batch comparable parameter variants when possible. Fail promptly if a harness never starts; building or flashing is not test execution.
- Documentation-only changes do not advance the firmware revision or require rebuilding firmware.

### Embedded Performance

- Start from a known working baseline and compare small variants under equivalent workloads with required features enabled. A faster result obtained by disabling a required feature is a functional tradeoff, not an equivalent optimization.
- Identify the limiting resource before tuning: CPU time per task/core, memory capacity or bandwidth, peripheral I/O, or network delivery. Wall-clock duration includes preemption and waiting; it does not establish CPU utilization.
- Check effective generated configuration, compiler flags, linked library versions and image metadata rather than relying on defaults or README claims. Use manufacturer documentation for the actual chip and SDK version; treat upstream benchmarks as evidence only for their stated conditions.
- Prefer reducing measured hot-path work: busy polling, repeated allocation/copying, unnecessary format conversion and redraws. Use completion-driven synchronization with bounded callbacks. Priority, affinity and buffer changes redistribute service time or latency; verify dependencies and progress instead of treating them as added processing capacity.
- Choose SRAM, PSRAM, IRAM and stack placement using measured access cost and available headroom. Check DMA capabilities, stack high-water use and contiguous allocation requirements. More free internal memory alone does not establish faster execution.
- Evaluate vendor options such as performance-oriented compiler optimization, IRAM placement, cache and DMA configuration against measurements and hardware constraints. Compiler flags do not recompile prebuilt libraries. For streaming changes, account for buffering latency and preserve sample order, timestamps, reference alignment and cancellation.

Espressif references: [speed optimization and profiling](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/performance/speed.html), [external RAM](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/external-ram.html), [I2S and DMA sizing](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/peripherals/i2s.html). Select the documentation version matching the toolchain in use.

## Core Architecture

### Modular Component System
- **Host Program**: Core firmware (`firmware/host/app/main.ts`) that provides the robot framework
- **MODs**: User applications that extend functionality (in `firmware/mods/` directory)
- **Drivers**: Hardware abstraction for different servo types (PWM, DYNAMIXEL, RS30X, SCServo)
- **UI modules**: Piu Application, views, drawer, status bar, bubbles, effects, and face components under `firmware/host/modules/ui`
- **TTS Engines**: Text-to-speech providers (local, remote, VoiceVox, ElevenLabs, OpenAI)
- **Services**: Background services (HTTP server, network, preferences)

### Key Directories
- `firmware/host/`: Core firmware source code
- `firmware/mods/`: Modular applications that can be loaded at runtime
- tests: Co-located under the target `firmware/host`, `firmware/mods`, or platform implementation
- `firmware/typings/`: TypeScript definitions for the Moddable platform
- `firmware/dist/`: Generated firmware programs and intermediate build files; do not edit or commit them
- `case/`: 3D printable robot case files
- `schematics/`: PCB designs for control boards

## Development Commands

All commands should be run from the `firmware/` directory:

### Setup and Installation
- `npm run setup` - Set up ModdableSDK and ESP-IDF using xs-dev
- `npm run setup -- --device=esp32` - Additional ESP32 setup
- `npm run doctor` - Check development environment status

### Building and Deployment
- `npm run build` - Build firmware for M5StackChan CoreS3 (default target)
- `npm run deploy` - Build and flash firmware to connected device
- `npm run debug` - Build and flash with debug mode
- `npm run mod` - Flash a MOD to already-deployed firmware (fast development cycle)
- `npm run bundle` - Create a bundle of the firmware
- `npm run clean` - Remove generated files under `firmware/dist`

### Firmware Build Output Contract

- Use the repository npm scripts instead of invoking `mcconfig`, `mcrun`, or `mcpack` directly. The wrappers supply the managed Moddable `-o` argument.
- Normal host, MOD, and test builds write programs to `firmware/dist/bin/` and intermediate files to `firmware/dist/tmp/`.
- The host application name is always `stack-chan-host`.
- Do not add a custom `-o`; repository commands reject it to keep worktree output isolated under `firmware/dist`.
- `npm run clean` removes all generated files under `firmware/dist`.
- `npm run bundle` builds every release target under `firmware/dist/`, stages validated target artifacts in `firmware/dist/bundle-targets/`, and writes the assembled directory and ZIP under `firmware/host/app/`.
- The named `npm run build:release:<target>` scripts and `npm run bundle:package` are the CI building blocks for parallel target builds and final artifact assembly.
- `npm run mod` uses `mcrun -t build` to create an archive, then discovers and writes the live device's `xs` partition with `esptool`.

### GPT-Live Builds and Published Updates

- The default M5StackChan CoreS3 target includes GPT-Live through `firmware/host/app/manifest_openai_live_integrated.json`. Read `GPT-LIVE.txt` for the current build, package name, and installation command.
- Build a release from `firmware/` in the activated Moddable / ESP-IDF environment with `ESP_WEBRTC_SOLUTION` set, `esptool` available to `python3`, and `xtensa-esp-elf-nm` on `PATH`:

  ```sh
  npm run build -- --mode=release
  ```

- Alternatively, from the repository root, use the existing toolchain wrapper:

  ```sh
  STACKCHAN_TOOLCHAINS=/path/to/toolchains bash build-gpt-live.sh --mode=release
  ```

  The toolchain directory contains `moddable`, `esp-idf`, `idf-tools`, `esp-webrtc-solution`, and `fontbm`. Use the existing installation; keep machine-specific paths out of tracked files.
- Both release build commands automatically run `firmware/scripts/package-gpt-live-update.py` after a successful integrated GPT-Live build. A packaging failure fails the build command. Debug, instrument, other-device and alternate-manifest builds do not publish GPT-Live images. To package an existing release without rebuilding, run from the repository root in the same toolchain environment:

  ```sh
  python3 firmware/scripts/package-gpt-live-update.py
  ```

- Keep all installable GPT-Live builds in the single repository-root directory `gpt-live-package/`. Use the packager's default output directory. Do not create revision-specific directories such as `gpt-live-update-r3/`, publish installation files under `/tmp`, or create ad hoc installer scripts.
- Every new published revision must contain BOTH `StackChan-Community-v<version>-GPT-Live.bin` (full 16 MiB flash image) and `StackChan-Community-v<version>-GPT-Live-app.bin` (application only), produced from the same release build. Never publish only the application. The full image contains the build's bootloader, partition table and application, with all remaining bytes set to `0xFF`; it resets NVS, xs and storage.
- Use the next unused revision for a new firmware update; the current update is `r13`, so the next update starts at `r14`. Before building, update `REVISION` in `firmware/scripts/package-gpt-live-update.py`, both filenames and installation commands in `GPT-LIVE.txt`, and this revision reference. Preserve earlier revision BINs. The packager rejects different contents under an existing revision; repeating an identical package is allowed.
- Publish only the two validated BINs. Do not add generated reports, checksum files, ZIPs, or helper installation files. Verify that the application BIN matches the newly built `firmware/dist/bin/esp32/m5stackchan_cores3/release/stack-chan-host/xs_esp32.bin` and the application bytes at `0x10000` in the full image. Verify the full image is exactly 16 MiB and its bootloader and partition table match the same build.
- Give the user the direct `esptool` command from `GPT-LIVE.txt`, with the actual revision filename under `gpt-live-package/`: full installation writes the full BIN at `0x0` and resets data; application update writes the app BIN at `0x10000` and preserves other partitions on the supported layout. The address is the destination in device flash, not an offset into the input file: never write the full BIN at `0x10000`. The packager validates offsets against `firmware/host/app/gpt-live-layout.json` and the build's `flasher_args.json`. Build and packaging do not flash the device.
- Device tests and firmware updates must preserve all existing user data and saved settings. Flash only the validated application BIN at `0x10000`, after checking the device layout and image bounds. Never erase flash, install the full image, rewrite the bootloader/partition table or write NVS, xs or storage without a separate explicit user instruction permitting that data-destructive operation. Do not use a deployment wrapper unless its actual writes satisfy this restriction.
- Before the first device write in a test session, back up non-application partitions privately outside Git unless the user explicitly declines backups. Diagnostic firmware must keep measurement state in RAM and must not reset, migrate or modify saved preferences. Never print secrets from device data or backups.
- `gpt-live-package/` and `firmware/dist/` are generated output and stay outside Git.
- Finish each firmware revision with relevant tests, lint/format checks, `npm run check:release -- v<version>`, and the release build and image validation described above. After validation, create a separate English commit and matching local version tag. Preserve earlier revision commits, tags and artifacts.

### Code Quality
- `npm run lint` - Run Biome linter
- `npm run lint:fix` - Auto-fix linting issues
- `npm run format` - Check code formatting with Biome
- `npm run format:fix` - Auto-format code

### Device Management
- `npm run scan` - Scan for connected devices
- `npm run erase-flash` - Erase device flash memory

### Documentation and Testing
- `npm run generate-apidoc` - Generate API documentation with TypeDoc

## Target Configuration

The default target is M5StackChan CoreS3. Select other supported hardware through the named npm scripts, for example:

- `npm run build:stackchan_rt`
- `npm run build:takao_core2_sg90`
- `npm run flash:stackchan_rt`
- `npm run flash:takao_core2_sg90`

Do not use `--target` or `npm_config_target`; the firmware command wrapper rejects generic target overrides so that the matching platform and application manifest are selected together.

## MOD Development Workflow

1. Write MOD in `firmware/mods/` with `manifest.json` and `mod.js`
2. From `firmware/`, use `npm run mod -- mods/your-mod/manifest.json` for rapid iteration
3. MODs can add behavior via `onLaunch` and `onContextCreated` hooks

## Hardware Configuration

Configuration is managed through preferences system with these key areas:
- `driver`: Servo motor configuration (type: scservo, dynamixel, pwm, rs30x, none)
- `tts`: Text-to-speech engine selection
- `ui`: Piu UI and face selection
- `wifi`: Network configuration

## Git Hooks

Uses lefthook for pre-commit hooks:
- Automatically runs linting and formatting on staged files
- Install: `npm run install-hook`
- Uninstall: `npm run uninstall-hook`

## Testing Approach

Moddable test modules live under the target implementation with `manifest.test.json`; substantial tests get their own manifest for isolated execution.
Cheap constructor smokes are consolidated into shared manifests (`firmware/host/modules/__tests__/module-smoke`, `firmware/mods/examples/provider-dialogues/__tests__/dialogue-smoke`) because each manifest pays a full mcconfig build.
Node.js unit tests live next to pure helper implementations and run through `npm run test:unit`.
Prefer XS-driven Moddable tests for behavior that touches the platform (Piu, Timer, drivers); keep Node.js tests for pure logic.
Tests must verify observable behavior or relational invariants.

Do not:

- Read production source as text merely to assert exact constants, configuration values, code fragments, or regular-expression matches.
- Add tests that fail on a legitimate implementation-literal change without detecting a behavioral or architectural regression.

It is valid to:

- Parse generated artifacts or manifests and validate their schema.
- Compare independently maintained files or dynamically discovered entries.
- Verify dependency boundaries, completeness, tombstones, and relational invariants.
- Read source when its structure is itself the maintained contract.

If a constraint cannot be tested through behavior or a relational invariant, document the reason next to the source or configuration instead of adding a source-mirroring test.

## Pull Request Review Guidance

When reviewing a pull request:

- Confirm the PR description classifies release impact as `none`, `patch`, `minor`, or `major`
- Check whether user-visible firmware or web changes need a release note or changeset entry
- If no release note or changeset is needed, make sure the review states why
- For docs, CI, repository metadata, case, and schematics changes, verify release impact before requesting a release note or changeset
- Ask for tested targets, hardware-specific behavior, and reproduction or verification details when they affect release risk
