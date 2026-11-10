# GPT-Live conversation shortcut

Release impact: patch.

The GPT-Live MOD adds a LIVE button in the bottom-left corner of the face screen. Tap it or swipe upward from the button to start or stop a conversation. The button shows LIVE OFF, LIVE..., LIVE ON or STOP... according to the session state. A tap or upward swipe during connection cancels startup; closing ignores further toggle requests. The drawer's GPT-Live action uses the same handler.

GPT-Live messages appear above the control. The control belongs to the face effects layer, so replacing the face with another screen removes it; the drawer overlay blocks it. Full session shutdown and reconnection retain their existing behavior.

The Piu simulator test exercises tap, swipe, buffered movement away and back, cancellation, startup cancellation, closing, shared drawer actions and screen transitions. Hardware touch behavior is not verified by the simulator.
