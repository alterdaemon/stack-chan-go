# Stack-chan Community fork

[Repository](https://github.com/alterdaemon/stack-chan-go) ·
[Changelog](../../CHANGELOG-MOD.md)

Current source firmware: **2.1.0-R5**. Standard hardware: M5StackChan CoreS3.
The published stable release is **[2.1.0-R4](https://github.com/alterdaemon/stack-chan-go/releases/tag/v2.1.0-R4)**.

The goal is to provide simple, preconfigured firmware images for a quick start,
optimize performance, and keep the fork up to date and in sync with upstream.

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

See the [R5 changes](../../CHANGELOG-MOD.md#210-r5) for the local candidate and the
[published R4 release notes](https://github.com/alterdaemon/stack-chan-go/releases/tag/v2.1.0-R4) for comparison links.

Upstream is
[stack-chan/stack-chan](https://github.com/stack-chan/stack-chan).
`docs/release-notes/` describes upstream releases, not fork revisions.

## Install or update

Download the preconfigured BINs from the published [R4 release](https://github.com/alterdaemon/stack-chan-go/releases/tag/v2.1.0-R4).
R5 is a local source candidate. Use a USB data cable and install [esptool](https://docs.espressif.com/projects/esptool/en/latest/esp32s3/installation.html).

**Application update:** preserves settings, MODs and storage on the
[supported 16 MiB layout](../../firmware/host/app/gpt-live-layout.json). Back up your data before flashing.

```sh
esptool --chip esp32s3 --no-stub -p /dev/ttyACM0 -b 115200 write_flash -z 0x10000 StackChan-Community-v2.1.0-R4-app.bin
```

**Full installation:** resets settings, MODs and storage.

```sh
esptool --chip esp32s3 --no-stub -p /dev/ttyACM0 -b 115200 write_flash -z 0x0 StackChan-Community-v2.1.0-R4.bin
```

Replace the port with Linux `/dev/ttyACM0` or `/dev/ttyUSB0`, Windows `COM3`, or
macOS `/dev/cu.*`. The full BIN goes at `0x0`; never write it at `0x10000`.

**Use this firmware at your own risk. The maintainer accepts no responsibility for bricked devices, data loss or other damage.**

## Settings

Open Settings on the robot, then use Bluetooth or visit
`http://<robot-IP>/settings/` over Wi-Fi. The web page is available only while
robot Settings is open. Initial WWW password setup has a five-minute window;
Bluetooth can also set or replace that password. HTTP Basic Auth does not encrypt
LAN traffic. Leaving a password field blank keeps its saved value.

Save your changes, leave Settings and start LIVE. Conversation settings apply on
the next start; saving does not restart an active call.

| Control | Essential behavior |
| --- | --- |
| AI connection | Choose **OpenAI (API key)** or **ChatGPT subscription**. Each keeps its own credentials; failures never switch to the other connection. |
| Conversation mode | API-key mode offers GPT-Live 1, GPT-Realtime 2.1 Mini and GPT-Realtime 2.1. Subscription uses its own voice service. |
| System prompt | Shared instructions for both connections. |
| Voice | API Live and Realtime have separate saved voices; the two Realtime modes share one voice setting. Subscription has an independent list, default Cove. |
| Pitch and Style | Pitch is local, in whole semitones from −6 to +6, default 0. Style is Default, Calm or Expressive. |
| Model and Thinking effort | Configure reasoning, search and tools separately from the voice model. API and subscription values are independent; subscription defaults to `gpt-6.1-terra` / `medium`. |
| Auto disconnect | Live/subscription timeout: 1–3600 seconds, default 60. Realtime stays connected during silence. See [standby](#interruption-and-standby). |

### ChatGPT subscription in R5

Account sign-in and secure-storage setup require the robot's Wi-Fi Settings page.

1. Under **Security → Secure storage**, check for **Ready**. Otherwise read the
   [permanent-key notice](#secure-storage-key-setup), choose **Set up secure storage**
   and confirm **Set up permanently**. Keep power connected until verification finishes.
2. Under **AI → AI connection**, choose **ChatGPT subscription**, then
   **Continue with ChatGPT**.
3. Open the displayed OpenAI link, enter the code and approve the account there.
   Return to the robot's Settings page to check sign-in status.
4. Set the shared System prompt and your subscription voice/reasoning controls,
   then Save and leave Settings.
5. Press **LIVE** to start. If it shows **SIGN IN**, return to Wi-Fi Settings
   and authorize again.

You can cancel or retry an expired sign-in; reloading the page recovers its status.
**Sign out** removes the robot's saved grant and ends its active subscription call.
A storage failure offers **Retry sign-out**. Local sign-out does not revoke the
cloud grant; stopping LIVE keeps you signed in.

This connection uses the private Codex Live service and a subscription reasoning/tools
backend. Your account needs access to those services; it does not unlock every API model.
API-key settings remain saved when you switch connections.

#### Secure storage key setup

**Setup permanently uses a hardware key slot.** A compatible protected key is
reused; otherwise confirmation programs **BLOCK_KEY5**. That key cannot be erased,
replaced or repurposed, even by rolling firmware back. An incompatible or unavailable
slot blocks setup. Installing firmware or ordinary Save does not program keys.

Only the separate Security confirmation starts setup. Cancel before confirmation
makes no change; closing the page afterward cannot undo the write. If the response
is lost, check storage status rather than assuming setup succeeded. A blocked or
unknown state prevents sign-in.

Encryption protects saved ChatGPT sign-in; existing API-key storage remains
unencrypted. This does not enable Secure Boot or flash encryption and does not
protect against malicious firmware running on the robot.

## Conversation behavior

### Interruption and standby

**Voice interruption** is experimental and defaults to **Off**. On keeps the
microphone listening during replies so you can interrupt; accepted interruption
clears queued speech and cancels pending search. Off gates the microphone during
playback, so spoken interruption is unavailable. Microphone mute is separate.

Live and subscription show **STANDBY** after the configured interval without
assistant output; pending delegated work pauses the timer. Tap LIVE to resume
with recent conversation context held in RAM. Stopping an active call, an error
or reboot clears that context. Realtime has no idle standby.

Search uses the selected connection's backend. A cancelled lookup does not resume
its old answer. A failed operation reports failure rather than changing connections.

### Lights and head movement

CoreS3 uses all 12 head LEDs during conversation:

| Color | Meaning |
| --- | --- |
| Dim green | Microphone input is ready. |
| Bright green | Incoming speech activity was reported. |
| Purple | A response or search is pending. |
| Cyan/blue | Audible speech is playing. |
| Off | Conversation is inactive, or the microphone is muted/gated while idle. |

Live's speech indication follows captions and can lag behind speech. Small,
smooth head movements accompany longer replies. Touch and manual actions take
priority; interruption cancels further speaking gestures.

### Everyday fixes and firmware identity

Fork fixes cover interrupted replies, screen/touch handling during conversation
and reopening the camera after capture. See the [changelog](../../CHANGELOG-MOD.md)
for changes by release.

The full firmware version appears below **GO** at startup and beside the Wi-Fi
address in the robot's Settings menu, including while disconnected.

## Build

Use the installed Moddable/ESP-IDF, esp-webrtc-solution and fontbm toolchains.
Release packaging also requires Python `esptool` and `xtensa-esp-elf-nm`.
With the SDK environment active and `ESP_WEBRTC_SOLUTION` set:

```sh
cd firmware
npm run build -- --mode=release
```

Alternatively, from the implementation repository root:

```sh
STACKCHAN_TOOLCHAINS=/path/to/toolchains bash firmware/scripts/mod/build-firmware.sh --mode=release
```

Use these wrappers. Managed build output stays under `firmware/dist/`; integrated
release builds also build embedded Settings and package the matching app/full BINs
under `internal/release-packages/`. Building does not flash a device. See
[firmware setup](../../firmware/README.md#start-local-development) for environment setup.

## USB development diagnostics

Diagnostics are **Off after every boot**. Use Python 3 on Linux/macOS with one USB
serial owner; close flashers/monitors and do not share the binary USB dock stream.
From the implementation repository root, choose a new private output file whose
parent directory already exists:

```sh
python3 firmware/scripts/mod/capture-debug.py --port /dev/ttyACM0 --command status
python3 firmware/scripts/mod/capture-debug.py --port /dev/ttyACM0 --duration 180 --output internal/work/debug-session.jsonl
python3 firmware/scripts/mod/capture-debug.py --port /dev/ttyACM0 --command off
```

Status identifies the running image and lost-record counts. Capture enables logs,
renews a 30-second lease and sends Off on exit. Logs exclude credentials, prompts,
transcripts and raw audio. Lost records make the affected sequence inconclusive.
Temporary trials stay in RAM and preserve saved settings; Off, disconnect, lease
expiry or reboot discards them. The tool does not flash or reset the robot.

For temporary controls, add `--interactive` and use that same capture process.
See the [capture tool](../../firmware/scripts/mod/capture-debug.py) and
[qualification tool](../../firmware/scripts/mod/qualify-live.py) `--help` for advanced use.

## Branches and tags

| Branch | Purpose |
| --- | --- |
| `main` / `v2.1.0-mod` | Current fork development and current series. |
| `v2.0.1-mod` | Historical 2.0.1 R15 line. |

Release tags identify builds; documentation edits do not move them. See the
[changelog comparisons](../../CHANGELOG-MOD.md#compare) for upstream base commits.
