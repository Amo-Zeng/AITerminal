"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { runElectronSmoke } = require("./clipboardSmoke");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let control, menuState;

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
    await evaluate(`renderAiResult({response:'Appearance fixture',command:'ai'},true,activeTabId)`);
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
        assert.ok(size.cols >= 20 && size.rows > 2, "AI panel leaves readable terminal columns at " + width);
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
    assert.equal(
      await evaluate(`(()=>{const terminal=document.getElementById('workspaceCanvas').getBoundingClientRect(),dock=document.getElementById('aiDock').getBoundingClientRect();
        return workspace.aiStacked()&&dock.top>=terminal.bottom&&Math.abs(dock.width-terminal.width)<=1&&document.getElementById('aiDivider').getAttribute('aria-orientation')==='horizontal';})()`),
      true,
      "narrow workspace stacks AI below the terminal",
    );
    const beforeHeight = await evaluate(`document.getElementById('aiDock').clientHeight`);
    await evaluate(`document.getElementById('aiDivider').focus()`);
    await expectCursor(null);
    await client.send("Input.dispatchKeyEvent", {type:"keyDown",key:"ArrowUp",code:"ArrowUp"});
    await client.send("Input.dispatchKeyEvent", {type:"keyUp",key:"ArrowUp",code:"ArrowUp"});
    await wait(`document.getElementById('aiDock').clientHeight>${beforeHeight+10}`, "keyboard resizes stacked AI panel");
    const handle = await evaluate(`(()=>{const r=document.getElementById('aiDivider').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,height:document.getElementById('aiDock').clientHeight};})()`);
    await client.send("Input.dispatchMouseEvent", {type:"mousePressed",button:"left",clickCount:1,x:handle.x,y:handle.y});
    await client.send("Input.dispatchMouseEvent", {type:"mouseMoved",button:"left",buttons:1,x:handle.x,y:handle.y-20});
    await client.send("Input.dispatchMouseEvent", {type:"mouseReleased",button:"left",clickCount:1,x:handle.x,y:handle.y-20});
    await wait(`document.getElementById('aiDock').clientHeight>${handle.height+10}`, "pointer resizes stacked AI panel");
    await evaluate(`terminalTabs.get(activeTabId).terminal.focus()`);
    await expectCursor(remaining);
    await client.send("Emulation.setDeviceMetricsOverride", {width:1400,height:900,deviceScaleFactor:1,mobile:false});
    await evaluate(`workspace.fit();void(window.__minimalOriginal=[...terminalTabs.values()].map(i=>i.terminal))`);
    await delay(180);
    const fullSize = await evaluate(`(()=>{const r=document.getElementById('workspaceCanvas').getBoundingClientRect();return {width:r.width,height:r.height}})()`);
    const toggleMinimal = async () => {
      const modifiers = (process.platform === 'darwin' ? 4 : 2) | 8;
      await client.send('Input.dispatchKeyEvent', {type:'keyDown',key:'M',code:'KeyM',modifiers});
      await client.send('Input.dispatchKeyEvent', {type:'keyUp',key:'M',code:'KeyM',modifiers});
    };
    const expectMenu = async visible => {
      if (process.platform === 'darwin') return;
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        try { if (JSON.parse(fs.readFileSync(menuState, 'utf8')).visible === visible) return; } catch {}
        await delay(60);
      }
      assert.fail('native menu visibility did not become '+visible);
    };
    await toggleMinimal();
    await wait(`workspace.minimal&&document.body.classList.contains('minimal-mode')`);
    await expectMenu(false);
    await expectCursor(remaining);
    assert.equal(await evaluate(`['.app-header','.workspace-sidebar','.workspace-toolbar','.workbench-status','.pane-header','#pluginDock','#aiDock','.composer-caption'].every(s=>[...document.querySelectorAll(s)].every(n=>!n.getClientRects().length))`),true,'minimal mode hides menus and surrounding panels');
    assert.equal(await evaluate(`!document.getElementById('minimalSession')`),true,'no bottom session selector');
    const compactLayout = `(()=>{const r=document.getElementById('workspaceCanvas').getBoundingClientRect(),tabs=document.getElementById('terminalTabs').getBoundingClientRect(),footer=document.querySelector('.input-section').getBoundingClientRect();return tabs.top<=1&&tabs.height>0&&tabs.height<=40&&Math.abs(r.top-tabs.bottom)<=1&&r.width>=innerWidth-2&&Math.abs(r.bottom-footer.top)<=1&&footer.height<=70&&document.documentElement.scrollWidth<=innerWidth})()`;
    assert.equal(await evaluate(compactLayout),true,'terminal fills the window between the top tabs and compact composer');
    assert.equal(await evaluate(`(()=>{const r=document.getElementById('workspaceCanvas').getBoundingClientRect();return r.width>${fullSize.width}&&r.height>${fullSize.height}})()`),true,'minimal mode increases terminal area');
    for (const width of [800, 1600, 1400]) {
      await client.send('Emulation.setDeviceMetricsOverride', {width,height:900,deviceScaleFactor:1,mobile:false});
      await delay(180);
      assert.equal(await evaluate(compactLayout),true,'minimal tabs and composer stay compact without overflow at '+width);
    }
    await evaluate(`commandInput.focus();commandInput.value='保留当前输入草稿'`);
    await toggleMinimal();
    await toggleMinimal();
    await expectCursor(null);
    assert.equal(await evaluate(`document.activeElement===commandInput&&commandInput.value==='保留当前输入草稿'`),true,'toggling preserves composer input and focus');
    await evaluate(`document.getElementById('minimalAiReply').click()`);
    await wait(`document.getElementById('aiDock').getClientRects().length>0`);
    assert.equal(await evaluate(`document.getElementById('aiResultContent').textContent.includes('Appearance fixture')`),true);
    assert.equal(await evaluate(`document.getElementById('workspaceCanvas').clientWidth>=innerWidth-2`),true,'AI reply overlay consumes no terminal space');
    await evaluate(`document.getElementById('minimalAiReply').click()`);
    const otherTab = remaining === 'tab-1' ? 'tab-2' : 'tab-1';
    const tabPoint = await evaluate(`(()=>{const r=getTabButton('${otherTab}').querySelector('.terminal-tab-title').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await client.send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...tabPoint});
    await client.send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...tabPoint});
    await expectCursor(otherTab);
    assert.equal(await evaluate(`activeTabId==='${otherTab}'&&getTabButton('${otherTab}').classList.contains('active')&&document.getElementById('composerTarget').textContent===terminalTabs.get(activeTabId).title&&[...terminalTabs.values()].every((i,n)=>i.terminal===window.__minimalOriginal[n])`),true,'top tab mouse click switches the AI target and focus while retaining PTYs');
    await evaluate(`document.querySelector('.input-container [data-workspace-action="minimal"]').click()`);
    await wait(`!workspace.minimal`);
    await expectMenu(true);
    await delay(180);
    await evaluate(`switchToTab('${remaining}')`);
    await delay(180);
    assert.deepEqual(await evaluate(`(()=>{const r=document.getElementById('workspaceCanvas').getBoundingClientRect();return {width:r.width,height:r.height}})()`),fullSize,'full layout restores exactly');
    await toggleMinimal();
    await client.send('Page.reload');
    await delay(700);
    await wait(`document.readyState==='complete'&&!!workspace&&workspace.minimal&&document.body.classList.contains('minimal-mode')`,'minimal preference survives reload');
    await expectMenu(false);
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
      "Appearance smoke ok: exclusive cursor, native/composer/modal focus, resize, pane lifecycle, themes, responsive AI dock, minimal mode area/focus/session routing/reply overlay/persistence, brand asset",
    );
  },
  {
    headless: false,
    entry: path.join(__dirname, "../test/fixtures/windowFocusHost.js"),
    prepareProfile(profile) {
      control = path.join(profile, "window-focus-control");
      menuState = path.join(profile, "window-menu-state.json");
      fs.writeFileSync(control, "ready");
    },
  },
).catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
