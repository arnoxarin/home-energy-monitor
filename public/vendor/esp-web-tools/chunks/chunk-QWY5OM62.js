import {
  ROM
} from "./chunk-VTRPW7KE.js";

// node_modules/esptool-js/lib/targets/esp32.js
var ESP32ROM = class extends ROM {
  constructor() {
    super(...arguments);
    this.CHIP_NAME = "ESP32";
    this.IMAGE_CHIP_ID = 0;
    this.EFUSE_RD_REG_BASE = 1073061888;
    this.DR_REG_SYSCON_BASE = 1073111040;
    this.UART_CLKDIV_REG = 1072955412;
    this.UART_CLKDIV_MASK = 1048575;
    this.UART_DATE_REG_ADDR = 1610612856;
    this.XTAL_CLK_DIVIDER = 1;
    this.FLASH_SIZES = {
      "1MB": 0,
      "2MB": 16,
      "4MB": 32,
      "8MB": 48,
      "16MB": 64
    };
    this.FLASH_WRITE_SIZE = 1024;
    this.BOOTLOADER_FLASH_OFFSET = 4096;
    this.SPI_REG_BASE = 1072963584;
    this.SPI_USR_OFFS = 28;
    this.SPI_USR1_OFFS = 32;
    this.SPI_USR2_OFFS = 36;
    this.SPI_W0_OFFS = 128;
    this.SPI_MOSI_DLEN_OFFS = 40;
    this.SPI_MISO_DLEN_OFFS = 44;
  }
  async readEfuse(loader, offset) {
    const addr = this.EFUSE_RD_REG_BASE + 4 * offset;
    loader.debug("Read efuse " + addr);
    return await loader.readReg(addr);
  }
  async getPkgVersion(loader) {
    const word3 = await this.readEfuse(loader, 3);
    let pkgVersion = word3 >> 9 & 7;
    pkgVersion += (word3 >> 2 & 1) << 3;
    return pkgVersion;
  }
  async getChipRevision(loader) {
    const word3 = await this.readEfuse(loader, 3);
    const word5 = await this.readEfuse(loader, 5);
    const apbCtlDate = await loader.readReg(this.DR_REG_SYSCON_BASE + 124);
    const revBit0 = word3 >> 15 & 1;
    const revBit1 = word5 >> 20 & 1;
    const revBit2 = apbCtlDate >> 31 & 1;
    if (revBit0 != 0) {
      if (revBit1 != 0) {
        if (revBit2 != 0) {
          return 3;
        } else {
          return 2;
        }
      } else {
        return 1;
      }
    }
    return 0;
  }
  async getChipDescription(loader) {
    const chipDesc = [
      "ESP32-D0WDQ6",
      "ESP32-D0WD",
      "ESP32-D2WD",
      "",
      "ESP32-U4WDH",
      "ESP32-PICO-D4",
      "ESP32-PICO-V3-02"
    ];
    let chipName = "";
    const pkgVersion = await this.getPkgVersion(loader);
    const chipRevision = await this.getChipRevision(loader);
    const rev3 = chipRevision == 3;
    const single_core = await this.readEfuse(loader, 3) & 1 << 0;
    if (single_core != 0) {
      chipDesc[0] = "ESP32-S0WDQ6";
      chipDesc[1] = "ESP32-S0WD";
    }
    if (rev3) {
      chipDesc[5] = "ESP32-PICO-V3";
    }
    if (pkgVersion >= 0 && pkgVersion <= 6) {
      chipName = chipDesc[pkgVersion];
    } else {
      chipName = "Unknown ESP32";
    }
    if (rev3 && (pkgVersion === 0 || pkgVersion === 1)) {
      chipName += "-V3";
    }
    return chipName + " (revision " + chipRevision + ")";
  }
  async getChipFeatures(loader) {
    const features = ["Wi-Fi"];
    const word3 = await this.readEfuse(loader, 3);
    const chipVerDisBt = word3 & 1 << 1;
    if (chipVerDisBt === 0) {
      features.push(" BT");
    }
    const chipVerDisAppCpu = word3 & 1 << 0;
    if (chipVerDisAppCpu !== 0) {
      features.push(" Single Core");
    } else {
      features.push(" Dual Core");
    }
    const chipCpuFreqRated = word3 & 1 << 13;
    if (chipCpuFreqRated !== 0) {
      const chipCpuFreqLow = word3 & 1 << 12;
      if (chipCpuFreqLow !== 0) {
        features.push(" 160MHz");
      } else {
        features.push(" 240MHz");
      }
    }
    const pkgVersion = await this.getPkgVersion(loader);
    if ([2, 4, 5, 6].indexOf(pkgVersion) !== -1) {
      features.push(" Embedded Flash");
    }
    if (pkgVersion === 6) {
      features.push(" Embedded PSRAM");
    }
    const word4 = await this.readEfuse(loader, 4);
    const adcVref = word4 >> 8 & 31;
    if (adcVref !== 0) {
      features.push(" VRef calibration in efuse");
    }
    const blk3PartRes = word3 >> 14 & 1;
    if (blk3PartRes !== 0) {
      features.push(" BLK3 partially reserved");
    }
    const word6 = await this.readEfuse(loader, 6);
    const codingScheme = word6 & 3;
    const codingSchemeArr = ["None", "3/4", "Repeat (UNSUPPORTED)", "Invalid"];
    features.push(" Coding Scheme " + codingSchemeArr[codingScheme]);
    return features;
  }
  async getCrystalFreq(loader) {
    const uartDiv = await loader.readReg(this.UART_CLKDIV_REG) & this.UART_CLKDIV_MASK;
    const etsXtal = loader.transport.baudrate * uartDiv / 1e6 / this.XTAL_CLK_DIVIDER;
    let normXtal;
    if (etsXtal > 33) {
      normXtal = 40;
    } else {
      normXtal = 26;
    }
    if (Math.abs(normXtal - etsXtal) > 1) {
      loader.info("WARNING: Unsupported crystal in use");
    }
    return normXtal;
  }
  _d2h(d) {
    const h = (+d).toString(16);
    return h.length === 1 ? "0" + h : h;
  }
  async readMac(loader) {
    let mac0 = await this.readEfuse(loader, 1);
    mac0 = mac0 >>> 0;
    let mac1 = await this.readEfuse(loader, 2);
    mac1 = mac1 >>> 0;
    const mac = new Uint8Array(6);
    mac[0] = mac1 >> 8 & 255;
    mac[1] = mac1 & 255;
    mac[2] = mac0 >> 24 & 255;
    mac[3] = mac0 >> 16 & 255;
    mac[4] = mac0 >> 8 & 255;
    mac[5] = mac0 & 255;
    return this._d2h(mac[0]) + ":" + this._d2h(mac[1]) + ":" + this._d2h(mac[2]) + ":" + this._d2h(mac[3]) + ":" + this._d2h(mac[4]) + ":" + this._d2h(mac[5]);
  }
};

export {
  ESP32ROM
};
