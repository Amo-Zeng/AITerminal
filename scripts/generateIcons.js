"use strict";
// Run with Electron. One vector source produces every installer/window icon;
// no network, system fonts, ImageMagick or platform icon tools are required.
const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..", "build");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.disableHardwareAcceleration();
app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      width: 1024,
      height: 1024,
      useContentSize: true,
      show: false,
      transparent: true,
      frame: false,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    await win.loadFile(path.join(root, "icon.svg"));
    const shot = await win.webContents.capturePage(
      { x: 0, y: 0, width: 1024, height: 1024 },
      { stayHidden: true, stayAwake: true },
    );
    const base = nativeImage
      .createFromBuffer(shot.toPNG())
      .resize({ width: 1024, height: 1024, quality: "best" });
    fs.writeFileSync(path.join(root, "icon.png"), base.toPNG());
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const images = sizes.map((size) =>
      base.resize({ width: size, height: size, quality: "best" }).toPNG(),
    );
    const header = Buffer.alloc(6 + 16 * sizes.length);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(sizes.length, 4);
    let offset = header.length;
    sizes.forEach((size, i) => {
      const start = 6 + 16 * i;
      header[start] = size % 256;
      header[start + 1] = size % 256;
      header.writeUInt16LE(1, start + 4);
      header.writeUInt16LE(32, start + 6);
      header.writeUInt32LE(images[i].length, start + 8);
      header.writeUInt32LE(offset, start + 12);
      offset += images[i].length;
    });
    fs.writeFileSync(
      path.join(root, "icon.ico"),
      Buffer.concat([header, ...images]),
    );
    const chunks = [
      [128, "ic07"],
      [256, "ic08"],
      [512, "ic09"],
      [1024, "ic10"],
    ].map(([size, code]) => {
      const png = base
        .resize({ width: size, height: size, quality: "best" })
        .toPNG();
      const chunk = Buffer.alloc(8);
      chunk.write(code);
      chunk.writeUInt32BE(8 + png.length, 4);
      return Buffer.concat([chunk, png]);
    });
    const icns = Buffer.alloc(8);
    icns.write("icns");
    icns.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4);
    fs.writeFileSync(
      path.join(root, "icon.icns"),
      Buffer.concat([icns, ...chunks]),
    );
    win.destroy();
    console.log("Generated PNG, ICO and ICNS from build/icon.svg");
    app.quit();
  })
  .catch((error) => {
    console.error(error.message);
    app.exit(1);
  });
