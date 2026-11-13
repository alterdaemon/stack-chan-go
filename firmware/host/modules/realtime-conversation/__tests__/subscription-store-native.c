// Executes the production vault bindings with OpenSSL-backed PSA and fault-injected NVS/eFuse I/O.
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <setjmp.h>
#include <stdio.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>

typedef int xsMachine, xsUnsignedValue, esp_err_t, nvs_handle_t, esp_efuse_block_t, hmac_key_id_t;
typedef int psa_status_t, psa_key_id_t, psa_key_attributes_t;
#define ESP_OK 0
#define ESP_FAIL -1
#define ESP_ERR_NVS_NOT_FOUND -2
#define NVS_READONLY 0
#define NVS_READWRITE 1
#define EFUSE_BLK_KEY0 4
#define ESP_EFUSE_KEY_PURPOSE_HMAC_UP 8
#define PSA_SUCCESS 0
#define PSA_ERROR_BAD_STATE -1
#define PSA_KEY_ATTRIBUTES_INIT 0
#define PSA_KEY_USAGE_ENCRYPT 1
#define PSA_KEY_USAGE_DECRYPT 2
#define PSA_ALG_GCM 3
#define PSA_KEY_TYPE_AES 4
#define xsArg(n) 0
#define xsResult 0
#define xsException 0
#define xsTry if (1)
#define xsCatch else
#define c_memcpy memcpy
static jmp_buf failure;
static unsigned char disk[8192], resultData[8192], cryptoKey[32], hardwareKey[32], mac[6];
static size_t diskLength, resultLength, argumentLength;
static const unsigned char *argument;
static bool resultBoolean, keyEnabled, protectRead, protectWrite, protectPurpose;
static bool failOpen, failGet, failSet, failCommit, failHMAC, failImport, failCrypto, failAllocate;
static unsigned int nonceCounter;
static int liveKeys, activeHandles, allocations;
static void *c_malloc(size_t size) { void *p = failAllocate ? NULL : malloc(size); if (p) allocations++; return p; }
static void c_free(void *p) { if (p) allocations--; free(p); }
static void xsUnknownError(const char *message) { assert(strstr(message, "secret") == NULL); longjmp(failure, 1); }
static void xsThrow(int unused) { (void)unused; longjmp(failure, 1); }
static void xsmcGetBufferReadable(int slot, void **data, xsUnsignedValue *length) { (void)slot; *data = (void *)argument; *length = (int)argumentLength; }
static void xsmcSetBoolean(int slot, bool value) { (void)slot; resultBoolean = value; }
static void xsmcSetArrayBuffer(int slot, const void *data, size_t length) { (void)slot; assert(length <= sizeof(resultData)); memcpy(resultData, data, length); resultLength = length; }
static void mbedtls_platform_zeroize(void *data, size_t length) { OPENSSL_cleanse(data, length); }
static int esp_efuse_get_key_purpose(int block) { return keyEnabled && block == EFUSE_BLK_KEY0 ? 8 : 0; }
static bool esp_efuse_get_key_dis_read(int block) { (void)block; return protectRead; }
static bool esp_efuse_get_key_dis_write(int block) { (void)block; return protectWrite; }
static bool esp_efuse_get_keypurpose_dis_write(int block) { (void)block; return protectPurpose; }
static int esp_efuse_mac_get_default(unsigned char *out) { memcpy(out, mac, 6); return 0; }
static int esp_hmac_calculate(int key, const void *data, size_t length, unsigned char *out) {
    assert(key == 0); if (failHMAC) return -1;
    unsigned int written; return HMAC(EVP_sha256(), hardwareKey, 32, data, length, out, &written) && written == 32 ? 0 : -1;
}
static void esp_fill_random(void *data, size_t length) { memset(data, ++nonceCounter, length); }
static int psa_crypto_init(void) { return 0; }
static void psa_set_key_usage_flags(int *a, int v) { (void)a; assert(v == 3); }
static void psa_set_key_algorithm(int *a, int v) { (void)a; assert(v == PSA_ALG_GCM); }
static void psa_set_key_type(int *a, int v) { (void)a; assert(v == PSA_KEY_TYPE_AES); }
static void psa_set_key_bits(int *a, int v) { (void)a; assert(v == 256); }
static void psa_reset_key_attributes(int *a) { *a = 0; }
static int psa_import_key(int *a, const unsigned char *data, size_t length, int *key) {
    (void)a; assert(length == 32); if (failImport) return -1;
    assert(!liveKeys); memcpy(cryptoKey, data, 32); *key = 1; liveKeys++; return 0;
}
static int psa_destroy_key(int key) { assert(key == 1 && liveKeys == 1); liveKeys--; OPENSSL_cleanse(cryptoKey, 32); return 0; }
static int psa_aead_encrypt(int key, int algorithm, const unsigned char *nonce, size_t nonceLength,
    const unsigned char *aad, size_t aadLength, const unsigned char *input, size_t length,
    unsigned char *out, size_t capacity, size_t *written) {
    assert(key == 1 && algorithm == PSA_ALG_GCM && capacity >= length + 16); if (failCrypto) return -1;
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new(); int count, total;
    assert(EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), NULL, NULL, NULL));
    assert(EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, (int)nonceLength, NULL));
    assert(EVP_EncryptInit_ex(ctx, NULL, NULL, cryptoKey, nonce));
    assert(EVP_EncryptUpdate(ctx, NULL, &count, aad, (int)aadLength));
    assert(EVP_EncryptUpdate(ctx, out, &count, input, (int)length)); total = count;
    assert(EVP_EncryptFinal_ex(ctx, out + total, &count)); total += count;
    assert(EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, 16, out + total));
    *written = (size_t)total + 16; EVP_CIPHER_CTX_free(ctx); return 0;
}
static int psa_aead_decrypt(int key, int algorithm, const unsigned char *nonce, size_t nonceLength,
    const unsigned char *aad, size_t aadLength, const unsigned char *input, size_t length,
    unsigned char *out, size_t capacity, size_t *written) {
    assert(key == 1 && algorithm == PSA_ALG_GCM && length >= 16 && capacity >= length - 16); if (failCrypto) return -1;
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new(); int count, total;
    assert(EVP_DecryptInit_ex(ctx, EVP_aes_256_gcm(), NULL, NULL, NULL));
    assert(EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, (int)nonceLength, NULL));
    assert(EVP_DecryptInit_ex(ctx, NULL, NULL, cryptoKey, nonce));
    assert(EVP_DecryptUpdate(ctx, NULL, &count, aad, (int)aadLength));
    assert(EVP_DecryptUpdate(ctx, out, &count, input, (int)length - 16)); total = count;
    assert(EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG, 16, (void *)(input + length - 16)));
    int ok = EVP_DecryptFinal_ex(ctx, out + total, &count); *written = ok ? (size_t)(total + count) : 0;
    EVP_CIPHER_CTX_free(ctx); return ok ? 0 : -1;
}
static int nvs_open(const char *name, int mode, int *handle) {
    assert(!strcmp(name, "sc_chatauth")); assert(mode == NVS_READWRITE || mode == NVS_READONLY);
    if (failOpen) return -1; *handle = 1; activeHandles++; return 0;
}
static void nvs_close(int handle) { assert(handle == 1 && activeHandles == 1); activeHandles--; }
static int nvs_get_blob(int handle, const char *name, void *out, size_t *length) {
    assert(handle == 1 && !strcmp(name, "grant")); if (failGet) return -1;
    if (!diskLength) return ESP_ERR_NVS_NOT_FOUND;
    if (!out) { *length = diskLength; return 0; }
    assert(*length >= diskLength); memcpy(out, disk, diskLength); *length = diskLength; return 0;
}
static int nvs_set_blob(int handle, const char *name, const void *data, size_t length) {
    assert(handle == 1 && !strcmp(name, "grant") && length <= sizeof(disk)); if (failSet) return -1;
    // IDF may persist the new value before nvs_commit. Faults must not assume rollback.
    memcpy(disk, data, length); diskLength = length; return 0;
}
static int nvs_commit(int handle) { assert(handle == 1); return failCommit ? -1 : 0; }

