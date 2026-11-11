#!/usr/bin/env python3
"""Validate effective generated mappings and safe diagnostic image bounds."""
import hashlib
import json
import re
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[7]
manifest = json.loads((ROOT / 'firmware/host/app/manifest_openai_r14_complete.test.json').read_text())
tmp = ROOT / 'firmware/dist/tmp/esp32/m5stackchan_cores3/release/stack-chan-host'
makefile = (tmp / 'makefile').read_text()
js_modules = ['preference', 'live-probe', 'openai-live-integrated', 'openai-live-session',
              'r14-complete-options', 'r14-complete-remaining', 'realtimeConversation/http-worker']
for name in js_modules:
    expected = (ROOT / 'firmware/host/app' / (manifest['modules'][name] + '.js')).resolve()
    actual = re.findall(r'^\$\(MODULES_DIR\)/' + re.escape(name) + r'\.xsb: (.+)$', makefile, re.M)
    assert actual == [str(expected)], (name, actual, str(expected))
    compiled = tmp / 'modules' / (name + '.xsb')
    assert compiled.stat().st_mtime_ns >= expected.stat().st_mtime_ns, ('stale module', name)
for name in ['liveAudio', 'livePitch', 'opus-policy', 'modSPI', 'complete', 'decoder-bench']:
    expected = ROOT / 'internal/diagnostics/r14-complete' / (name + '.c')
    actual = re.findall(r'^\$\(TMP_DIR\)/' + re.escape(name) + r'\.c\.o: (.+?) \$\(HEADERS\)', makefile, re.M)
    assert actual == [str(expected)], (name, actual)
image = (ROOT / 'firmware/dist/bin/esp32/m5stackchan_cores3/release/stack-chan-host/xs_esp32.bin').read_bytes()
layout = json.loads((ROOT / 'firmware/host/app/gpt-live-layout.json').read_text())
partition = next(x for x in layout['partitions'] if x['name'] == 'factory')
assert image[0] == 0xe9 and struct.unpack_from('<H', image, 12)[0] == 9
assert partition['offset'] == 0x10000 and len(image) <= partition['size']
print(json.dumps({'effective_js_mappings': len(js_modules), 'effective_native_mappings': 6,
                  'image_bytes': len(image), 'image_sha256': hashlib.sha256(image).hexdigest(),
                  'write_address': 65536}))
