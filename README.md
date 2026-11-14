# stack-chan-go (community-mod)

[![Firmware build](https://github.com/alterdaemon/stack-chan-go/actions/workflows/bundle.yml/badge.svg?branch=main&event=workflow_dispatch)](https://github.com/alterdaemon/stack-chan-go/actions/workflows/bundle.yml?query=branch%3Amain%20event%3Aworkflow_dispatch)

<table>
<tr>
<td width="65%" valign="top">

A fork of [stack-chan/stack-chan](https://github.com/stack-chan/stack-chan),
originally created by Shinya Ishikawa and the Stack-chan community.

The goal is to provide simple, preconfigured firmware images for a quick start,
optimize performance, and keep the fork up to date and in sync with upstream.

Firmware: **2.1.0-R5**, for **M5StackChan CoreS3**.
Release downloads: **[2.1.0-R5](https://github.com/alterdaemon/stack-chan-go/releases/tag/v2.1.0-R5)**.
Preconfigured application-only and full BINs are available in that release.

</td>
<td width="35%" valign="top">

https://github.com/user-attachments/assets/54cdc5e6-88c7-489d-bf10-56f2416e06ab

</td>
</tr>
</table>

## What this fork adds

Main differences in **2.1.0-R5** compared with upstream **2.1.0**:

| Area | What you get |
| --- | --- |
| ChatGPT support | Chat with an OpenAI API key or a ChatGPT subscription. Choose your connection in Settings and start with LIVE. |
| Stay signed in securely | Keep your ChatGPT account signed in after restarts, with encrypted storage and built-in setup under Security. |
| Voice and personality | Set its personality with the System prompt, choose a voice, and adjust pitch and speaking style. Wi-Fi and Bluetooth settings are available. |
| Web search and tools | Ask for current information, including weather, sports and finance. Cancel an unfinished lookup and ask a new question. |
| Interruption and resume | Choose whether speaking interrupts replies. Resume a Live conversation after an idle pause, with recent context. |
| Lights and movement | Lights show when the robot is listening, working or speaking. Small head movements accompany longer replies. |
| Easy installation and updates | Prepared BIN downloads support a fresh installation or an app update that keeps settings, MODs and stored data on a supported installation. |
| Everyday fixes | Fixes cover interrupted chat, screen and touch handling during conversation, and reopening the camera for another photo. |
| Version at a glance | Check the full firmware version at startup and beside the Wi-Fi address in Settings. |
| USB troubleshooting | Connection logs and temporary voice tests help investigate problems without reinstalling firmware for every test. |

See the [R5 changelog](CHANGELOG-MOD.md#210-r5) and
[R5 release notes](https://github.com/alterdaemon/stack-chan-go/releases/tag/v2.1.0-R5) for details and comparison links.

Connect the robot to Wi-Fi, then choose **OpenAI (API key)** or
**ChatGPT subscription** in Settings. Enter your API key or follow the
[ChatGPT sign-in steps](docs/stack-chan-go-fork/README.md#chatgpt-subscription-in-r5),
then press LIVE to start chatting.

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
