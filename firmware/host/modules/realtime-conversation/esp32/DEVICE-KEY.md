# Device root key

`device-key.status()` is read-only. It returns hardware-derived state and the
actual selected slot, using the store's established protected-key search order.
`device-key.setup()` is called only by the separately confirmed Settings action.
It reuses an existing compatible key without programming another slot. New setup
targets only unused BLOCK_KEY5 and uses ESP-IDF's batched HMAC_UP key API; the SDK
owns bounded low-level pulse verification. The application has no repair/retry
loop. A failed commit is latched as blocked for the boot; partial slots remain
occupied after reboot.

Only the root, purpose and necessary read/write/purpose protections are written.
The root and HMAC scratch stay in native RAM and are wiped before returning.
Wi-Fi must be connected; power saving is disabled for entropy collection and
restored before programming. Readiness requires no coding errors and a working
hardware HMAC. New setup compares it against a PSA HMAC of a public challenge.
Virtual-eFuse configurations are rejected at compile time to prevent false
readiness and key-dumping test configurations from entering a product image.

The native subscription record format, derivation label and NVS namespace are
unchanged. The key is generic; the ChatGPT-specific derivation context stays in
the credential store. This does not encrypt ordinary API-key preferences, enable
Secure Boot/flash encryption, change partitions or export a key.
