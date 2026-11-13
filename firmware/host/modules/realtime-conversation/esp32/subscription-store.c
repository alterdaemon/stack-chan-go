// Account secrets are sealed independently of ordinary, unencrypted preferences.
// Uses an already provisioned read/write-protected HMAC_UP key; never burns fuses.
#include "xsmc.h"
#include "xsHost.h"
#include "esp_efuse.h"
#include "esp_hmac.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "nvs.h"
#include "psa/crypto.h"
#include "mbedtls/platform_util.h"

#define STORE_LIMIT 4096
#define HEADER_BYTES 5
#define NONCE_BYTES 12
#define TAG_BYTES 16
#define STORE_OVERHEAD (HEADER_BYTES + NONCE_BYTES + TAG_BYTES)
static const char *storeNamespace = "sc_chatauth";
static const char *storeKey = "grant";
static const uint8_t storeDomain[] = "stackchan-chatgpt-auth-v1";

static int protectedKey(int selected)
{
	for (int index = 0; index < 6; index++) {
		esp_efuse_block_t block = (esp_efuse_block_t)(EFUSE_BLK_KEY0 + index);
		if ((selected >= 0) && (selected != index)) continue;
		if ((esp_efuse_get_key_purpose(block) == ESP_EFUSE_KEY_PURPOSE_HMAC_UP) &&
			esp_efuse_get_key_dis_read(block) && esp_efuse_get_key_dis_write(block) &&
			esp_efuse_get_keypurpose_dis_write(block)) return index;
	}
	return -1;
}

static psa_status_t importKey(int index, psa_key_id_t *key)
{
	uint8_t material[32], context[sizeof(storeDomain) + 6];
	psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
	psa_status_t result = PSA_ERROR_BAD_STATE;
	c_memcpy(context, storeDomain, sizeof(storeDomain));
	if ((ESP_OK != esp_efuse_mac_get_default(context + sizeof(storeDomain))) ||
		(ESP_OK != esp_hmac_calculate((hmac_key_id_t)index, context, sizeof(context), material))) goto done;
	result = psa_crypto_init();
	if (PSA_SUCCESS != result) goto done;
	psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_ENCRYPT | PSA_KEY_USAGE_DECRYPT);
	psa_set_key_algorithm(&attributes, PSA_ALG_GCM);
	psa_set_key_type(&attributes, PSA_KEY_TYPE_AES);
	psa_set_key_bits(&attributes, 256);
	result = psa_import_key(&attributes, material, sizeof(material), key);
done:
	mbedtls_platform_zeroize(material, sizeof(material));
	mbedtls_platform_zeroize(context, sizeof(context));
	psa_reset_key_attributes(&attributes);
	return result;
}

static esp_err_t replaceBlob(const void *bytes, size_t length)
{
	nvs_handle_t handle;
	esp_err_t result = nvs_open(storeNamespace, NVS_READWRITE, &handle);
	if (ESP_OK != result) return result;
	// Keep one fixed NVS type. Do not erase the previous value before replacement.
	result = nvs_set_blob(handle, storeKey, bytes, length);
	if (ESP_OK == result) result = nvs_commit(handle);
	nvs_close(handle);
	return result;
}

void xs_subscription_store_available(xsMachine *the)
{
	xsmcSetBoolean(xsResult, protectedKey(-1) >= 0);
}

void xs_subscription_store_clear(xsMachine *the)
{
	// A committed tombstone also invalidates an interrupted refresh before any request.
	const uint8_t tombstone = 0;
	if (ESP_OK != replaceBlob(&tombstone, sizeof(tombstone))) xsUnknownError("Secure sign-in storage failed");
}

