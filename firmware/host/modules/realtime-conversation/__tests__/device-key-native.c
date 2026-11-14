// Run the production bindings with synthetic keys and fault-injected eFuse/Wi-Fi/PSA I/O.
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <setjmp.h>
#include <stdio.h>
#include <openssl/hmac.h>
#include <openssl/crypto.h>
typedef int xsMachine, esp_err_t, esp_efuse_block_t, hmac_key_id_t, wifi_ps_type_t;
typedef int psa_status_t, psa_key_id_t, psa_key_attributes_t;
typedef struct { int unused; } wifi_ap_record_t;
#define ESP_OK 0
#define ESP_FAIL -1
#define EFUSE_BLK_KEY0 4
#define EFUSE_BLK_KEY5 9
#define ESP_EFUSE_KEY_PURPOSE_HMAC_UP 8
#define ESP_EFUSE_WR_DIS_RD_DIS 1
#define HMAC_KEY5 5
#define WIFI_PS_NONE 0
#define PSA_KEY_ATTRIBUTES_INIT 0
#define PSA_SUCCESS 0
#define PSA_KEY_USAGE_SIGN_MESSAGE 1
#define PSA_KEY_TYPE_HMAC 2
#define PSA_ALG_SHA_256 3
#define PSA_ALG_HMAC(x) (4 + (x))
#define xsArg(n) 0
#define xsResult 0
#define xsmcArgc 1
typedef struct { unsigned char key[32]; bool read, write, purposeLocked; int purpose; } Slot;
static Slot slots[6];
static unsigned writes, zeroedRoot, imports, handles, hmacCalls;
static int result, argument = 5, ps = 1;
static bool locked, coding, failHmac, failRandom, failWifi, failPS, failRestore, failImport, failMAC, failWrite, corruptWrite;
static unsigned char imported[32];
static void *rootPointer;
static jmp_buf exception;
static void xsUnknownError(const char *text) { (void)text; longjmp(exception, 1); }
#define xsRangeError xsUnknownError
static int xsmcToInteger(int slot) { (void)slot; return argument; }
static void xsmcSetInteger(int slot, int value) { (void)slot; result = value; }
static void mbedtls_platform_zeroize(void *data, size_t size) {
    OPENSSL_cleanse(data, size);
    if (data == rootPointer) { for (size_t i = 0; i < size; i++) assert(!((unsigned char *)data)[i]); zeroedRoot++; }
}
static Slot *slotFor(int block) { assert(block >= 4 && block <= 9); return &slots[block - 4]; }
static int esp_efuse_get_key_purpose(int b) { return slotFor(b)->purpose; }
static bool esp_efuse_get_key_dis_read(int b) { return slotFor(b)->read; }
static bool esp_efuse_get_key_dis_write(int b) { return slotFor(b)->write; }
static bool esp_efuse_get_keypurpose_dis_write(int b) { return slotFor(b)->purposeLocked; }
static int esp_efuse_check_errors(void) { return coding ? -1 : 0; }
static bool esp_efuse_read_field_bit(int field) { assert(field == ESP_EFUSE_WR_DIS_RD_DIS); return locked; }
static bool esp_efuse_key_block_unused(int block) {
    Slot empty = {0}; return memcmp(slotFor(block), &empty, sizeof(empty)) == 0;
}
static int esp_hmac_calculate(int index, const void *data, size_t size, unsigned char *out) {
    assert(index >= 0 && index < 6); hmacCalls++;
    unsigned length; return failHmac ? -1 : HMAC(EVP_sha256(), slots[index].key, 32, data, size, out, &length) && length == 32 ? 0 : -1;
}
static int esp_wifi_sta_get_ap_info(wifi_ap_record_t *out) { (void)out; return failWifi ? -1 : 0; }
static int esp_wifi_get_ps(int *out) { *out = ps; return failPS ? -1 : 0; }
static int esp_wifi_set_ps(int value) { if (failPS || (failRestore && value == 1)) return -1; ps = value; return 0; }
static void esp_fill_random(void *data, size_t size) {
    assert(ps == 0 && size == 32); rootPointer = data;
    memset(data, failRandom ? 0 : 0x59, size);
}
static int psa_crypto_init(void) { return 0; }
static void psa_set_key_usage_flags(int *a, int value) { (void)a; assert(value == 1); }
static void psa_set_key_algorithm(int *a, int value) { (void)a; assert(value == 7); }
static void psa_set_key_type(int *a, int value) { (void)a; assert(value == 2); }
static void psa_set_key_bits(int *a, int value) { (void)a; assert(value == 256); }
static void psa_reset_key_attributes(int *a) { *a = 0; }
static int psa_import_key(int *a, const void *data, size_t size, int *key) {
    (void)a; assert(size == 32); if (failImport) return -1;
    assert(!handles); memcpy(imported, data, 32); *key = 1; handles++; imports++; return 0;
}
static int psa_mac_compute(int key, int alg, const void *data, size_t size, unsigned char *out, size_t capacity, size_t *written) {
    assert(key == 1 && alg == 7 && capacity == 32); if (failMAC) return -1;
    unsigned count; assert(HMAC(EVP_sha256(), imported, 32, data, size, out, &count)); *written = count; return 0;
}
static int psa_destroy_key(int key) { assert(key == 1 && handles == 1); handles--; OPENSSL_cleanse(imported, 32); return 0; }
static int esp_efuse_write_key(int block, int purpose, const void *key, size_t size) {
    assert(block == 9 && purpose == 8 && size == 32 && !locked && !coding && !writes);
    assert(esp_efuse_key_block_unused(block)); writes++;
    Slot *s = slotFor(block); memcpy(s->key, key, 32);
    if (failWrite) return -1; // Interrupted programming leaves an occupied, incomplete slot.
    s->read = s->write = s->purposeLocked = true; s->purpose = 8;
    if (corruptWrite) s->key[0] ^= 1;
    return 0;
}
#include "../esp32/device-key.c"
static void reset(void) {
    memset(slots, 0, sizeof(slots)); writes = zeroedRoot = imports = handles = hmacCalls = 0;
    locked = coding = failHmac = failRandom = failWifi = failPS = failRestore = failImport = failMAC = failWrite = corruptWrite = false;
    setupBusy = setupFailed = false; argument = 5; ps = 1; rootPointer = NULL;
}
static void setup(void) { assert(!setjmp(exception)); xs_device_key_setup(NULL); assert(!handles && !setupBusy); }
static void ready(int index) { memset(slots[index].key, 0x36 + index, 32); slots[index].read = slots[index].write = slots[index].purposeLocked = true; slots[index].purpose = 8; }
int main(void) {
    reset(); xs_device_key_status(NULL); assert(result == -1 && !writes && !imports);
    for (int index = 0; index < 6; index++) {
        reset(); ready(index); Slot before[6]; memcpy(before, slots, sizeof(slots));
        xs_device_key_status(NULL); assert(result == index); setup();
        assert(result == index && !writes && !memcmp(before, slots, sizeof(slots)));
    }
    reset(); ready(1); ready(5); setup(); assert(result == 1 && !writes);
    reset(); Slot before[6]; memcpy(before, slots, sizeof(slots)); setup();
    assert(result == 5 && writes == 1 && zeroedRoot == 1 && ps == 1);
    assert(!memcmp(before, slots, 5 * sizeof(Slot))); assert(slots[5].purpose == 8 && slots[5].read && slots[5].write && slots[5].purposeLocked);
    setup(); assert(result == 5 && writes == 1); // Lost response/repeated POST is a no-op.
    for (int field = 0; field < 5; field++) {
        reset(); if (field == 0) slots[5].key[0] = 1;
        if (field == 1) slots[5].read = true; if (field == 2) slots[5].write = true;
        if (field == 3) slots[5].purposeLocked = true; if (field == 4) slots[5].purpose = 7;
        setup(); assert(result == -2 && !writes);
    }
    reset(); locked = true; setup(); assert(result == -3 && !writes);
    reset(); coding = true; setup(); assert(result == -4 && !writes);
    reset(); ready(5); failHmac = true; setup(); assert(result == -5 && !writes);
    bool *faults[] = { &failWifi, &failPS, &failRestore, &failRandom, &failImport, &failMAC };
    for (size_t i = 0; i < sizeof(faults)/sizeof(faults[0]); i++) {
        reset(); *faults[i] = true; setup(); assert(result < 0 && !writes);
        if (rootPointer) assert(zeroedRoot == 1);
    }
    reset(); failWrite = true; setup(); assert(result == -6 && writes == 1 && zeroedRoot == 1);
    failWrite = false; setup(); assert(result == -6 && writes == 1);
    setupFailed = false; xs_device_key_status(NULL); assert(result == -2); // Reboot sees partial key; no repair.
    reset(); corruptWrite = true; setup(); assert(result == -6 && writes == 1 && zeroedRoot == 1);
    reset(); argument = 4; if (!setjmp(exception)) { xs_device_key_setup(NULL); assert(false); } assert(!writes);
    reset(); setupBusy = true; if (!setjmp(exception)) { xs_device_key_setup(NULL); assert(false); } assert(!writes);
    puts("device key native PASS: existing/unused/blocked/fault/duplicate/cleanup");
}
