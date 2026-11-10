"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { runElectronSmoke } = require("./clipboardSmoke");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let control;

runElectronSmoke(
  async ({ evaluate, client }) => {
    const wait = async (expression, label = expression) => {
      const end = Date.now() + 15000;
      do {
        if (await evaluate(expression)) return;
        await delay(60);
      } while (Date.now() < end);
      throw new Error("Appearance smoke timeout: " + label);
    };
    const cursorState = `([...terminalTabs].map(([id,i])=>({id,blink:i.terminal.options.cursorBlink,
        inactive:i.terminal.options.cursorInactiveStyle,focused:document.activeElement===i.terminal.textarea,
        renderedBlink:!!i.terminal.element.querySelector('.xterm-cursor-blink'),
        renderedCursor:!!i.terminal.element.querySelector('.xterm-cursor-block,.xterm-cursor-bar,.xterm-cursor-underline,.xterm-cursor-outline')})))`;
    async function expectCursor(id, blink = true) {
      try {
        await wait(
          `${cursorState}.every(i=>i.inactive==='none'&&i.blink===(i.id===${JSON.stringify(id)}&&${blink})&&i.renderedBlink===(i.id===${JSON.stringify(id)}&&${blink})&&i.renderedCursor===(i.id===${JSON.stringify(id)}))`,
          "exclusive rendered cursor: " + id,
        );
      } catch (error) {
        throw new Error(
          error.message +
            "\n" +
            JSON.stringify(
              await evaluate(
                `({states:${cursorState},windowFocus:document.hasFocus(),hidden:document.hidden,overlay:terminalOverlayOpen(),active:activeTabId})`,
              ),
            ),
        );
      }
    }
    await evaluate(`workspace.split('horizontal','tab-1')`);
    await evaluate(`workspace.split('vertical','tab-2')`);
    await evaluate(
      `Promise.all([...terminalTabs].map(async([id])=>stopLocalTerminalForTab(id)))`,
    );
    await delay(200);
    await evaluate(
      `Promise.all([...terminalTabs.values()].map(i=>new Promise(r=>{i.terminal.reset();i.terminal.write(${JSON.stringify("FOCUSMARK\x1b[1G")},r)})))`,
    );
    // Use real browser keyboard focus and inspect xterm's rendered cursor cells.
    for (const id of ["tab-1", "tab-2", "tab-3"]) {
      await evaluate(
        `switchToTab('${id}');terminalTabs.get('${id}').terminal.focus()`,
      );
      await expectCursor(id);
    }
    fs.writeFileSync(control, "away");
    await wait("!document.hasFocus()", "native window loses focus");
    await expectCursor(null);
    fs.writeFileSync(control, "back");
    await wait("document.hasFocus()", "native window regains focus");
    await expectCursor("tab-3");
    await evaluate(`commandInput.focus()`);
    await expectCursor(null);
    await evaluate(
      `scheduleFitTerminalTab('tab-3',{focus:true,syncSsh:true});commandInput.focus()`,
    );
    await delay(120);
    assert.equal(
      await evaluate(`document.activeElement===commandInput`),
      true,
      "deferred fit cannot steal composer focus",
    );
    await expectCursor(null);
    await evaluate(
      `switchToTab('tab-1');createSSHModal();sshModal.style.display='block'`,
    );
    await expectCursor(null);
    await evaluate(`closeSSHModal();switchToTab('tab-1')`);
    await expectCursor("tab-1");
    await evaluate(`document.getElementById('openPluginCenter').click()`);
    await wait(`document.getElementById('pluginCenter').open`);
    await expectCursor(null);
    await evaluate(
      `document.getElementById('pluginCenter').close();switchToTab('tab-2')`,
    );
    await expectCursor("tab-2");
    // An application may ask xterm to enable cursor blink on a background pane.
    await evaluate(
      `new Promise(r=>terminalTabs.get('tab-1').terminal.write('\x1b[?12h',r))`,
    );
    await expectCursor("tab-2");
    await evaluate(`terminalConfig.cursorBlink=false;syncTerminalFocus()`);
    await expectCursor("tab-2", false);
    await evaluate(
      `terminalConfig.cursorBlink=true;syncTerminalFocus();document.querySelector('#tab-content-2 [data-workspace-action="zoom"]').click();terminalTabs.get('tab-2').terminal.focus()`,
    );
    await expectCursor("tab-2");
    await evaluate(
      `document.querySelector('#tab-content-2 [data-workspace-action="zoom"]').click();workspace.move('tab-3','tab-1','bottom');switchToTab('tab-3')`,
    );
    await expectCursor("tab-3");
    await evaluate(`doCloseTab('tab-3')`);
    const remaining = await evaluate("activeTabId");
    await expectCursor(remaining);
    for (const theme of ["dark", "light", "nord"]) {
      await evaluate(
        `terminalConfig.theme='${theme}';updateGlobalTheme('${theme}');for(const i of terminalTabs.values())i.terminal.options.theme=terminalThemes['${theme}'];syncTerminalFocus()`,
      );
      await expectCursor(remaining);
      assert.equal(
        await evaluate(
          `getComputedStyle(document.body).getPropertyValue('--terminal-surface').trim()===terminalThemes['${theme}'].background`,
        ),
        true,
      );
    }
    for (const width of [1600, 1100, 800]) {
      await client.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await evaluate("workspace.fit()");
      await delay(180);
      assert.equal(
        await evaluate(`document.documentElement.scrollWidth<=innerWidth`),
        true,
        "no horizontal window overflow at " + width,
      );
      assert.equal(
        await evaluate(
          `(()=>{const r=document.querySelector('.input-section').getBoundingClientRect();return r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth})()`,
        ),
        true,
        "composer fits at " + width,
      );
      for (const size of await evaluate(
        `([...terminalTabs.values()].filter(i=>isTabVisible(i.container.parentElement.dataset.tabId)).map(i=>({cols:i.terminal.cols,rows:i.terminal.rows})))`,
      )) {
        assert.ok(size.cols > 2 && size.rows > 2);
      }
      assert.equal(
        await evaluate(`([...terminalTabs].filter(([id])=>isTabVisible(id)).every(([,i])=>{
            const grid=i.terminal.element.parentElement.getBoundingClientRect(),screen=i.terminal.element.querySelector('.xterm-screen').getBoundingClientRect();
            return screen.right<=grid.right+1&&screen.bottom<=grid.bottom+1;
        }))`),
        true,
        "terminal glyph grid stays within its content area at " + width,
      );
      await expectCursor(remaining);
    }
    const png = fs.readFileSync(path.join(__dirname, "../build/icon.png"));
    assert.equal(png.readUInt32BE(16), 1024);
    assert.equal(png.readUInt32BE(20), 1024);
    assert.equal(
      await evaluate(
        `document.querySelector('.app-brand img').complete&&document.querySelector('.app-brand img').naturalWidth>0`,
      ),
      true,
    );
    console.log(
      "Appearance smoke ok: real xterm exclusive cursor, native window blur/restore, composer/modal blur, delayed fit, background blink requests, blink preference, move/zoom/close, themes, responsive layout, brand asset",
    );
  },
  {
    entry: path.join(__dirname, "../test/fixtures/windowFocusHost.js"),
    prepareProfile(profile) {
      control = path.join(profile, "window-focus-control");
      fs.writeFileSync(control, "ready");
    },
  },
).catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
