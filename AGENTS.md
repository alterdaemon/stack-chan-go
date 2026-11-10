# AGENTS.md

This file provides repository-wide guidance for coding agents working in this repository.

## Project Overview

Stack-chan is a JavaScript-driven M5Stack-embedded robot. The codebase is primarily TypeScript/JavaScript built on the Moddable SDK platform for ESP32 microcontrollers.

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
- Every new published revision must contain BOTH `StackChan-Community-v<version>-GPT-Live-r<N>.bin` (full 16 MiB flash image) and `StackChan-Community-v<version>-GPT-Live-r<N>-app.bin` (application only), produced from the same release build. Never publish only the application. The full image contains the build's bootloader, partition table and application, with all remaining bytes set to `0xFF`; it resets NVS, xs and storage.
- Use the next unused revision for a new firmware update; the current update is `r7`, so the next update starts at `r8`. Before building, update `REVISION` in `firmware/scripts/package-gpt-live-update.py`, both filenames and installation commands in `GPT-LIVE.txt`, and this revision reference. Preserve earlier revision BINs. The packager rejects different contents under an existing revision; repeating an identical package is allowed.
- Publish only the two validated BINs. Do not add generated reports, checksum files, ZIPs, or helper installation files. Verify that the application BIN matches the newly built `firmware/dist/bin/esp32/m5stackchan_cores3/release/stack-chan-host/xs_esp32.bin` and the application bytes at `0x10000` in the full image. Verify the full image is exactly 16 MiB and its bootloader and partition table match the same build.
- Give the user the direct `esptool` command from `GPT-LIVE.txt`, with the actual revision filename under `gpt-live-package/`: full installation writes the full BIN at `0x0` and resets data; application update writes the app BIN at `0x10000` and preserves other partitions on the supported layout. The address is the destination in device flash, not an offset into the input file: never write the full BIN at `0x10000`. The packager validates offsets against `firmware/host/app/gpt-live-layout.json` and the build's `flasher_args.json`. Build and packaging do not flash the device.
- `gpt-live-package/` and `firmware/dist/` are generated output and stay outside Git.

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
