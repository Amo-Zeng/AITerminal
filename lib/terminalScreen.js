"use strict";
const crypto = require("node:crypto");

function normalizeScreen(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isInteger(value.cols) ||
    !Number.isInteger(value.rows) ||
    value.cols < 2 ||
    value.cols > 1000 ||
    value.rows < 2 ||
    value.rows > 500
  )
    throw new Error("终端屏幕格式无效");
  const text = (input) =>
    String(input || "")
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
      .slice(0, 24000);
  return {
    title: text(value.title).slice(0, 120),
    cols: value.cols,
    rows: value.rows,
    buffer: value.buffer === "alternate" ? "alternate" : "normal",
    cursor: {
      x: Math.max(0, Math.min(value.cols - 1, Number(value.cursor?.x) || 0)),
      y: Math.max(0, Math.min(value.rows - 1, Number(value.cursor?.y) || 0)),
    },
    applicationCursor: value.applicationCursor === true,
    bracketedPaste: value.bracketedPaste === true,
    scrolled: value.scrolled === true,
    screen: text(value.screen),
    viewport: value.scrolled ? text(value.viewport) : "",
    truncated: value.truncated === true,
  };
}

class TerminalScreenBroker {
  constructor(timeout = 5000) {
    this.pending = new Map();
    this.timeout = timeout;
  }
  request(sender, tabId, valid) {
    return new Promise((resolve, reject) => {
      if (!valid()) return reject(new Error("终端会话已变化"));
      const requestId = crypto.randomUUID();
      const finish = (error, value) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(
        () => finish(new Error("读取终端屏幕超时")),
        this.timeout,
      );
      this.pending.set(requestId, { sender, tabId, valid, finish });
      try {
        sender.send("terminal-screen-request", { requestId, tabId });
      } catch (error) {
        finish(error);
      }
    });
  }
  accept(sender, payload) {
    const item = this.pending.get(payload?.requestId);
    if (!item || item.sender !== sender || item.tabId !== payload.tabId)
      return false;
    try {
      if (!item.valid() || payload.error)
        throw new Error(payload.error || "终端会话已变化");
      item.finish(null, normalizeScreen(payload.screen));
    } catch (error) {
      item.finish(error);
    }
    return true;
  }
}
module.exports = { TerminalScreenBroker, normalizeScreen };
