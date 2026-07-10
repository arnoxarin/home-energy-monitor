import {
  ROM
} from "./chunk-VTRPW7KE.js";
import "./chunk-SK6HMZ5B.js";

// node_modules/esptool-js/lib/targets/esp8266.js
var ESP8266ROM = class extends ROM {
  constructor() {
    super(...arguments);
    this.CHIP_NAME = "ESP8266";
    this.CHIP_DETECT_MAGIC_VALUE = [4293968129];
    this.EFUSE_RD_REG_BASE = 1072693328;
    this.UART_CLKDIV_REG = 1610612756;
    this.UART_CLKDIV_MASK = 1048575;
    this.XTAL_CLK_DIVIDER = 2;
    this.FLASH_WRITE_SIZE = 16384;
    this.BOOTLOADER_FLASH_OFFSET = 0;
    this.UART_DATE_REG_ADDR = 0;
    this.FLASH_SIZES = {
      "512KB": 0,
      "256KB": 16,
      "1MB": 32,
      "2MB": 48,
      "4MB": 64,
      "2MB-c1": 80,
      "4MB-c1": 96,
      "8MB": 128,
      "16MB": 144
    };
    this.SPI_REG_BASE = 1610613248;
    this.SPI_USR_OFFS = 28;
    this.SPI_USR1_OFFS = 32;
    this.SPI_USR2_OFFS = 36;
    this.SPI_MOSI_DLEN_OFFS = 0;
    this.SPI_MISO_DLEN_OFFS = 0;
    this.SPI_W0_OFFS = 64;
    this.getChipFeatures = async (loader) => {
      const features = ["WiFi"];
      if (await this.getChipDescription(loader) == "ESP8285")
        features.push("Embedded Flash");
      return features;
    };
  }
  async readEfuse(loader, offset) {
    const addr = this.EFUSE_RD_REG_BASE + 4 * offset;
    loader.debug("Read efuse " + addr);
    return await loader.readReg(addr);
  }
  async getChipDescription(loader) {
    const efuse3 = await this.readEfuse(loader, 2);
    const efuse0 = await this.readEfuse(loader, 0);
    const is8285 = (efuse0 & 1 << 4 | efuse3 & 1 << 16) != 0;
    return is8285 ? "ESP8285" : "ESP8266EX";
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
      loader.info("WARNING: Detected crystal freq " + etsXtal + "MHz is quite different to normalized freq " + normXtal + "MHz. Unsupported crystal in use?");
    }
    return normXtal;
  }
  _d2h(d) {
    const h = (+d).toString(16);
    return h.length === 1 ? "0" + h : h;
  }
  async readMac(loader) {
    let mac0 = await this.readEfuse(loader, 0);
    mac0 = mac0 >>> 0;
    let mac1 = await this.readEfuse(loader, 1);
    mac1 = mac1 >>> 0;
    let mac3 = await this.readEfuse(loader, 3);
    mac3 = mac3 >>> 0;
    const mac = new Uint8Array(6);
    if (mac3 != 0) {
      mac[0] = mac3 >> 16 & 255;
      mac[1] = mac3 >> 8 & 255;
      mac[2] = mac3 & 255;
    } else if ((mac1 >> 16 & 255) == 0) {
      mac[0] = 24;
      mac[1] = 254;
      mac[2] = 52;
    } else if ((mac1 >> 16 & 255) == 1) {
      mac[0] = 172;
      mac[1] = 208;
      mac[2] = 116;
    } else {
      loader.error("Unknown OUI");
    }
    mac[3] = mac1 >> 8 & 255;
    mac[4] = mac1 & 255;
    mac[5] = mac0 >> 24 & 255;
    return this._d2h(mac[0]) + ":" + this._d2h(mac[1]) + ":" + this._d2h(mac[2]) + ":" + this._d2h(mac[3]) + ":" + this._d2h(mac[4]) + ":" + this._d2h(mac[5]);
  }
  getEraseSize(offset, size) {
    return size;
  }
};
export {
  ESP8266ROM
};
