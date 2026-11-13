# stack-chan-go (community-mod)

[![Firmware build](https://github.com/alterdaemon/stack-chan-go/actions/workflows/bundle.yml/badge.svg?branch=main&event=workflow_dispatch)](https://github.com/alterdaemon/stack-chan-go/actions/workflows/bundle.yml?query=branch%3Amain%20event%3Aworkflow_dispatch)

A fork of [stack-chan/stack-chan](https://github.com/stack-chan/stack-chan),
originally created by Shinya Ishikawa and the Stack-chan community.

The goal is to provide simple, preconfigured firmware images for a quick start,
optimize performance, and keep the fork up to date and in sync with upstream.

Fork base: upstream 2.0.1, commit `6a8f7553610e5d91770901e76fd93a0c50cfd970`.
The current 2.1.0 series also incorporates upstream 2.1.0.

Current source firmware: **2.1.0-R5**, for **M5StackChan CoreS3**.
The published stable release is **[2.1.0-R4](https://github.com/alterdaemon/stack-chan-go/releases/tag/v2.1.0-R4)**.
Preconfigured application-only and full BINs are available in that release.

## What this fork adds

Main differences in **2.1.0-R5** compared with upstream **2.1.0**:

| Area | What you get |
| --- | --- |
| Easy installation | Ready-to-use full-install and app-update BINs. App updates preserve settings, MODs and storage on the supported layout. |
| Firmware identity | GO and the full fork version appear on startup; the version also appears beside the address in the robot's startup Settings menu. |
| Voice chat and search | GPT-Live 1, Realtime Mini and GPT-Realtime 2.1, all with web search. Start or stop with LIVE or the drawer. |
| Conversation feedback | Dim/bright green shows ready input and incoming speech; purple shows pending work and cyan shows audible replies. Small head movements accompany longer replies on CoreS3 and can resume after a servo error. |
| Personal settings | Password-protected Wi-Fi Settings and Bluetooth. One AI connection selector, shared instructions and voice controls, with an experimental ChatGPT sign-in flow in R5. |
| Interruption and resume | Enable spoken interruption, with fixes for repeated or stuck replies. Resume Live after idle standby with recent context. |
| Everyday fixes | Fixes for screen/touch handling during chat, camera reopening and recoverable chat errors. |
| USB troubleshooting | Off by default. Enable logs and temporary audio adjustments when needed, without reinstalling firmware or changing saved settings. |

See the [R5 changes](CHANGELOG-MOD.md#210-r5) for the local candidate and the
[published R4 release notes](https://github.com/alterdaemon/stack-chan-go/releases/tag/v2.1.0-R4) for comparison links.

Add your Wi-Fi credentials and OpenAI API key in Settings to start chatting.
R5 also includes an experimental ChatGPT subscription connection; see the
[Wi-Fi sign-in procedure and limits](docs/stack-chan-go-fork/README.md#chatgpt-subscription-in-r5).

- [Build, install, settings and branch guide](docs/stack-chan-go-fork/README.md)
- [All fork release notes](CHANGELOG-MOD.md)
- [Contributing](CONTRIBUTING.md)
- [Fork releases](https://github.com/alterdaemon/stack-chan-go/releases)

## Upstream resources

[Original project](https://github.com/stack-chan/stack-chan) ·
[Firmware development](firmware/README.md) · [MOD development](firmware/mods/README.md) ·
[Hardware cases](case/README.md) · [Schematics](schematics/README.md)

The retained [upstream release notes](docs/release-notes/) and
[upstream release policy](docs/operations/release-flow.md) describe the original
project. The [upstream browser tools](https://stack-chan.github.io/stack-chan/web/)
and installer serve upstream firmware. Use this fork's guide for Community images.

## License and attribution

Fork modifications: Copyright © 2026 [alterdaemon](https://github.com/alterdaemon).

Upstream history, credits and licenses are retained. See [LICENSE](LICENSE)
and the provenance/license files beside third-party drivers and assets.
