# SPI integration

`modSPI.c` is copied from Moddable SDK 10.0.2,
`modules/pins/spi/esp32/modSPI.c`. Its original LGPL notice is retained.
Upstream SHA-256: `1b9b35ae484c3c9dcb84bdfe1598f1e6c46e59ea389309772daa7b2deb2e8a85`.

The CoreS3 realtime manifest excludes the SDK translation unit and compiles
this repository copy. No shared SDK checkout is modified. Fork changes add
a task-context event group for idle/capacity notifications; the existing SPI
ISR, DMA, conversions, arbitration and UI priorities remain in use. Both wait
conditions are rechecked under the existing SPI mutex. An R14 probe-only switch
retains the original busy-yield behavior for paired measurements.
