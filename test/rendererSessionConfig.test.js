"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("imported session configuration follows its original tab and is ignored after closure", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../renderer.js"),
    "utf8",
  );
  for (const closed of [false, true]) {
    let input, reader, stored;
    const first = { aiConfigSnapshot: { aiModel: "old" } },
      second = { aiConfigSnapshot: { aiModel: "other" } };
    const tabs = new Map([
      ["first", first],
      ["second", second],
    ]);
    const context = vm.createContext({
      activeTabId: "first",
      terminalTabs: tabs,
      document: {
        createElement() {
          input = { click() {} };
          return input;
        },
      },
      FileReader: class {
        constructor() {
          reader = this;
        }
        readAsText() {}
      },
      localStorage: {
        setItem(_key, value) {
          stored = value;
        },
      },
      ownsTerminalTab: (id, owner) => tabs.get(id) === owner,
      sanitizeConfigForStorage: (config) => ({
        host: config.host,
        aiModel: config.aiModel,
      }),
      writeToTerminalTab() {},
    });
    vm.runInContext(
      source.slice(
        source.indexOf("function loadSession()"),
        source.indexOf("function showHelpGuide()"),
      ),
      context,
    );
    context.loadSession();
    input.onchange({ target: { files: [{ size: 100 }] } });
    context.activeTabId = "second";
    if (closed) tabs.delete("first");
    reader.onload({
      target: {
        result: JSON.stringify({ host: "imported.example", aiModel: "new" }),
      },
    });
    assert.equal(first.aiConfigSnapshot.aiModel, closed ? "old" : "new");
    assert.equal(second.aiConfigSnapshot.aiModel, "other");
    assert.equal(stored !== undefined, !closed);
  }
});
