#!/usr/bin/env python3
"""Package the current CoreS3 app against the source-controlled update layout."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys


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


def package_update(root, output):
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
    flash = json.loads((build / 'flasher_args.json').read_text())['flash_settings']
    require(flash == layout['flash_settings'], 'Flash settings differ from the supported update layout')
    sdkconfig = (build.parent / 'sdkconfig').read_text().splitlines()
    for key in ('CONFIG_SECURE_BOOT', 'CONFIG_SECURE_FLASH_ENC_ENABLED',
                'CONFIG_SECURE_ENABLE_SECURE_ROM_DL_MODE', 'CONFIG_SECURE_DISABLE_ROM_DL_MODE'):
        require(key + '=y' not in sdkconfig, 'Unsupported security setting: ' + key)
    app_path = build / 'xs_esp32.bin'
    app = app_path.read_bytes()
    validate_update(app, (build / 'partition_table/partition-table.bin').read_bytes(), layout)
    nm = shutil.which('xtensa-esp-elf-nm')
    require(nm, 'Activate the ESP-IDF environment: xtensa-esp-elf-nm is missing')
    symbols = subprocess.check_output([nm, str(build / 'xs_esp32.elf')], text=True)
    symbols = {line.split()[-1] for line in symbols.splitlines() if line.split()}
    require(not symbols.intersection(('esp_efuse_disable_rom_download_mode',
                                     'esp_efuse_enable_rom_secure_download_mode',
                                     'esp_secure_boot_enable_secure_features')), 'ROM download lock code is linked')
    require({'xs_live_transport_constructor', 'xs_live_transport_start', 'xs_live_transport_close'} <= symbols,
            'Native GPT-Live transport is missing')
    subprocess.run([sys.executable, '-m', 'esptool', '--chip', 'esp32s3',
                    'image_info', str(app_path)], check=True)
    version = json.loads((root / 'firmware/package.json').read_text())['version']
    name = f'StackChan-Community-v{version}-GPT-Live-app.bin'
    output.mkdir(parents=True, exist_ok=True)
    (output / name).write_bytes(app)
    print(output / name)


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=root / 'gpt-live-package')
    options = parser.parse_args()
    try:
        package_update(root, options.output.resolve())
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Package rejected: {error}\n')
