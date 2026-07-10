// node_modules/esptool-js/lib/targets/rom.js
var ROM = class {
  /**
   * Get the chip erase size.
   * @param {number} offset - Offset to start erase.
   * @param {number} size - Size to erase.
   * @returns {number} The erase size of the chip as number.
   */
  getEraseSize(offset, size) {
    return size;
  }
};

export {
  ROM
};