void xs_subscription_store_write(xsMachine *the)
{
	void *input;
	xsUnsignedValue length;
	xsmcGetBufferReadable(xsArg(0), &input, &length);
	if (!length || (length > STORE_LIMIT)) xsUnknownError("Sign-in record exceeds storage limit");
	int index = protectedKey(-1);
	if (index < 0) xsUnknownError("Secure sign-in storage unavailable");
	uint8_t *blob = c_malloc(length + STORE_OVERHEAD);
	if (!blob) xsUnknownError("Secure sign-in storage failed");
	psa_key_id_t key = 0;
	size_t written = 0;
	psa_status_t result = importKey(index, &key);
	blob[0] = 'S'; blob[1] = 'C'; blob[2] = 'A'; blob[3] = 1; blob[4] = (uint8_t)index;
	esp_fill_random(blob + HEADER_BYTES, NONCE_BYTES);
	if (PSA_SUCCESS == result)
		result = psa_aead_encrypt(key, PSA_ALG_GCM, blob + HEADER_BYTES, NONCE_BYTES,
			blob, HEADER_BYTES, input, length, blob + HEADER_BYTES + NONCE_BYTES,
			length + TAG_BYTES, &written);
	if (key) psa_destroy_key(key);
	esp_err_t saved = ESP_FAIL;
	if ((PSA_SUCCESS == result) && (written == length + TAG_BYTES)) saved = replaceBlob(blob, length + STORE_OVERHEAD);
	mbedtls_platform_zeroize(blob, length + STORE_OVERHEAD);
	c_free(blob);
	if (ESP_OK != saved) xsUnknownError("Secure sign-in storage failed");
}

void xs_subscription_store_read(xsMachine *the)
{
	nvs_handle_t handle;
	size_t length = 0;
	esp_err_t result = nvs_open(storeNamespace, NVS_READONLY, &handle);
	if (ESP_ERR_NVS_NOT_FOUND == result) return;
	if (ESP_OK != result) xsUnknownError("Secure sign-in storage failed");
	result = nvs_get_blob(handle, storeKey, NULL, &length);
	if (ESP_ERR_NVS_NOT_FOUND == result) { nvs_close(handle); return; }
	if ((ESP_OK != result) || !length || (length > STORE_LIMIT + STORE_OVERHEAD)) {
		nvs_close(handle); xsUnknownError("Invalid secure sign-in record");
	}
	const size_t allocated = length;
	uint8_t *blob = c_malloc(allocated);
	if (!blob) { nvs_close(handle); xsUnknownError("Secure sign-in storage failed"); }
	result = nvs_get_blob(handle, storeKey, blob, &length);
	nvs_close(handle);
	if ((ESP_OK == result) && (length == 1) && (blob[0] == 0)) { c_free(blob); return; }
	if ((ESP_OK != result) || (length > allocated) || (length <= STORE_OVERHEAD) || (blob[0] != 'S') || (blob[1] != 'C') ||
		(blob[2] != 'A') || (blob[3] != 1) || (blob[4] >= 6) || (protectedKey(blob[4]) < 0)) {
		mbedtls_platform_zeroize(blob, allocated); c_free(blob); xsUnknownError("Invalid secure sign-in record");
	}
	psa_key_id_t key = 0;
	size_t written = 0, capacity = length - STORE_OVERHEAD;
	uint8_t *plain = c_malloc(capacity);
	if (!plain) { c_free(blob); xsUnknownError("Secure sign-in storage failed"); }
	psa_status_t status = importKey(blob[4], &key);
	if (PSA_SUCCESS == status)
		status = psa_aead_decrypt(key, PSA_ALG_GCM, blob + HEADER_BYTES, NONCE_BYTES,
			blob, HEADER_BYTES, blob + HEADER_BYTES + NONCE_BYTES,
			length - HEADER_BYTES - NONCE_BYTES, plain, capacity, &written);
	if (key) psa_destroy_key(key);
	// Allocate the XS result only after authentication; always release native buffers on XS failure.
	xsTry {
		if ((PSA_SUCCESS == status) && (written == capacity)) xsmcSetArrayBuffer(xsResult, plain, written);
	}
	xsCatch {
		mbedtls_platform_zeroize(plain, capacity); c_free(plain);
		mbedtls_platform_zeroize(blob, allocated); c_free(blob);
		xsThrow(xsException);
	}
	mbedtls_platform_zeroize(plain, capacity); c_free(plain);
	mbedtls_platform_zeroize(blob, allocated); c_free(blob);
	if ((PSA_SUCCESS != status) || (written != capacity)) xsUnknownError("Invalid secure sign-in record");
}
