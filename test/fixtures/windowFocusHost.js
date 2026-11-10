"use strict";
// Real native-window focus fixture. This entry is never shipped in the app.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const profile = process.env.AITERMINAL_SMOKE_USER_DATA;
if (!profile || process.env.AITERMINAL_CLIPBOARD_SMOKE !== "1")
  throw new Error("Isolated smoke profile required");
const control = path.join(profile, "window-focus-control");
let owner, other;
app.on("browser-window-created", (_event, win) => {
  if (!owner) owner = win;
});
require("../../main");
app.whenReady().then(() => {
  fs.watchFile(control, { interval: 50 }, async () => {
    const action = fs.readFileSync(control, "utf8");
    if (action === "away" && !other) {
      other = new BrowserWindow({
        width: 240,
        height: 160,
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true },
      });
      await other.loadURL(
        'data:text/html,<title>Focus fixture</title><input autofocus aria-label="Fixture input">',
      );
      other.show();
      owner.blur();
      other.focus();
      other.webContents.focus();
    } else if (action === "back" && owner && !owner.isDestroyed()) {
      other?.destroy();
      other = null;
      owner.show();
      owner.focus();
    }
  });
});
app.on("will-quit", () => fs.unwatchFile(control));
