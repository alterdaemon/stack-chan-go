// Generic device-root-key setup. This module never reads or writes user storage.
#include "xsmc.h"
#include <stdbool.h>
#include "xsHost.h"
#include "protected-key.h"
#include "esp_efuse_table.h"
#include "esp_hmac.h"
#include "esp_random.h"
#include "esp_wifi.h"
#include "psa/crypto.h"
#include "mbedtls/platform_util.h"

// Virtual SDK builds may dump pending keys and cannot establish hardware readiness.
#if defined(CONFIG_EFUSE_VIRTUAL) || defined(CONFIG_EFUSE_VIRTUAL_LOG_ALL_WRITES)
#error "Device root key setup must not ship with virtual eFuses"
#endif

enum { KEY_SETUP_REQUIRED = -1, KEY_OCCUPIED = -2, KEY_LOCKED = -3,
	KEY_CODING_ERROR = -4, KEY_HMAC_ERROR = -5, KEY_SETUP_FAILED = -6, KEY_ENTROPY_UNAVAILABLE = -7 };
static bool setupBusy, setupFailed;
static const uint8_t challenge[] = "stackchan-device-root-key-check-v1";

static int keyStatus(void)
{
	if (setupFailed) return KEY_SETUP_FAILED;
	if (ESP_OK != esp_efuse_check_errors()) return KEY_CODING_ERROR;
	int index = stackchanProtectedKey(-1);
	if (index >= 0) {
		uint8_t digest[32];
		esp_err_t result = esp_hmac_calculate((hmac_key_id_t)index, challenge, sizeof(challenge), digest);
		mbedtls_platform_zeroize(digest, sizeof(digest));
		return ESP_OK == result ? index : KEY_HMAC_ERROR;
	}
	if (!esp_efuse_key_block_unused(EFUSE_BLK_KEY5)) return KEY_OCCUPIED;
	if (esp_efuse_read_field_bit(ESP_EFUSE_WR_DIS_RD_DIS)) return KEY_LOCKED;
	return KEY_SETUP_REQUIRED;
}

void xs_device_key_status(xsMachine *the)
{
	xsmcSetInteger(xsResult, keyStatus());
}

void xs_device_key_setup(xsMachine *the)
{
	if ((xsmcArgc != 1) || (xsmcToInteger(xsArg(0)) != 5)) xsRangeError("Explicit slot 5 setup required");
	if (setupBusy) xsUnknownError("Secure storage setup is busy");
	setupBusy = true;
	int result = keyStatus();
	uint8_t root[32] = {0}, expected[32] = {0}, actual[32] = {0};
	psa_key_id_t key = 0;
	psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
	size_t written = 0;
	wifi_ap_record_t ap;
	wifi_ps_type_t previousPS;
	if (result != KEY_SETUP_REQUIRED) goto done;
	// An active STA and disabled power saving keep the RF entropy source available.
	if ((ESP_OK != esp_wifi_sta_get_ap_info(&ap)) || (ESP_OK != esp_wifi_get_ps(&previousPS)) ||
		(ESP_OK != esp_wifi_set_ps(WIFI_PS_NONE))) { result = KEY_ENTROPY_UNAVAILABLE; goto done; }
	esp_fill_random(root, sizeof(root));
	if (ESP_OK != esp_wifi_set_ps(previousPS)) { result = KEY_ENTROPY_UNAVAILABLE; goto done; }
	unsigned any = 0;
	for (size_t i = 0; i < sizeof(root); i++) any |= root[i];
	if (!any) { result = KEY_ENTROPY_UNAVAILABLE; goto done; }
	if (PSA_SUCCESS != psa_crypto_init()) { result = KEY_SETUP_FAILED; goto done; }
	psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_SIGN_MESSAGE);
	psa_set_key_algorithm(&attributes, PSA_ALG_HMAC(PSA_ALG_SHA_256));
	psa_set_key_type(&attributes, PSA_KEY_TYPE_HMAC);
	psa_set_key_bits(&attributes, 256);
	if ((PSA_SUCCESS != psa_import_key(&attributes, root, sizeof(root), &key)) ||
		(PSA_SUCCESS != psa_mac_compute(key, PSA_ALG_HMAC(PSA_ALG_SHA_256), challenge, sizeof(challenge),
			expected, sizeof(expected), &written)) || (written != sizeof(expected))) {
		result = KEY_SETUP_FAILED; goto done;
	}
	// This single SDK operation batches exactly key 5 and its required protection/purpose fields.
	// The SDK owns its bounded low-level pulse verification; there is no application retry.
	if ((result = keyStatus()) != KEY_SETUP_REQUIRED) goto done;
	setupFailed = true; // An uncertain commit must never be retried or reported ready in this boot.
	if ((ESP_OK != esp_efuse_write_key(EFUSE_BLK_KEY5, ESP_EFUSE_KEY_PURPOSE_HMAC_UP, root, sizeof(root))) ||
		(ESP_OK != esp_efuse_check_errors()) || (stackchanProtectedKey(5) != 5) ||
		(ESP_OK != esp_hmac_calculate(HMAC_KEY5, challenge, sizeof(challenge), actual))) {
		result = KEY_SETUP_FAILED; goto done;
	}
	unsigned difference = 0;
	for (size_t i = 0; i < sizeof(expected); i++) difference |= expected[i] ^ actual[i];
	if (difference) { result = KEY_SETUP_FAILED; goto done; }
	setupFailed = false;
	result = 5;
done:
	if (key) psa_destroy_key(key);
	psa_reset_key_attributes(&attributes);
	mbedtls_platform_zeroize(root, sizeof(root));
	mbedtls_platform_zeroize(expected, sizeof(expected));
	mbedtls_platform_zeroize(actual, sizeof(actual));
	setupBusy = false;
	xsmcSetInteger(xsResult, result);
}
