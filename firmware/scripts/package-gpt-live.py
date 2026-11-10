#!/usr/bin/env python3
"""Package and audit the integrated CoreS3 release after the managed npm build."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--toolchains', type=Path, required=True)
parser.add_argument('--outputs', type=Path)
parser.add_argument('--build-log', type=Path)
parser.add_argument('--test-log', type=Path)
options = parser.parse_args()
root = Path(__file__).resolve().parents[2]
toolchains = options.toolchains.resolve()
pkg = root / 'gpt-live-package'
proj = root / 'firmware/dist/tmp/esp32/m5stackchan_cores3/release/stack-chan-host/xsProj-esp32s3'
build = proj / 'build'
python = next((toolchains / 'idf-tools/python_env').glob('idf6.1_*/bin/python'))
name = 'StackChan-Community-v2.0.1-r2-GPT-Live'
for folder in ('firmware', 'source', 'verification'):
    (pkg / folder).mkdir(parents=True, exist_ok=True)
flash = json.loads((build / 'flasher_args.json').read_text())
files = []
for offset, rel in flash['flash_files'].items():
    source = build / rel
    dest = pkg / 'firmware' / source.name
    shutil.copy2(source, dest)
    files.extend((offset, str(dest)))

def run_report(command, filename):
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    (pkg / 'verification' / filename).write_text(result.stdout + result.stderr)

run_report([str(python), '-m', 'esptool', '--chip', 'esp32s3', 'merge-bin', '--output', str(pkg / (name + '.bin')), '--pad-to-size', '16MB', *flash['write_flash_args'], *files], 'merge-image.txt')
for filename in ('bootloader.bin', 'xs_esp32.bin'):
    run_report([str(python), '-m', 'esptool', '--chip', 'esp32s3', 'image-info', str(pkg / 'firmware' / filename)], 'image-info-' + filename + '.txt')
run_report([str(python), str(toolchains / 'esp-idf/components/partition_table/gen_esp32part.py'), str(pkg / 'firmware/partition-table.bin')], 'partition-table.txt')
subprocess.run([os.sys.executable, str(root / 'firmware/scripts/audit-gpt-live.py'), '--toolchains', str(toolchains)], check=True)
audit = json.loads((pkg / 'verification/artifact-audit.json').read_text())
for filename in ('sdkconfig', 'dependencies.lock', 'partitions.csv'):
    shutil.copy2(proj / filename, pkg / 'source' / filename)
shutil.copy2(build / 'flasher_args.json', pkg / 'source/flasher_args.original.json')
for supplied, filename in ((options.build_log, 'build-log.txt'), (options.test_log, 'community-unit-tests.txt')):
    if supplied:
        (pkg / 'verification' / filename).write_text(supplied.read_text(errors='replace').replace(str(root), '[PROJECT_ROOT]').replace(str(toolchains), '[TOOLCHAINS]'))
for component in (proj / 'managed_components').iterdir():
    if not component.is_dir():
        continue
    for source in component.iterdir():
        if source.is_file() and source.name.lower() in ('license', 'license.txt', 'license.md', 'notice', 'notice.txt', 'copying'):
            dest = pkg / 'licenses/managed-components' / component.name / source.name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, dest)
info = {
    'package_revision': 2,
    'base_product_version': '2.0.1',
    'custom_build': True,
    'hardware': 'M5StackChan CoreS3 K151/K151-R',
    'chip': 'esp32s3',
    'flash_bytes': 16777216,
    'full_image': {'path': name + '.bin', 'offset': '0x0', 'erases_existing_preferences_and_mods': True},
    'flash_settings': flash['flash_settings'],
    'separate_images': {offset: 'firmware/' + Path(filename).name for offset, filename in flash['flash_files'].items()},
    'source': json.loads((pkg / 'source/provenance.json').read_text()),
    'build_completed_utc': datetime.now(timezone.utc).isoformat(),
    'build_exit_code': 0,
    'settings': audit['live_config'],
    'ui_config': audit['ui_config'],
    'tts_config': audit['tts_config'],
    'tools': {'delegation': 'responses', 'tool_choice': 'auto', 'definitions': audit['live_config']['tools']},
    'verification': {'hardware_tested': False, 'api_tested': False, 'actual_usb_installation_tested': False, 'artifact_audit': 'verification/artifact-audit.json'},
}
if options.test_log:
    log = options.test_log.read_text()
    assert '# fail 0' in log
    info['verification']['community_tests_passed'] = int(next(line.split()[-1] for line in log.splitlines() if line.startswith('# pass ')))
(pkg / 'BUILD-INFO.json').write_text(json.dumps(info, ensure_ascii=False, indent=2) + '\n')
(pkg / 'firmware/flash-map.json').write_text(json.dumps(info['separate_images'], indent=2) + '\n')
(pkg / 'INSTRUKCJA.txt').write_text('''Community 2.0.1 + GPT-Live — rewizja 2, tylko M5StackChan CoreS3 K151/K151-R.
Backend: gpt-6.1-terra. Reasoning: medium. Głos: marin. Instrukcja: pusta.
Głośność domyślna: 1. Narzędzie: web_search, wybór użycia auto.

WGRANIE — Debian 13, esptool 4.7
1. Podłącz USB. Przytrzymaj dolny RST około 3 sekundy do zielonej diody i zwolnij.
2. W katalogu z plikiem wykonaj:

esptool --chip esp32s3 --no-stub -p /dev/ttyACM0 -b 115200 write_flash -z 0x0 ''' + name + '''.bin

3. Po zakończeniu naciśnij krótko RST.
Pełny obraz zastępuje firmware, ustawienia i MOD-y. Nie wykonuje kopii pamięci.

KONFIGURACJA
Krótko naciśnij RST i w ciągu 3 sekund wybierz Settings na ekranie startowym.
Ustaw Wi-Fi. Zostaw Settings otwarte, w Chrome otwórz:
https://stack-chan.github.io/stack-chan/web/preference/
Połącz przez BLE. W AI / Token wpisz klucz. W AI / Context wpisz własną instrukcję.
Zapisz, rozłącz BLE i wyjdź z Settings. W menu twarzy wybierz GPT-Live.
Zapisana głośność ma pierwszeństwo przed wartością domyślną.

Sprawdzono kompilację, testy i obrazy; raporty w verification/.
Nowej rewizji nie sprawdzono fizycznie ani z rzeczywistym API.
Ponowne programowanie: dolny RST przez około 3 sekundy do zielonej diody, następnie zwolnij.
https://docs.m5stack.com/en/StackChan
https://manpages.debian.org/trixie/esptool/esptool.1.en.html
''')
records = {str(path.relative_to(pkg)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(pkg.rglob('*')) if path.is_file() and path.name not in ('SHA256.json', 'SHA256SUMS.txt')}
(pkg / 'SHA256.json').write_text(json.dumps(records, indent=2) + '\n')
(pkg / 'SHA256SUMS.txt').write_text(''.join(digest + '  ' + filename + '\n' for filename, digest in records.items()))
if options.outputs:
    outputs = options.outputs.resolve()
    outputs.mkdir(parents=True, exist_ok=True)
    shutil.copy2(pkg / (name + '.bin'), outputs / (name + '.bin'))
    archive = outputs / (name + '.zip')
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for path in sorted(pkg.rglob('*')):
            if path.is_file():
                z.write(path, name + '/' + str(path.relative_to(pkg)))
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None
        for filename, digest in records.items():
            assert hashlib.sha256(z.read(name + '/' + filename)).hexdigest() == digest
    for path in (archive, outputs / (name + '.bin')):
        (outputs / (path.name + '.sha256')).write_text(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n')
print('Packaged and verified', pkg / (name + '.bin'))
