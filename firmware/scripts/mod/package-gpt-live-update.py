#!/usr/bin/env python3
"""Publish matching full-flash and application-only CoreS3 GPT-Live images."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys


REVISION = 1


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_update(app, table, layout):
    require(len(app) >= 24 and app[0] == 0xE9, 'Invalid ESP application image')
    require(struct.unpack_from('<H', app, 12)[0] == layout['chip_id'], 'Wrong application chip')
    require(len(table) % 32 == 0, 'Truncated partition table')
    partitions = []
    for pos in range(0, len(table), 32):
        record = table[pos:pos + 32]
        magic = struct.unpack_from('<H', record)[0]
        if magic == 0xEBEB:
            require(hashlib.md5(table[:pos]).digest() == record[16:], 'Invalid partition table MD5')
            break
        if magic == 0xFFFF:
            break
        require(magic == 0x50AA, 'Invalid partition record')
        _, kind, subtype, offset, size, label, flags = struct.unpack('<HBBII16sI', record)
        partitions.append(dict(name=label.split(b'\0')[0].decode(), type=kind, subtype=subtype,
                               offset=offset, size=size, flags=flags))
    require(partitions == layout['partitions'], 'Partition layout changed; app-only update rejected')
    factory = next(p for p in partitions if p['type'] == 0 and p['subtype'] == 0)
    start = factory['offset']
    erase_end = ((start + len(app) + 4095) // 4096) * 4096
    require(start >= 0x10000 and start % 4096 == 0, 'Application overlaps bootloader or partition table')
    require(erase_end <= factory['offset'] + factory['size'] <= layout['flash_bytes'], 'Application exceeds partition')
    protected = [p for p in partitions if p != factory]
    for p in protected:
        require(erase_end <= p['offset'] or start >= p['offset'] + p['size'], 'Update overlaps ' + p['name'])
    return dict(layout_matches_reference=True, write_address=hex(start), erase_end_exclusive=hex(erase_end),
                application_bytes=len(app), protected_partitions=protected)


def build_full_image(bootloader, table, app, layout):
    update = validate_update(app, table, layout)
    require(len(bootloader) >= 24 and bootloader[0] == 0xE9, 'Invalid ESP bootloader image')
    require(struct.unpack_from('<H', bootloader, 12)[0] == layout['chip_id'], 'Wrong bootloader chip')
    require(len(bootloader) <= 0x8000, 'Bootloader overlaps partition table')
    first_partition = min(p['offset'] for p in layout['partitions'])
    require(0x8000 + len(table) <= first_partition, 'Partition table overlaps data partitions')
    # A full installation intentionally resets data, including NVS, xs and storage.
    # Keep every gap and the unused tail erased, like a RAW merge padded to flash size.
    image = bytearray(b'\xff') * layout['flash_bytes']
    for offset, data in ((0, bootloader), (0x8000, table), (int(update['write_address'], 16), app)):
        image[offset:offset + len(data)] = data
    return bytes(image)


def package_update(root, output):
    version = json.loads((root / 'firmware/package.json').read_text())['version']
    revision_version = re.fullmatch(r'\d+\.\d+\.\d+-R([1-9]\d*)', version)
    require(revision_version and int(revision_version[1]) == REVISION,
            f'Product version must end in -R{REVISION} to match the package revision')
    project = root / 'firmware/dist/tmp/esp32/m5stackchan_cores3/release/stack-chan-host'
    build = project / 'xsProj-esp32s3/build'
    layout = json.loads((root / 'firmware/host/app/gpt-live-layout.json').read_text())
    requested = json.loads((root / 'firmware/host/app/manifest_openai_live_settings.json').read_text())['config']
    flat = json.loads((project / 'manifest_flat.json').read_text())
    require(flat['config']['openaiLive'] == requested['openaiLive'], 'Built GPT-Live settings differ from source')
    require(not requested['openaiLive'].get('apiKey'), 'Do not embed an API key in a distributed image')
    require({'openai-live-integrated', 'openai-live-session', 'openai-live-settings', 'realtimeConversation'}
            <= flat['modules'].keys(), 'Build does not contain integrated GPT-Live')
    require(all(flat['config']['tts'][key] == value for key, value in requested['tts'].items()), 'Wrong TTS settings')
    flash = json.loads((build / 'flasher_args.json').read_text())
    require(flash['flash_settings'] == layout['flash_settings'],
            'Flash settings differ from the supported update layout')
    sdkconfig = (build.parent / 'sdkconfig').read_text().splitlines()
    for key in ('CONFIG_SECURE_BOOT', 'CONFIG_SECURE_FLASH_ENC_ENABLED',
                'CONFIG_SECURE_ENABLE_SECURE_ROM_DL_MODE', 'CONFIG_SECURE_DISABLE_ROM_DL_MODE'):
        require(key + '=y' not in sdkconfig, 'Unsupported security setting: ' + key)
    app_path = build / 'xs_esp32.bin'
    app = app_path.read_bytes()
    table = (build / 'partition_table/partition-table.bin').read_bytes()
    update = validate_update(app, table, layout)
    require({int(offset, 0): name for offset, name in flash['flash_files'].items()} == {
        0: 'bootloader/bootloader.bin',
        0x8000: 'partition_table/partition-table.bin',
        int(update['write_address'], 16): 'xs_esp32.bin',
    }, 'Flash file offsets differ from the supported full-image layout')
    bootloader_path = build / 'bootloader/bootloader.bin'
    full = build_full_image(bootloader_path.read_bytes(), table, app, layout)
    nm = shutil.which('xtensa-esp-elf-nm')
    require(nm, 'Activate the ESP-IDF environment: xtensa-esp-elf-nm is missing')
    symbols = subprocess.check_output([nm, str(build / 'xs_esp32.elf')], text=True)
    symbols = {line.split()[-1] for line in symbols.splitlines() if line.split()}
    require(not symbols.intersection(('esp_efuse_disable_rom_download_mode',
                                     'esp_efuse_enable_rom_secure_download_mode',
                                     'esp_secure_boot_enable_secure_features')), 'ROM download lock code is linked')
    require({'xs_live_transport_constructor', 'xs_live_transport_start', 'xs_live_transport_close'} <= symbols,
            'Native GPT-Live transport is missing')
    for image in (bootloader_path, app_path):
        subprocess.run([sys.executable, '-m', 'esptool', '--chip', 'esp32s3',
                        'image_info', str(image)], check=True)
    name = f'StackChan-Community-v{version}-GPT-Live'
    images = {output / (name + '.bin'): full, output / (name + '-app.bin'): app}
    for target, data in images.items():
        require(not target.exists() or target.read_bytes() == data,
                f'Published image differs: {target.name}; use a new revision')
    output.mkdir(parents=True, exist_ok=True)
    for target, data in images.items():
        if not target.exists():
            target.write_bytes(data)
        print(target)


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[3]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=root / 'internal/gpt-live-package')
    options = parser.parse_args()
    try:
        (root / 'internal').mkdir(mode=0o700, exist_ok=True)
        package_update(root, options.output.resolve())
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Package rejected: {error}\n')
