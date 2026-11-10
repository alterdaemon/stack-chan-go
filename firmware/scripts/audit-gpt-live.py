from pathlib import Path
import argparse,hashlib,json,shutil,struct,subprocess
parser=argparse.ArgumentParser()
parser.add_argument('--toolchains',type=Path,required=True)
args_cli=parser.parse_args()
root=Path(__file__).resolve().parents[2]
toolchains=args_cli.toolchains.resolve()
pkg=root/'gpt-live-package'
base=root/'firmware/dist'
tmp=base/'tmp/esp32/m5stackchan_cores3/release/stack-chan-host'
proj=tmp/'xsProj-esp32s3'
build=proj/'build' 
checks={}
args=json.loads((build/'flasher_args.json').read_text())
full=(pkg/'StackChan-Community-v2.0.1-GPT-Live-r2.bin').read_bytes()
assert len(full)==0x1000000
expected=bytearray(b'\xff'*len(full));ranges=[]
for address,rel in args['flash_files'].items():
 offset=int(address,0);data=(pkg/'firmware'/Path(rel).name).read_bytes();end=offset+len(data)
 assert end<=len(full) and all(end<=a or offset>=b for a,b in ranges)
 expected[offset:end]=data;ranges.append((offset,end))
assert full==expected
checks['merged_image_matches_generated_flash_addresses']=True
checks['image_size_bytes']=len(full)
ptable=(pkg/'firmware/partition-table.bin').read_bytes();entries=[]
for i in range(0,len(ptable),32):
 record=ptable[i:i+32];magic=struct.unpack_from('<H',record)[0]
 if magic==0xebeb:
  assert hashlib.md5(ptable[:i]).digest()==record[16:32];checks['partition_table_md5_valid']=True;break
 if magic==0xffff:break
 assert magic==0x50aa
 magic,typ,subtyp,offset,size,label,flags=struct.unpack('<HBBII16sI',record)
 label=label.split(b'\0')[0].decode();assert offset+size<=len(full)
 assert all(offset>=p['offset']+p['size'] or offset+size<=p['offset'] for p in entries)
 entries.append(dict(name=label,type=typ,subtype=subtyp,offset=offset,size=size))
checks['partition_table_md5_present']=checks.get('partition_table_md5_valid',False)
if not checks['partition_table_md5_present']:
 assert '# CONFIG_PARTITION_TABLE_MD5 is not set' in (proj/'sdkconfig').read_text()
factory=next(p for p in entries if p['type']==0 and p['subtype']==0)
app=(pkg/'firmware/xs_esp32.bin').read_bytes();boot=(pkg/'firmware/bootloader.bin').read_bytes()
assert len(app)<=factory['size'] and factory['offset']==int(args['app']['offset'],0)
assert len(boot)<=int(args['partition-table']['offset'],0)
for data in (app,boot):assert data[0]==0xe9 and struct.unpack_from('<H',data,12)[0]==9
checks['chip_id_esp32s3']=True;checks['app_fits_factory_partition']=True;checks['bootloader_fits_before_partition_table']=True
checks['partitions']=entries;checks['application_size_bytes']=len(app);checks['factory_partition_size_bytes']=factory['size']
for name in ('xs','storage','nvs'):
 p=next(p for p in entries if p['name']==name);assert full[p['offset']:p['offset']+p['size']]==b'\xff'*p['size']
checks['old_mods_and_preferences_erased_by_full_image']=True
cfg=(proj/'sdkconfig').read_text()
for key in ['CONFIG_SECURE_BOOT','CONFIG_SECURE_FLASH_ENC_ENABLED','CONFIG_SECURE_ENABLE_SECURE_ROM_DL_MODE','CONFIG_SECURE_DISABLE_ROM_DL_MODE']:
 assert key+'=y' not in cfg;checks[key]=False
flat=json.loads((tmp/'manifest_flat.json').read_text())
required=['openai-live-integrated','openai-live-session','openai-live-settings','realtimeConversation','realtimeConversation/core','realtimeConversation/http-worker','realtimeConversation/transport']
assert all(k in flat['modules'] for k in required)
assert 'apiKey' not in flat['config']['openaiLive']
assert flat['config']['openaiLive']['backendModel']=='gpt-6.1-terra'
assert flat['config']['openaiLive']['reasoningEffort']=='medium'
assert flat['config']['openaiLive']['instructions']==''
assert flat['config']['openaiLive']['tools']==[{'type':'web_search'}]
assert flat['config']['openaiLive']['volume']==1
assert flat['config']['tts']['volume']==1
checks['integrated_modules']=required;checks['live_config']=flat['config']['openaiLive'];checks['ui_config']=flat['config']['ui'];checks['tts_config']=flat['config']['tts'];checks['embedded_api_key']=False
nm=next((toolchains/'idf-tools/tools/xtensa-esp-elf').rglob('bin/xtensa-esp-elf-nm'))
results={}
unsafe=['esp_efuse_disable_rom_download_mode','esp_efuse_enable_rom_secure_download_mode','esp_secure_boot_enable_secure_features']
for name,elf in [('app',build/'xs_esp32.elf'),('bootloader',build/'bootloader/bootloader.elf')]:
 out=subprocess.run([str(nm),str(elf)],check=True,capture_output=True,text=True).stdout
 symbols={line.split()[-1] for line in out.splitlines() if line.split()}
 assert not any(x in symbols for x in unsafe)
 results[name]={'rom_download_lock_functions_absent':True}
 if name=='app':
  native=['xs_live_transport_constructor','xs_live_transport_start','xs_live_transport_answer','xs_live_transport_close']
  assert all(x in symbols for x in native);results[name]['linked_gpt_live_native_symbols']=native
checks['elf_symbol_checks']=results
(pkg/'verification/artifact-audit.json').write_text(json.dumps(checks,indent=2,ensure_ascii=False)+'\n')
print(json.dumps({k:v for k,v in checks.items() if k not in ('live_config','partitions','integrated_modules')},indent=2))