#include "../esp32/subscription-store.c"

typedef void (*Binding)(xsMachine *);
static bool run(Binding binding) {
    resultLength = 0;
    if (setjmp(failure)) { assert(liveKeys == 0 && activeHandles == 0 && allocations == 0); return false; }
    binding(NULL); assert(liveKeys == 0 && activeHandles == 0 && allocations == 0); return true;
}
static void save(const char *text) { argument = (const unsigned char *)text; argumentLength = strlen(text); assert(run(xs_subscription_store_write)); }
static void expectText(const char *text) { assert(run(xs_subscription_store_read)); assert(resultLength == strlen(text)); assert(!memcmp(resultData, text, resultLength)); }
static bool contains(const unsigned char *bytes, size_t length, const char *text) {
    for (size_t i = 0; i + strlen(text) <= length; i++) if (!memcmp(bytes + i, text, strlen(text))) return true;
    return false;
}
int main(void) {
    unsigned char validBlob[8192]; size_t validLength;
    const char *secret = "{\"refreshToken\":\"synthetic-refresh-secret\"}";
    memset(hardwareKey, 0x59, sizeof(hardwareKey));
    assert(run(xs_subscription_store_available) && !resultBoolean);
    argument = (const unsigned char *)secret; argumentLength = strlen(secret);
    assert(!run(xs_subscription_store_write) && !diskLength);
    keyEnabled = true;
    for (int step = 0; step < 3; step++) {
        assert(run(xs_subscription_store_available) && !resultBoolean);
        if (step == 0) protectRead = true; else if (step == 1) protectWrite = true; else protectPurpose = true;
    }
    assert(run(xs_subscription_store_available) && resultBoolean);
    assert(run(xs_subscription_store_read) && !resultLength);
    save(secret); expectText(secret);
    assert(!contains(disk, diskLength, "synthetic-refresh-secret"));
    memcpy(validBlob, disk, diskLength); validLength = diskLength;
    save(secret); assert(memcmp(disk, validBlob, validLength)); expectText(secret);
    // Every header, nonce, ciphertext and tag byte is authenticated or strictly rejected.
    for (size_t i = 0; i < validLength; i++) {
        memcpy(disk, validBlob, validLength); diskLength = validLength; disk[i] ^= 0x40;
        assert(!run(xs_subscription_store_read) && !resultLength);
    }
    memcpy(disk, validBlob, validLength); diskLength = validLength;
    mac[0] = 1; assert(!run(xs_subscription_store_read)); mac[0] = 0;
    hardwareKey[0] ^= 1; assert(!run(xs_subscription_store_read)); hardwareKey[0] ^= 1;
    expectText(secret);
    bool *faults[] = { &failOpen, &failSet, &failCommit, &failHMAC, &failImport, &failCrypto, &failAllocate };
    for (size_t i = 0; i < sizeof(faults) / sizeof(faults[0]); i++) {
        *faults[i] = true; assert(!run(xs_subscription_store_write)); *faults[i] = false;
        expectText(secret);
    }
    bool *readFaults[] = { &failOpen, &failGet, &failHMAC, &failImport, &failCrypto, &failAllocate };
    for (size_t i = 0; i < sizeof(readFaults) / sizeof(readFaults[0]); i++) {
        *readFaults[i] = true; assert(!run(xs_subscription_store_read) && !resultLength); *readFaults[i] = false;
        expectText(secret);
    }
    failGet = true; assert(!run(xs_subscription_store_read)); failGet = false;
    // Bounds include a maximal permitted plaintext, empty input and oversized input.
    unsigned char maximum[STORE_LIMIT + 1]; memset(maximum, 'a', sizeof(maximum));
    argument = maximum; argumentLength = STORE_LIMIT; assert(run(xs_subscription_store_write));
    assert(run(xs_subscription_store_read) && resultLength == STORE_LIMIT);
    argumentLength++; assert(!run(xs_subscription_store_write)); argumentLength = 0; assert(!run(xs_subscription_store_write));
    // Truncation and malformed/random records must fail without native memory violations.
    for (size_t length = 0; length < validLength; length++) {
        memcpy(disk, validBlob, validLength); diskLength = length;
        if (!length) assert(run(xs_subscription_store_read)); else assert(!run(xs_subscription_store_read));
    }
    for (int i = 0; i < 512; i++) {
        diskLength = (size_t)(rand() % sizeof(disk));
        for (size_t j = 0; j < diskLength; j++) disk[j] = (unsigned char)rand();
        if (diskLength) assert(!run(xs_subscription_store_read)); else assert(run(xs_subscription_store_read));
    }
    save(secret); assert(run(xs_subscription_store_clear)); assert(run(xs_subscription_store_read) && !resultLength);
    assert(diskLength == 1 && disk[0] == 0);
    puts("Native vault: protected-key checks, AES-GCM round-trip/tamper/device binding, bounds, faults and tombstone PASS");
    return 0;
}
