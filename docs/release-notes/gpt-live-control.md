# GPT-Live conversation shortcut

Release impact: patch.

The GPT-Live MOD adds a LIVE button in the bottom-left corner of the face screen. Tap it to start or stop a conversation. Swipe toggling has been removed. The button shows LIVE OFF, LIVE..., LIVE ON or STOP... according to the session state, with brief STARTED/STOPPED notices inside the button. A tap during connection cancels startup; closing ignores further toggle requests. The drawer's GPT-Live action uses the same handler. The LIVE background is 75% transparent in every state while its text remains opaque.

GPT-Live notices stay within the control and do not create balloons over the avatar. The control belongs to the face effects layer, so replacing the face with another screen removes it; the drawer overlay blocks it. Full session shutdown and reconnection retain their existing behavior.

The Piu simulator test exercises tap, rejection of swipes and buffered movement away and back, cancellation, startup cancellation, closing, shared drawer actions, screen transitions and consistent background transparency. Hardware touch behavior is not verified by the simulator.
