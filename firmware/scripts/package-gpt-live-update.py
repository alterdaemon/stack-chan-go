#!/usr/bin/env python3
"""Build an app-only update validated against the retained R2 flash layout."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--toolchains', type=Path, required=True)
parser.add_argument('--outputs', type=Path)
parser.add_argument('--test-log', type=Path)
parser.add_argument('--build-log', type=Path)
options = parser.parse_args()
root = Path(__file__).resolve().parents[2]
toolchains = options.toolchains.resolve()
baseline = root / 'gpt-live-package'
pkg = root / 'gpt-live-package'
proj = root / 'firmware/dist/tmp/esp32/m5stackchan_cores3/release/stack-chan-host/xsProj-esp32s3'
build = proj / 'build'
name = 'StackChan-Community-v2.0.1-r4-GPT-Live-app'
for folder in ('verification', 'source', 'licenses'):
    (pkg / folder).mkdir(parents=True, exist_ok=True)

# The previous package must be intact before it is used as the compatibility reference.
reference_hashes = json.loads((baseline / 'SHA256-r2.json').read_text())
for filename in ('firmware/partition-table.bin', 'BUILD-INFO.json'):
    assert hashlib.sha256((baseline / ('BUILD-INFO-r2.json' if filename == 'BUILD-INFO.json' else filename)).read_bytes()).hexdigest() == reference_hashes[filename]
old_partitions = (baseline / 'firmware/partition-table.bin').read_bytes()
new_partitions = (build / 'partition_table/partition-table.bin').read_bytes()
assert old_partitions == new_partitions, 'Partition layout changed; settings-preserving update is invalid'
entries = []
for i in range(0, len(new_partitions), 32):
    record = new_partitions[i:i+32]
    magic = struct.unpack_from('<H', record)[0]
    if magic in (0xffff, 0xebeb):
        break
    assert magic == 0x50aa
    _, typ, subtype, offset, size, label, flags = struct.unpack('<HBBII16sI', record)
    entries.append({'name': label.split(b'\0')[0].decode(), 'type': typ, 'subtype': subtype, 'offset': offset, 'size': size})
factory = next(p for p in entries if p['type'] == 0 and p['subtype'] == 0)
assert factory['offset'] == 0x10000
app = (build / 'xs_esp32.bin').read_bytes()
assert app[0] == 0xe9 and struct.unpack_from('<H', app, 12)[0] == 9
start = factory['offset']
end = start + len(app)
erase_start = start // 4096 * 4096
erase_end = (end + 4095) // 4096 * 4096
assert start >= factory['offset'] and erase_end <= factory['offset'] + factory['size']
protected = [p for p in entries if p is not factory]
for p in protected:
    assert erase_end <= p['offset'] or erase_start >= p['offset'] + p['size']
assert erase_start >= 0x10000  # Bootloader and partition table are outside the update range.
settings = json.loads((build / 'flasher_args.json').read_text())['flash_settings']
reference_info = json.loads((baseline / 'BUILD-INFO-r2.json').read_text())
assert settings == reference_info['flash_settings']
config = (proj / 'sdkconfig').read_text()
for key in ('CONFIG_SECURE_BOOT', 'CONFIG_SECURE_FLASH_ENC_ENABLED', 'CONFIG_SECURE_ENABLE_SECURE_ROM_DL_MODE', 'CONFIG_SECURE_DISABLE_ROM_DL_MODE'):
    assert key + '=y' not in config
flat = json.loads((proj.parent / 'manifest_flat.json').read_text())
requested = json.loads((root / 'firmware/host/app/manifest_openai_live_settings.json').read_text())['config']
assert flat['config']['openaiLive'] == requested['openaiLive']
assert flat['config']['openaiLive']['backendModel'] == 'gpt-6.1-terra'
assert flat['config']['openaiLive']['reasoningEffort'] == 'medium'
assert flat['config']['openaiLive']['tools'] == [{'type': 'web_search'}]
assert flat['config']['openaiLive'] == reference_info['settings']
assert flat['config']['tts'] == reference_info['tts_config']
for marker in (b'providerCode', b'http_error', b'readonly_json', b'core_delegation', b'gpt-6.1-terra', b'GPT-Live error R4'):
    assert marker in app
nm = next((toolchains / 'idf-tools/tools/xtensa-esp-elf').rglob('bin/xtensa-esp-elf-nm'))
symbol_text = subprocess.run([str(nm), str(build / 'xs_esp32.elf')], check=True, capture_output=True, text=True).stdout
symbols = {line.split()[-1] for line in symbol_text.splitlines() if line.split()}
for symbol in ('esp_efuse_disable_rom_download_mode', 'esp_efuse_enable_rom_secure_download_mode', 'esp_secure_boot_enable_secure_features'):
    assert symbol not in symbols
for symbol in ('xs_live_transport_constructor', 'xs_live_transport_start', 'xs_live_transport_close'):
    assert symbol in symbols
(pkg / (name + '.bin')).write_bytes(app)
python = next((toolchains / 'idf-tools/python_env').glob('idf6.1_*/bin/python'))
result = subprocess.run([str(python), '-m', 'esptool', '--chip', 'esp32s3', 'image-info', str(pkg / (name + '.bin'))], check=True, capture_output=True, text=True)
(pkg / 'verification/image-info.txt').write_text(result.stdout + result.stderr)
audit = {'partition_table_matches_r2': True, 'application_bytes': len(app), 'write_address': hex(start), 'erase_start': hex(erase_start), 'erase_end_exclusive': hex(erase_end), 'protected_partitions_not_overlapped': protected, 'bootloader_not_written': True, 'partition_table_not_written': True, 'rom_download_lock_functions_absent': True, 'configuration_matches_requested_r4': True, 'settings_identical_to_r2': True, 'hosted_web_search_enabled': True}
(pkg / 'verification/update-audit.json').write_text(json.dumps(audit, indent=2) + '\n')
info = {'package_revision': 4, 'update_only': True, 'diagnostic_build': True, 'bug_fix': 'Copy ROM-backed configuration arrays and objects into RAM before Conversation JSON serialization', 'hardware': reference_info['hardware'], 'image': {'path': name + '.bin', 'offset': hex(start), 'preserves_settings': True, 'requires_existing_community_r1_or_r2_layout': True}, 'settings': flat['config']['openaiLive'], 'flash_settings': settings, 'built_utc': datetime.now(timezone.utc).isoformat(), 'verification': {'hardware_tested': False, 'api_tested': False}, 'root_cause_of_reported_error': 'Reproduced under compiled Moddable XS: JSON.stringify rejects ROM-backed tools array with TypeError read only value; recursive RAM copy passes the identical integration test. Physical device confirmation pending.'}
for source, filename in ((options.test_log, 'tests.txt'), (options.build_log, 'build-log.txt')):
    if source:
        text = source.read_text(errors='replace')
        if source == options.test_log:
            assert '# fail 0' in text
            info['verification']['tests_passed'] = int(next(line.split()[-1] for line in text.splitlines() if line.startswith('# pass ')))
        (pkg / 'verification' / filename).write_text(text.replace(str(root), '[PROJECT_ROOT]').replace(str(toolchains), '[TOOLCHAINS]'))
(pkg / 'BUILD-INFO.json').write_text(json.dumps(info, ensure_ascii=False, indent=2) + '\n')
for filename in ('sdkconfig', 'dependencies.lock'):
    shutil.copy2(proj / filename, pkg / 'source' / filename)
# Provenance and licenses are retained in this same package directory.

(pkg / 'INSTRUKCJA.txt').write_text('''Community 2.0.1 + GPT-Live R4. Aktualizacja zachowująca ustawienia.
Backend: gpt-6.1-terra, reasoning medium. Narzędzie: web_search (auto).
Model głosowy: gpt-live-1; marin; instrukcja domyślna pusta; głośność domyślna 1.
Zapisane AI / Context i głośność mają pierwszeństwo.

Z katalogu projektu:
esptool --chip esp32s3 --no-stub -p /dev/ttyACM0 -b 115200 write_flash -z 0x10000 gpt-live-package/''' + name + '''.bin

Po zakończeniu krótko naciśnij RST. Ten BIN jest aplikacją pod 0x10000.
Dla urządzenia z paczką Community R1/R2/R3 z tej rozmowy.
Polecenie omija NVS z ustawieniami, bootloader, tabelę partycji, XS i storage.
Nie używaj dla tego pliku adresu 0x0 ani erase_flash/--erase-all.

Poprawiono odtworzony błąd konfiguracji: kopiowanie tablic z ROM do RAM
przed serializacją JSON. Szczegóły i test porównawczy: verification/root-cause-r4.txt.
Ekran błędu pokazuje R4, etap/kod, miejsce operacji, typ wyjątku oraz dostępne
HTTP, identyfikator i parametr API. Bez pełnego stosu, klucza i treści odpowiedzi.
Nie przeprowadzono fizycznego wgrania ani połączenia z rzeczywistym API.
''')
records = {str(p.relative_to(pkg)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(pkg.rglob('*')) if p.is_file() and p.name not in ('SHA256.json', 'SHA256SUMS.txt') and p.suffix not in ('.zip', '.sha256') and (p.suffix != '.bin' or p.name == name + '.bin')}
(pkg / 'SHA256.json').write_text(json.dumps(records, indent=2) + '\n')
(pkg / 'SHA256SUMS.txt').write_text(''.join(digest + '  ' + filename + '\n' for filename, digest in records.items()))
outputs = options.outputs.resolve() if options.outputs else pkg
outputs.mkdir(parents=True, exist_ok=True)
if outputs != pkg:
    shutil.copy2(pkg / (name + '.bin'), outputs / (name + '.bin'))
archive = outputs / (name + '.zip')
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for path in sorted(pkg.rglob('*')):
        if path.is_file() and path.suffix not in ('.zip', '.sha256') and (path.suffix != '.bin' or path.name == name + '.bin'):
            z.write(path, 'gpt-live-package/' + str(path.relative_to(pkg)))
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    for filename, digest in records.items():
        if filename.endswith('.bin') and filename != name + '.bin':
            continue
        assert hashlib.sha256(z.read('gpt-live-package/' + filename)).hexdigest() == digest
for path in (archive, outputs / (name + '.bin')):
    (outputs / (path.name + '.sha256')).write_text(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n')
print(json.dumps(audit, indent=2))
print('Packaged settings-preserving update:', pkg / (name + '.bin'))
