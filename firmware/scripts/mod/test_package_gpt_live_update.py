import copy
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import runpy
import shutil
import struct
import subprocess
import sys
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
        self.layout = json.loads((script.parents[2] / 'host/app/gpt-live-layout.json').read_text())
        self.table = encode_table(self.layout['partitions'])
        self.app = bytearray(4097)
        self.app[0] = 0xE9
        struct.pack_into('<H', self.app, 12, self.layout['chip_id'])
        self.bootloader = bytearray(b'bootloader fixture' * 3)
        self.bootloader[0] = 0xE9
        struct.pack_into('<H', self.bootloader, 12, self.layout['chip_id'])

    def test_full_image_contains_the_same_app_and_boot_files_and_erases_all_remaining_bytes(self):
        full = package.build_full_image(self.bootloader, self.table, self.app, self.layout)
        factory = next(p for p in self.layout['partitions'] if p['type'] == 0)
        self.assertEqual(len(full), self.layout['flash_bytes'])
        self.assertEqual(full[:len(self.bootloader)], self.bootloader)
        self.assertEqual(full[0x8000:0x8000 + len(self.table)], self.table)
        self.assertEqual(full[factory['offset']:factory['offset'] + len(self.app)], self.app)
        used = sum(len(data) - data.count(255) for data in (self.bootloader, self.table, self.app))
        self.assertEqual(full.count(255), len(full) - used)
        for partition in self.layout['partitions']:
            if partition != factory:
                data = full[partition['offset']:partition['offset'] + partition['size']]
                self.assertEqual(data, b'\xff' * partition['size'])

    def test_invalid_or_overlapping_boot_files_are_rejected(self):
        wrong_chip = bytearray(self.bootloader)
        struct.pack_into('<H', wrong_chip, 12, self.layout['chip_id'] + 1)
        for bootloader, table in (
            (b'', self.table),
            (wrong_chip, self.table),
            (self.bootloader + b'\xff' * 0x8000, self.table),
            (self.bootloader, self.table + b'\xff' * 0x1000),
        ):
            with self.assertRaises(ValueError):
                package.build_full_image(bootloader, table, self.app, self.layout)

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

    def test_publication_produces_a_matching_pair_and_preserves_published_revisions(self):
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
                'firmware/package.json': json.dumps({'version': f'0.0.0-R{package.REVISION}'}).encode(),
                project + '/manifest_flat.json': json.dumps({'config': settings, 'modules': modules}).encode(),
                build + '/sdkconfig': b'',
                build + '/build/flasher_args.json': json.dumps({
                    'flash_settings': self.layout['flash_settings'],
                    'flash_files': {
                        '0x0': 'bootloader/bootloader.bin',
                        '0x8000': 'partition_table/partition-table.bin',
                        '0x10000': 'xs_esp32.bin',
                    },
                }).encode(),
                build + '/build/bootloader/bootloader.bin': bytes(self.bootloader),
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
            output = root / 'internal/release-packages'
            installed_script = root / 'firmware/scripts/mod' / script.name
            installed_script.parent.mkdir(parents=True)
            shutil.copyfile(script, installed_script)
            with (patch.object(package.shutil, 'which', return_value='/fixture/nm'),
                  patch.object(package.subprocess, 'check_output', return_value=symbols),
                  patch.object(package.subprocess, 'run') as inspect_image,
                  redirect_stdout(io.StringIO())):
                with patch.object(sys, 'argv', [str(installed_script)]):
                    runpy.run_path(str(installed_script), run_name='__main__')
                files = sorted(output.iterdir())
                name = f'StackChan-Community-v0.0.0-R{package.REVISION}'
                self.assertEqual({p.name for p in files}, {name + '.bin', name + '-app.bin'})
                app_file = next(p for p in files if p.name.endswith('-app.bin'))
                self.assertTrue(app_file.name.startswith(f'StackChan-Community-v0.0.0-R{package.REVISION}-'))
                full_file = output / app_file.name.replace('-app.bin', '.bin')
                self.assertEqual(app_file.read_bytes(), bytes(self.app))
                full = full_file.read_bytes()
                self.assertEqual(len(full), self.layout['flash_bytes'])
                self.assertEqual(full[0x10000:0x10000 + len(self.app)], app_file.read_bytes())
                self.assertEqual(full[:len(self.bootloader)], bytes(self.bootloader))
                self.assertEqual(full[0x8000:0x8000 + len(self.table)], self.table)
                self.assertEqual(inspect_image.call_count, 2)
                self.assertTrue(inspect_image.call_args.kwargs['check'])
                package.package_update(root, output)
                self.assertEqual(sorted(output.iterdir()), files)
                changed_app = bytearray(self.app)
                changed_app[-1] = 1
                (root / build / 'build/xs_esp32.bin').write_bytes(changed_app)
                inspect_image.side_effect = subprocess.CalledProcessError(1, ['esptool'])
                with self.assertRaises(subprocess.CalledProcessError):
                    package.package_update(root, output)
                self.assertEqual(sorted(output.iterdir()), files)
                self.assertEqual(app_file.read_bytes(), bytes(self.app))
                self.assertEqual(full_file.read_bytes(), full)
                inspect_image.side_effect = None
                # Check both destinations before creating either half of a new pair.
                full_file.unlink()
                with self.assertRaisesRegex(ValueError, 'use a new revision'):
                    package.package_update(root, output)
                self.assertFalse(full_file.exists())
                self.assertEqual(app_file.read_bytes(), bytes(self.app))
                (root / build / 'build/xs_esp32.bin').write_bytes(self.app)
                package.package_update(root, output)
                self.assertEqual(full_file.read_bytes(), full)
                # Unexpected flash offsets must fail before any publication.
                flash_path = root / build / 'build/flasher_args.json'
                flash = json.loads(flash_path.read_text())
                flash['flash_files']['0x20000'] = flash['flash_files'].pop('0x10000')
                flash_path.write_text(json.dumps(flash))
                with self.assertRaisesRegex(ValueError, 'Flash file offsets'):
                    package.package_update(root, output)
                self.assertEqual(full_file.read_bytes(), full)
                self.assertEqual(app_file.read_bytes(), bytes(self.app))

    def test_product_version_must_match_the_package_revision_before_publication(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'firmware').mkdir()
            for version in ('2.0.1', '2.0.1-r0', '2.0.1-r01',
                            f'2.0.1-r{package.REVISION + 1}', '2.0.1-beta1'):
                (root / 'firmware/package.json').write_text(json.dumps({'version': version}))
                with self.assertRaisesRegex(ValueError, 'Product version'):
                    package.package_update(root, root / 'output')
                self.assertFalse((root / 'output').exists())


if __name__ == '__main__':
    unittest.main()
