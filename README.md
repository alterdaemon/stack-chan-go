# Stack-chan (community-mod)

[![Build](https://github.com/alterdaemon/stack-chan-mod/actions/workflows/build.yml/badge.svg)](https://github.com/alterdaemon/stack-chan-mod/actions/workflows/build.yml)

A fork of [stack-chan/stack-chan](https://github.com/stack-chan/stack-chan),
originally created by Shinya Ishikawa and the Stack-chan community.

The goal is to provide simple, preconfigured firmware images for a quick start,
optimize performance, and keep the fork up to date and in sync with upstream.

Fork base: upstream 2.0.1, commit `6a8f7553610e5d91770901e76fd93a0c50cfd970`.
The current 2.1.0 series also incorporates upstream 2.1.0.

Current source firmware: **2.1.0-R3**, for **M5StackChan CoreS3**.
The published stable release is **[2.1.0-R2](https://github.com/alterdaemon/stack-chan-mod/releases/tag/v2.1.0-R2)**.
R2 combines the selected R8 16 kHz/FD2 audio profile with local interruption and
search-cancellation fixes.

R3 adds GPT-Realtime 2.1 as the third conversation choice. Both Realtime models
share the saved Realtime voice, web search and interruption controls. Model
selection takes effect on the next manual start.
With Interruption On, both Realtime models use far-field input filtering before
server VAD and verify it before enabling microphone input.

## What this fork adds

Compared with upstream **2.1.0**, the current CoreS3 firmware adds:

| Area | What you get |
| --- | --- |
| Installation | Full and app-only BINs with chat MODs preconfigured. No local build needed. |
| Voice chat | Built-in GPT-Live 1, GPT-Realtime 2.1 Mini and GPT-Realtime 2.1, started with the LIVE button. |
| Settings | Bluetooth (BLE) or a password-protected Wi-Fi settings page. |
| Voice controls | Saved voices, pitch, speaking style and optional interruption while the robot speaks. |
| Conversation resume | GPT-Live idle standby with recent conversation memory. |
| Web search | Search preconfigured for all three conversation choices. |
| Firmware fixes | Camera memory cleanup, audio/UI scheduling fixes and chat error recovery. |

Add your Wi-Fi credentials and OpenAI API key in Settings to start chatting.

- [Build, install, settings and branch guide](docs/mod/README.md)
- [All fork release notes](CHANGELOG-MOD.md)
- [Test results, performance evidence and limits](docs/mod/validation.md)
- [Contributing](CONTRIBUTING.md)
- [Fork releases](https://github.com/alterdaemon/stack-chan-mod/releases)
- [Fork issues](https://github.com/alterdaemon/stack-chan-mod/issues)

## Upstream resources

[Original project](https://github.com/stack-chan/stack-chan) ·
[Firmware development](firmware/README.md) · [MOD development](firmware/mods/README.md) ·
[Hardware cases](case/README.md) · [Schematics](schematics/README.md)

The retained [upstream release notes](docs/release-notes/) and
[upstream release policy](docs/operations/release-flow.md) describe the original
project. The [upstream browser tools](https://stack-chan.github.io/stack-chan/web/)
and installer serve upstream firmware. Use this fork's guide for Community images.

## License and attribution

Upstream history, credits and licenses are retained. See [LICENSE](LICENSE)
and the provenance/license files beside third-party drivers and assets.
