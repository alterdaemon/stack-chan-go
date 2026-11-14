#ifndef STACKCHAN_PROTECTED_KEY_H
#define STACKCHAN_PROTECTED_KEY_H
#include "esp_efuse.h"

// Preserve the credential store's established selection order and protection contract.
static int stackchanProtectedKey(int selected)
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
#endif
