import copy
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

script = Path(__file__).with_name('package-gpt-live-update.py')
spec = importlib.util.spec_from_file_location('gpt_live_package', script)
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


def encode_table(partitions):
    return b''.join(struct.pack('<HBBII16sI', 0x50AA, p['type'], p['subtype'], p['offset'],
                                p['size'], p['name'].encode(), p['flags']) for p in partitions)


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.layout = json.loads((script.parents[1] / 'host/app/gpt-live-layout.json').read_text())
        self.table = encode_table(self.layout['partitions'])
        self.app = bytearray(4097)
        self.app[0] = 0xE9
        struct.pack_into('<H', self.app, 12, self.layout['chip_id'])

    def test_write_range_rounds_to_sectors_and_protects_other_partitions(self):
        result = package.validate_update(self.app, self.table, self.layout)
        start = int(result['write_address'], 16)
        self.assertEqual(int(result['erase_end_exclusive'], 16), start + 8192)
        self.assertTrue(all(p['type'] != 0 for p in result['protected_partitions']))

    def test_changed_layout_is_rejected(self):
        partitions = copy.deepcopy(self.layout['partitions'])
        partitions[0]['offset'] += 4096
        with self.assertRaisesRegex(ValueError, 'Partition layout changed'):
            package.validate_update(self.app, encode_table(partitions), self.layout)

    def test_wrong_chip_and_truncated_images_are_rejected(self):
        for app in (b'', self.app[:12], bytearray(self.app)):
            if len(app) >= 24:
                struct.pack_into('<H', app, 12, self.layout['chip_id'] + 1)
            with self.assertRaises(ValueError):
                package.validate_update(app, self.table, self.layout)

    def test_oversized_app_cannot_erase_another_partition(self):
        factory = next(p for p in self.layout['partitions'] if p['type'] == 0)
        app = self.app + bytearray(factory['size'])
        with self.assertRaisesRegex(ValueError, 'exceeds partition'):
            package.validate_update(app, self.table, self.layout)

    def test_partition_md5_and_record_integrity_are_checked(self):
        record = b'\xeb\xeb' + b'\xff' * 14 + hashlib.md5(self.table).digest()
        package.validate_update(self.app, self.table + record, self.layout)
        corrupted = record[:-1] + bytes([record[-1] ^ 1])
        for table in (self.table[:-1], self.table + corrupted, b'\x00' * 32):
            with self.assertRaises(ValueError):
                package.validate_update(self.app, table, self.layout)

    def test_publication_produces_only_a_bin_and_failed_validation_keeps_the_previous_bin(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            project = 'firmware/dist/tmp/esp32/m5stackchan_cores3/release/stack-chan-host'
            build = project + '/xsProj-esp32s3'
            settings = {'openaiLive': {'model': 'test-voice'}, 'tts': {'volume': 1}}
            modules = {name: ['fixture'] for name in (
                'openai-live-integrated', 'openai-live-session', 'openai-live-settings', 'realtimeConversation')}
            fixture = {
                'firmware/host/app/gpt-live-layout.json': json.dumps(self.layout).encode(),
                'firmware/host/app/manifest_openai_live_settings.json': json.dumps({'config': settings}).encode(),
                'firmware/package.json': b'{"version":"0.0.0"}',
                project + '/manifest_flat.json': json.dumps({'config': settings, 'modules': modules}).encode(),
                build + '/sdkconfig': b'',
                build + '/build/flasher_args.json': json.dumps({'flash_settings': self.layout['flash_settings']}).encode(),
                build + '/build/partition_table/partition-table.bin': self.table,
                build + '/build/xs_esp32.bin': bytes(self.app),
                build + '/build/xs_esp32.elf': b'fixture',
            }
            for name, data in fixture.items():
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            symbols = '\n'.join('0 T ' + name for name in (
                'xs_live_transport_constructor', 'xs_live_transport_start', 'xs_live_transport_close'))
            output = root / 'output'
            with (patch.object(package.shutil, 'which', return_value='/fixture/nm'),
                  patch.object(package.subprocess, 'check_output', return_value=symbols),
                  patch.object(package.subprocess, 'run') as inspect_image,
                  redirect_stdout(io.StringIO())):
                package.package_update(root, output)
                files = list(output.iterdir())
                self.assertEqual(len(files), 1)
                self.assertEqual(files[0].suffix, '.bin')
                self.assertEqual(files[0].read_bytes(), bytes(self.app))
                self.assertTrue(inspect_image.call_args.kwargs['check'])
                changed_app = bytearray(self.app)
                changed_app[-1] = 1
                (root / build / 'build/xs_esp32.bin').write_bytes(changed_app)
                inspect_image.side_effect = subprocess.CalledProcessError(1, ['esptool'])
                with self.assertRaises(subprocess.CalledProcessError):
                    package.package_update(root, output)
                self.assertEqual(list(output.iterdir()), files)
                self.assertEqual(files[0].read_bytes(), bytes(self.app))


if __name__ == '__main__':
    unittest.main()
