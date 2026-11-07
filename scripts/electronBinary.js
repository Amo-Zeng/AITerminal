const fs = require('fs');

function getElectronPath() {
  // In a regular Node process, the `electron` package exports the path to the
  // Electron executable. In an Electron runtime, `require('electron')` is the
  // Electron API object instead.
  const electron = require('electron');
  if (typeof electron !== 'string') {
    throw new Error(
      'Unable to resolve Electron executable path. ' +
        'Run this script via Node (for example using `npm run ...`).'
    );
  }
  return electron;
}

function detectBinaryFormat(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);

    if (bytesRead < 4) return 'unknown';

    // ELF: 0x7f 'E' 'L' 'F'
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
      return 'elf';
    }

    // PE (Windows): 'M' 'Z'
    if (buf[0] === 0x4d && buf[1] === 0x5a) {
      return 'pe';
    }

    // Mach-O (macOS): multiple magic numbers; check both endianness.
    const magicBE = buf.readUInt32BE(0);
    const magicLE = buf.readUInt32LE(0);
    const machoMagics = new Set([
      0xfeedface, // MH_MAGIC
      0xfeedfacf, // MH_MAGIC_64
      0xcafebabe, // FAT_MAGIC
      0xcafebabf, // FAT_MAGIC_64
      0xcefaedfe, // MH_CIGAM
      0xcffaedfe, // MH_CIGAM_64
      0xbebafeca, // FAT_CIGAM
      0xbfbafeca, // FAT_CIGAM_64
    ]);
    if (machoMagics.has(magicBE) || machoMagics.has(magicLE)) {
      return 'macho';
    }

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function expectedBinaryFormatForPlatform(platform) {
  if (platform === 'win32') return 'pe';
  if (platform === 'linux') return 'elf';
  if (platform === 'darwin') return 'macho';
  return 'unknown';
}

function assertElectronBinaryCompatible(electronPath) {
  const expected = expectedBinaryFormatForPlatform(process.platform);
  const actual = detectBinaryFormat(electronPath);

  if (expected !== 'unknown' && actual !== 'unknown' && expected !== actual) {
    throw new Error(
      `Electron binary is not compatible with this platform.\n` +
        `- platform: ${process.platform}\n` +
        `- electron: ${electronPath}\n` +
        `- detected: ${actual}\n` +
        `\n` +
        `Your node_modules likely comes from another OS/CPU. ` +
        `Delete node_modules and reinstall dependencies for this platform (e.g. \`npm ci\`).`
    );
  }

  return true;
}

module.exports = {
  getElectronPath,
  detectBinaryFormat,
  expectedBinaryFormatForPlatform,
  assertElectronBinaryCompatible,
};

