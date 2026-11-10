# GPT-Live full-flash and application images

Release impact: patch.

Every integrated CoreS3 GPT-Live release build now automatically publishes two BINs under `gpt-live-package/`: a full 16 MiB image for installation at `0x0`, and a matching application-only image for updates at `0x10000`. The full image includes the current build's bootloader, partition table and application; all other bytes are `0xFF`, so installing it resets NVS, xs and storage. Application-only updates preserve other partitions on the supported layout.

Packaging validates the flash layout and boot files before publishing either image. Reusing a revision with different contents fails instead of overwriting an earlier release. Debug, instrument, alternate-manifest and other-device builds do not publish GPT-Live images.

The R7 correction moves status notices into the LIVE button, removing GPT-Live balloons over the avatar. STARTED and STOPPED appear for 1.2 seconds before the button returns to LIVE ON or LIVE OFF. ERROR and SET KEY remain for 5 seconds; detailed error diagnostics remain in the trace. Each new state cancels the previous notice timer, so rapid toggling cannot overwrite a newer status. Hosts without the Piu control retain timed balloon messages.

The final R7 correction removes swipe toggling and its edge touch region. Tap the visible LIVE button to start or stop the conversation. Its background is 75% transparent in idle, connecting, connected and pressed states; text stays opaque for readability. These skins are local to the LIVE control and do not change the shared UI theme.
