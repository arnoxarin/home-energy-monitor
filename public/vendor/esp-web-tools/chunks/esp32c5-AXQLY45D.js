import {
  ESP32C6ROM
} from "./chunk-NOAKG5GB.js";
import "./chunk-VTRPW7KE.js";
import "./chunk-SK6HMZ5B.js";

// node_modules/esptool-js/lib/targets/esp32c5.js
var ESP32C5ROM = class extends ESP32C6ROM {
  constructor() {
    super(...arguments);
    this.CHIP_NAME = "ESP32-C5";
    this.IMAGE_CHIP_ID = 23;
    this.BOOTLOADER_FLASH_OFFSET = 8192;
    this.EFUSE_BASE = 1611352064;
    this.EFUSE_BLOCK1_ADDR = this.EFUSE_BASE + 68;
    this.MAC_EFUSE_REG = this.EFUSE_BASE + 68;
    this.UART_CLKDIV_REG = 1610612756;
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
    this.IROM_MAP_START = 1107296256;
    this.IROM_MAP_END = 1115684864;
    this.DROM_MAP_START = 1115684864;
    this.DROM_MAP_END = 1124073472;
    this.PCR_SYSCLK_CONF_REG = 1611227408;
    this.PCR_SYSCLK_XTAL_FREQ_V = 127 << 24;
    this.PCR_SYSCLK_XTAL_FREQ_S = 24;
    this.XTAL_CLK_DIVIDER = 1;
    this.UARTDEV_BUF_NO = 1082520860;
    this.CHIP_DETECT_MAGIC_VALUE = [285294703, 1675706479, 1607549039];
    this.FLASH_FREQUENCY = {
      "80m": 15,
      "40m": 0,
      "20m": 2
    };
    this.MEMORY_MAP = [
      [0, 65536, "PADDING"],
      [1115684864, 1124073472, "DROM"],
      [1082130432, 1082523648, "DRAM"],
      [1082130432, 1082523648, "BYTE_ACCESSIBLE"],
      [1073979392, 1074003968, "DROM_MASK"],
      [1073741824, 1073979392, "IROM_MASK"],
      [1107296256, 1115684864, "IROM"],
      [1082130432, 1082523648, "IRAM"],
      [1342177280, 1342193664, "RTC_IRAM"],
      [1342177280, 1342193664, "RTC_DRAM"],
      [1611653120, 1611661312, "MEM_INTERNAL2"]
    ];
    this.UF2_FAMILY_ID = 4145808195;
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
    return await loader.readReg(this.EFUSE_BLOCK1_ADDR + 4 * numWord) >> 26 & 7;
  }
  async getMinorChipVersion(loader) {
    const numWord = 2;
    return await loader.readReg(this.EFUSE_BLOCK1_ADDR + 4 * numWord) >> 0 & 15;
  }
  async getMajorChipVersion(loader) {
    const numWord = 2;
    return await loader.readReg(this.EFUSE_BLOCK1_ADDR + 4 * numWord) >> 4 & 3;
  }
  async getChipDescription(loader) {
    const pkgVer = await this.getPkgVersion(loader);
    let desc;
    if (pkgVer === 0) {
      desc = "ESP32-C5";
    } else {
      desc = "unknown ESP32-C5";
    }
    const majorRev = await this.getMajorChipVersion(loader);
    const minorRev = await this.getMinorChipVersion(loader);
    return `${desc} (revision v${majorRev}.${minorRev})`;
  }
  async getChipFeatures(loader) {
    return ["Wi-Fi 6 (dual-band)", "BT 5 (LE)"];
  }
  async getCrystalFreq(loader) {
    const uartDiv = await loader.readReg(this.UART_CLKDIV_REG) & this.UART_CLKDIV_MASK;
    const etsXtal = loader.transport.baudrate * uartDiv / 1e6 / this.XTAL_CLK_DIVIDER;
    let normXtal;
    if (etsXtal > 45) {
      normXtal = 48;
    } else if (etsXtal > 33) {
      normXtal = 40;
    } else {
      normXtal = 26;
    }
    if (Math.abs(normXtal - etsXtal) > 1) {
      loader.info("WARNING: Unsupported crystal in use");
    }
    return normXtal;
  }
  async getCrystalFreqRomExpect(loader) {
    return (await loader.readReg(this.PCR_SYSCLK_CONF_REG) & this.PCR_SYSCLK_XTAL_FREQ_V) >> this.PCR_SYSCLK_XTAL_FREQ_S;
  }
};
export {
  ESP32C5ROM
};
