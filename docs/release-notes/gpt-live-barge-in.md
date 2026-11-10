# GPT-Live voice interruption (R9, amended)

Release impact: minor.

Settings → OpenAI adds **Voice interruption (experimental)** below Thinking
effort, in the shared Wi-Fi and Bluetooth form. It is **Off by default**, including
when no preference exists. A saved change applies on the next GPT-Live start.
Older firmware that does not advertise `openailive.bargeIn` cannot edit this field.

On keeps the microphone streaming during model playback through ESP-SR 2.4.7
full-duplex acoustic echo cancellation at 16 kHz, using its default aggressive
residual echo suppression. GPT-Live receives the audio and an interruption policy
asking it to yield, listen until the user finishes, and remain silent if asked to
stop or wait. The model decides when to yield. Interruption does not cancel
delegated backend work.

Off retains the existing half-duplex microphone gate and allocates no AEC
instance. Failure to allocate the enabled audio processing fails session startup
with stage diagnostics instead of silently disabling echo cancellation.

The initial R9 locally muted playback and appended a stop instruction when its
microphone VAD reported sustained speech. That detector did not identify the
speaker, so residual echo could trigger the same path as a user interruption. A
user reported each answer stopping after about half a second; the acoustic cause
on that device has not been measured. This amendment removes that VAD gate and
its automatic stop instructions. Capture activity cannot locally mute, flush or
discard the assistant's answer. At the user's request, this correction replaces
both R9 BINs under their existing filenames and is part of the same R9 commit.

[OpenAI's interruption documentation](https://developers.openai.com/api/docs/guides/live-prompting#interruptions)
states that GPT-Live supports full duplex, but instructions do not guarantee an
exact stopping time. [Espressif's AEC documentation](https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/acoustic_echo_cancellation/README.html#nlp-level-description)
describes AGGR as the default FD nonlinear suppression level, with stronger echo
suppression and a possible effect on near-end speech quality.

Regression coverage feeds repeated unclassified local detections during an answer
and verifies that they send no stop commands, leave the microphone unmuted and
preserve the active session and transcript delivery. The MOD startup integration
also checks that the saved opt-in reaches transport without generating commands.

Hardware acoustic performance, RAM/CPU headroom during a live call, and interruption
latency require a CoreS3 device test. Compilation and offline tests do not establish
those results. Test speaker-only playback for false triggers, overlapping caller
speech at several volumes/distances, mute/unmute, consecutive interruptions,
network gaps, resumed answers, and repeated start/stop with heap monitoring.
