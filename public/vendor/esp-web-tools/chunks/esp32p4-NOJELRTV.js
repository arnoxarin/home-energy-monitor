import {
  ESP32ROM
} from "./chunk-QWY5OM62.js";
import "./chunk-VTRPW7KE.js";
import "./chunk-SK6HMZ5B.js";

// node_modules/esptool-js/lib/targets/esp32p4.js
var ESP32P4ROM = class extends ESP32ROM {
  constructor() {
    super(...arguments);
    this.CHIP_NAME = "ESP32-P4";
    this.IMAGE_CHIP_ID = 18;
    this.IROM_MAP_START = 1073741824;
    this.IROM_MAP_END = 1275068416;
    this.DROM_MAP_START = 1073741824;
    this.DROM_MAP_END = 1275068416;
    this.BOOTLOADER_FLASH_OFFSET = 8192;
    this.CHIP_DETECT_MAGIC_VALUE = [0, 182303440];
    this.UART_DATE_REG_ADDR = 1343004672 + 140;
    this.EFUSE_BASE = 1343410176;
    this.EFUSE_BLOCK1_ADDR = this.EFUSE_BASE + 68;
    this.MAC_EFUSE_REG = this.EFUSE_BASE + 68;
    this.SPI_REG_BASE = 1342754816;
    this.SPI_USR_OFFS = 24;
    this.SPI_USR1_OFFS = 28;
    this.SPI_USR2_OFFS = 32;
    this.SPI_MOSI_DLEN_OFFS = 36;
    this.SPI_MISO_DLEN_OFFS = 40;
    this.SPI_W0_OFFS = 88;
    this.EFUSE_RD_REG_BASE = this.EFUSE_BASE + 48;
    this.EFUSE_PURPOSE_KEY0_REG = this.EFUSE_BASE + 52;
    this.EFUSE_PURPOSE_KEY0_SHIFT = 24;
    this.EFUSE_PURPOSE_KEY1_REG = this.EFUSE_BASE + 52;
    this.EFUSE_PURPOSE_KEY1_SHIFT = 28;
    this.EFUSE_PURPOSE_KEY2_REG = this.EFUSE_BASE + 56;
    this.EFUSE_PURPOSE_KEY2_SHIFT = 0;
    this.EFUSE_PURPOSE_KEY3_REG = this.EFUSE_BASE + 56;
    this.EFUSE_PURPOSE_KEY3_SHIFT = 4;
    this.EFUSE_PURPOSE_KEY4_REG = this.EFUSE_BASE + 56;
    this.EFUSE_PURPOSE_KEY4_SHIFT = 8;
    this.EFUSE_PURPOSE_KEY5_REG = this.EFUSE_BASE + 56;
    this.EFUSE_PURPOSE_KEY5_SHIFT = 12;
    this.EFUSE_DIS_DOWNLOAD_MANUAL_ENCRYPT_REG = this.EFUSE_RD_REG_BASE;
    this.EFUSE_DIS_DOWNLOAD_MANUAL_ENCRYPT = 1 << 20;
    this.EFUSE_SPI_BOOT_CRYPT_CNT_REG = this.EFUSE_BASE + 52;
    this.EFUSE_SPI_BOOT_CRYPT_CNT_MASK = 7 << 18;
    this.EFUSE_SECURE_BOOT_EN_REG = this.EFUSE_BASE + 56;
    this.EFUSE_SECURE_BOOT_EN_MASK = 1 << 20;
    this.PURPOSE_VAL_XTS_AES256_KEY_1 = 2;
    this.PURPOSE_VAL_XTS_AES256_KEY_2 = 3;
    this.PURPOSE_VAL_XTS_AES128_KEY = 4;
    this.SUPPORTS_ENCRYPTED_FLASH = true;
    this.FLASH_ENCRYPTED_WRITE_ALIGN = 16;
    this.MEMORY_MAP = [
      [0, 65536, "PADDING"],
      [1073741824, 1275068416, "DROM"],
      [1341128704, 1341784064, "DRAM"],
      [1341128704, 1341784064, "BYTE_ACCESSIBLE"],
      [1337982976, 1338114048, "DROM_MASK"],
      [1337982976, 1338114048, "IROM_MASK"],
      [1073741824, 1275068416, "IROM"],
      [1341128704, 1341784064, "IRAM"],
      [1343258624, 1343291392, "RTC_IRAM"],
      [1343258624, 1343291392, "RTC_DRAM"],
      [1611653120, 1611661312, "MEM_INTERNAL2"]
    ];
    this.UF2_FAMILY_ID = 1026592404;
    this.EFUSE_MAX_KEY = 5;
    this.KEY_PURPOSES = {
      0: "USER/EMPTY",
      1: "ECDSA_KEY",
      2: "XTS_AES_256_KEY_1",
      3: "XTS_AES_256_KEY_2",
      4: "XTS_AES_128_KEY",
      5: "HMAC_DOWN_ALL",
      6: "HMAC_DOWN_JTAG",
      7: "HMAC_DOWN_DIGITAL_SIGNATURE",
      8: "HMAC_UP",
      9: "SECURE_BOOT_DIGEST0",
      10: "SECURE_BOOT_DIGEST1",
      11: "SECURE_BOOT_DIGEST2",
      12: "KM_INIT_KEY"
    };
  }
  async getPkgVersion(loader) {
    const numWord = 2;
    const addr = this.EFUSE_BLOCK1_ADDR + 4 * numWord;
    const registerValue = await loader.readReg(addr);
    return registerValue >> 27 & 7;
  }
  async getMinorChipVersion(loader) {
    const numWord = 2;
    const addr = this.EFUSE_BLOCK1_ADDR + 4 * numWord;
    const registerValue = await loader.readReg(addr);
    return registerValue >> 0 & 15;
  }
  async getMajorChipVersion(loader) {
    const numWord = 2;
    const addr = this.EFUSE_BLOCK1_ADDR + 4 * numWord;
    const registerValue = await loader.readReg(addr);
    return registerValue >> 4 & 3;
  }
  async getChipDescription(loader) {
    const pkgVersion = await this.getPkgVersion(loader);
    const chipName = pkgVersion === 0 ? "ESP32-P4" : "unknown ESP32-P4";
    const majorRev = await this.getMajorChipVersion(loader);
    const minorRev = await this.getMinorChipVersion(loader);
    return `${chipName} (revision v${majorRev}.${minorRev})`;
  }
  async getChipFeatures(loader) {
    return ["High-Performance MCU"];
  }
  async getCrystalFreq(loader) {
    return 40;
  }
  async getFlashVoltage(loader) {
    return;
  }
  async overrideVddsdio(loader) {
    loader.debug("VDD_SDIO overrides are not supported for ESP32-P4");
  }
  async readMac(loader) {
    let mac0 = await loader.readReg(this.MAC_EFUSE_REG);
    mac0 = mac0 >>> 0;
    let mac1 = await loader.readReg(this.MAC_EFUSE_REG + 4);
    mac1 = mac1 >>> 0 & 65535;
    const mac = new Uint8Array(6);
    mac[0] = mac1 >> 8 & 255;
    mac[1] = mac1 & 255;
    mac[2] = mac0 >> 24 & 255;
    mac[3] = mac0 >> 16 & 255;
    mac[4] = mac0 >> 8 & 255;
    mac[5] = mac0 & 255;
    return this._d2h(mac[0]) + ":" + this._d2h(mac[1]) + ":" + this._d2h(mac[2]) + ":" + this._d2h(mac[3]) + ":" + this._d2h(mac[4]) + ":" + this._d2h(mac[5]);
  }
  async getFlashCryptConfig(loader) {
    return;
  }
  async getSecureBootEnabled(laoder) {
    const registerValue = await laoder.readReg(this.EFUSE_SECURE_BOOT_EN_REG);
    return registerValue & this.EFUSE_SECURE_BOOT_EN_MASK;
  }
  async getKeyBlockPurpose(loader, keyBlock) {
    if (keyBlock < 0 || keyBlock > this.EFUSE_MAX_KEY) {
      loader.debug(`Valid key block numbers must be in range 0-${this.EFUSE_MAX_KEY}`);
      return;
    }
    const regShiftDictionary = [
      [this.EFUSE_PURPOSE_KEY0_REG, this.EFUSE_PURPOSE_KEY0_SHIFT],
      [this.EFUSE_PURPOSE_KEY1_REG, this.EFUSE_PURPOSE_KEY1_SHIFT],
      [this.EFUSE_PURPOSE_KEY2_REG, this.EFUSE_PURPOSE_KEY2_SHIFT],
      [this.EFUSE_PURPOSE_KEY3_REG, this.EFUSE_PURPOSE_KEY3_SHIFT],
      [this.EFUSE_PURPOSE_KEY4_REG, this.EFUSE_PURPOSE_KEY4_SHIFT],
      [this.EFUSE_PURPOSE_KEY5_REG, this.EFUSE_PURPOSE_KEY5_SHIFT]
    ];
    const [reg, shift] = regShiftDictionary[keyBlock];
    const registerValue = await loader.readReg(reg);
    return registerValue >> shift & 15;
  }
  async isFlashEncryptionKeyValid(loader) {
    const purposes = [];
    for (let i = 0; i <= this.EFUSE_MAX_KEY; i++) {
      const purpose = await this.getKeyBlockPurpose(loader, i);
      purposes.push(purpose);
    }
    const isXtsAes128Key = purposes.find((p) => p === this.PURPOSE_VAL_XTS_AES128_KEY);
    if (typeof isXtsAes128Key !== void 0) {
      return true;
    }
    const isXtsAes256Key1 = purposes.find((p) => p === this.PURPOSE_VAL_XTS_AES256_KEY_1);
    const isXtsAes256Key2 = purposes.find((p) => p === this.PURPOSE_VAL_XTS_AES256_KEY_2);
    if (typeof isXtsAes256Key1 !== void 0 && typeof isXtsAes256Key2 !== void 0) {
      return true;
    }
    return false;
  }
};
export {
  ESP32P4ROM
};
