# CoreS3 camera binding

This directory retains the Moddable SDK camera binding and its LGPL notice.
The source was copied from the installed Moddable SDK 10.0.2 archive and
modified for Stack-chan Community on 2026-11-11. See [LGPL](COPYING.LESSER)
and [GPL](COPYING) for the license texts from that archive.
The original `modules/io/imagein/camera/esp32/camera.c` SHA-256 is
`33df2788d9fdeab9789b4de28166e7ec49000ff9874a3d9d258a5f9368d13a68`.
The archive has no Git metadata. [Moddable 10.0.2](https://github.com/Moddable-OpenSource/moddable/blob/10.0.2/modules/io/imagein/camera/esp32/camera.c).
[Moddable 10.1.0](https://github.com/Moddable-OpenSource/moddable/blob/10.1.0/modules/embedded/io/image/in/camera/esp32/camera.c) moved the binding to the embedded module directory with identical bytes.

The CoreS3 manifest uses this C binding with the SDK JavaScript API. The capture
task checks control notifications between reads, acknowledges stop and close,
and waits when all frame slots are in use. An XS timer reports ready frames
while capture is running. This lets the worker acknowledge shutdown even when
the XS queue is full. Close joins capture, detaches client buffers and
deinitializes the Espressif camera. Native `stop()` pauses frame delivery to
keep the open-camera API available. The Stack-chan CoreS3 adapter closes the
native camera on stop and recreates it on demand.
