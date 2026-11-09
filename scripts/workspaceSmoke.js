"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { runElectronSmoke } = require("./clipboardSmoke");
const {
  createWorkspaceSshServer,
} = require("../test/fixtures/workspaceSshServer");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  const first = await createWorkspaceSshServer("ALPHA"),
    second = await createWorkspaceSshServer("BETA");
  const requests = [];
  const model = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "MODEL:" + requests.at(-1).model } }],
        }),
      );
    });
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  try {
    await runElectronSmoke(
      async ({ evaluate, client }) => {
        const wait = async (expression, label = expression) => {
          const until = Date.now() + 20000;
          do {
            if (await evaluate(expression)) return;
            await delay(60);
          } while (Date.now() < until);
          throw new Error("Workspace timeout: " + label);
        };
        const text = (id) =>
          `(()=>{const b=terminalTabs.get('${id}').terminal.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join(${JSON.stringify("\n")});})()`;
        const screenshot = async (name) => {
          if (!process.env.AITERMINAL_WORKSPACE_SCREENSHOTS) return;
          const dir = path.resolve(
            process.env.AITERMINAL_WORKSPACE_SCREENSHOTS,
          );
          fs.mkdirSync(dir, { recursive: true });
          const shot = await client.send("Page.captureScreenshot", {
            format: "png",
          });
          fs.writeFileSync(
            path.join(dir, name + ".png"),
            Buffer.from(shot.data, "base64"),
          );
        };
        await wait("!!workspace");
        const splitKey = async (vertical = false) => {
          const modifiers =
            (process.platform === "darwin" ? 4 : 2) | 8 | (vertical ? 1 : 0);
          await client.send("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "E",
            code: "KeyE",
            modifiers,
          });
          await client.send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "E",
            code: "KeyE",
            modifiers,
          });
        };
        await splitKey();
        await wait(
          "terminalTabs.size===2&&activeTabId==='tab-2'&&!workspace.busy",
        );
        await splitKey(true);
        await wait(
          `['tab-1','tab-2','tab-3'].every(id=>isTabVisible(id)&&terminalTabs.get(id).terminal.cols>2)`,
        );
        await evaluate(
          `void (window.__originalTerminals=[...terminalTabs.values()].map(i=>i.terminal))`,
        );
        for (const [id, server] of [
          ["tab-2", first],
          ["tab-3", second],
        ]) {
          const result = await evaluate(
            `autoConnectSSH(${JSON.stringify(server.config)},'${id}')`,
          );
          assert.equal(result, true, "real SSH connection " + id);
        }
        if (process.platform !== "win32") {
          await wait(`terminalTabs.get('tab-1').localTerminalActive`);
          const command = "printf '%s%s\\n' 'LOCAL_' 'ONLY'\r";
          await evaluate(
            `electronAPI.terminalLocalSend('tab-1',${JSON.stringify(command)})`,
          );
          await wait(`(${text("tab-1")}).includes('LOCAL_ONLY')`);
        }
        for (const id of ["tab-2", "tab-3"]) {
          const position = await evaluate(
            `(()=>{const r=terminalTabs.get('${id}').terminal.element.getBoundingClientRect();return {x:r.x+30,y:r.y+25};})()`,
          );
          await client.send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            button: "left",
            clickCount: 1,
            ...position,
          });
          await client.send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            button: "left",
            clickCount: 1,
            ...position,
          });
          await wait(`activeTabId==='${id}'`);
          await client.send("Input.insertText", { text: "INPUT_" + id });
          await wait(
            `(${text(id)}).includes('${id === "tab-2" ? "ALPHA" : "BETA"}_REPLY:INPUT_${id}')`,
          );
        }
        assert.equal(first.input.join("").includes("INPUT_tab-3"), false);
        assert.equal(second.input.join("").includes("INPUT_tab-2"), false);
        await evaluate(`workspace.files('tab-2')`);
        await wait(
          `getTabContent('tab-2').querySelector('.pane-files')?.textContent.includes(${JSON.stringify("ALPHA 中文 file\nname.txt")})`,
        );
        assert.equal(
          await evaluate(`!!getTabContent('tab-2').querySelector('.xterm')`),
          true,
          "files preserve xterm",
        );
        await evaluate(
          `getTabContent('tab-2').querySelector('.files-header button:last-child').click()`,
        );
        const divider = await evaluate(
          `(()=>{const r=document.querySelector('.workspace-divider').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
        );
        await client.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: "left",
          clickCount: 1,
          ...divider,
        });
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          button: "left",
          buttons: 1,
          x: divider.x - 70,
          y: divider.y,
        });
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button: "left",
          clickCount: 1,
          x: divider.x - 70,
          y: divider.y,
        });
        await wait(
          `workspace.groups[0].ratio<0.48`,
          "dragging divider changes ratio",
        );
        await delay(250);
        for (const [id, server] of [
          ["tab-2", first],
          ["tab-3", second],
        ]) {
          const size = await evaluate(
            `({cols:terminalTabs.get('${id}').terminal.cols,rows:terminalTabs.get('${id}').terminal.rows})`,
          );
          assert.deepEqual(
            server.sizes.at(-1),
            size,
            "SSH PTY window size " + id,
          );
        }
        await evaluate(`(() => {
          const transfer = new DataTransfer();
          getTabButton('tab-3').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));
          const target=getTabContent('tab-1'), rect=target.getBoundingClientRect();
          const options={bubbles:true,cancelable:true,dataTransfer:transfer,clientX:rect.x+rect.width/2,clientY:rect.bottom-5};
          target.dispatchEvent(new DragEvent('dragover',options));
          target.dispatchEvent(new DragEvent('drop',options));
        })()`);
        assert.deepEqual(
          await evaluate("workspace.layout.leaves(workspace.groups[0])"),
          ["tab-1", "tab-3", "tab-2"],
        );
        assert.equal(
          await evaluate(
            `window.__originalTerminals.every((term,i)=>term===terminalTabs.get('tab-'+(i+1)).terminal)`,
          ),
          true,
          "reordering retains xterm instances",
        );
        await evaluate(
          `getTabContent('tab-2').querySelector('[data-workspace-action=zoom]').click()`,
        );
        assert.equal(
          await evaluate(
            `workspace.zoomed==='tab-2'&&isTabVisible('tab-2')&&!isTabVisible('tab-1')`,
          ),
          true,
        );
        await evaluate(
          `getTabContent('tab-2').querySelector('[data-workspace-action=zoom]').click()`,
        );
        await wait(`['tab-1','tab-2','tab-3'].every(isTabVisible)`);
        for (const id of ["tab-2", "tab-3"]) {
          const config = {
            enableAI: true,
            aiApiKey: "fixture-placeholder",
            aiBaseUrl: `http://127.0.0.1:${model.address().port}`,
            aiModel: id,
            aiDisplayMode: "panel",
          };
          await evaluate(
            `terminalTabs.get('${id}').aiConfigSnapshot=sanitizeConfigForStorage(${JSON.stringify(config)});electronAPI.aiConfigure(${JSON.stringify(config)},'${id}')`,
          );
        }
        await evaluate(
          `localStorage.setItem('sshConfig',JSON.stringify({aiModel:'WRONG_DEFAULT'}));switchToTab('tab-2')`,
        );
        const ai = await evaluate(
          `electronAPI.aiChatWithoutTerm('hello',false,'tab-2')`,
        );
        assert.equal(ai.success, true, ai.error);
        assert.equal(requests.at(-1).model, "tab-2");
        await evaluate(
          `renderAiResult({response:'Alpha result',command:'ai'},true,'tab-2')`,
        );
        await wait(
          `document.getElementById('aiResultContainer')?.dataset.tabId==='tab-2'`,
        );
        await evaluate(
          `renderAiResult({response:'Beta result',command:'ai'},true,'tab-3');switchToTab('tab-3')`,
        );
        assert.equal(
          await evaluate(
            `document.getElementById('aiResultContent').textContent.includes('Beta result')`,
          ),
          true,
        );
        await evaluate(
          `closeAiResult(true,'tab-3');switchToTab('tab-2');closeAiResult(true,'tab-2')`,
        );
        await evaluate(
          `commandInput.value='alpha draft';switchToTab('tab-3');commandInput.value='beta draft';switchToTab('tab-2')`,
        );
        assert.equal(await evaluate("commandInput.value"), "alpha draft");
        const preview = await evaluate(
          `electronAPI.pluginsPreview({kind:'bundled',id:'aiterminal.terminal-pet'},'tab-2')`,
        );
        assert.equal(preview.success, true, preview.error);
        assert.equal(
          (
            await evaluate(
              `electronAPI.pluginsInstall(${JSON.stringify(preview.preview.token)},'tab-2')`,
            )
          ).success,
          true,
        );
        await evaluate(
          `electronAPI.pluginsEnable('aiterminal.terminal-pet',true,'tab-2')`,
        );
        await evaluate(
          `electronAPI.pluginsTool('aiterminal.terminal-pet','visit',{},'tab-2')`,
        );
        await evaluate(
          `workspace.pin('tab-2','aiterminal.terminal-pet','pet','Terminal Pet')`,
        );
        await wait(
          `document.getElementById('pluginDock').textContent.includes('Terminal Pet')&&!document.getElementById('pluginDock').hidden`,
        );
        await evaluate(`switchToTab('tab-3')`);
        assert.equal(
          await evaluate(`[...workspace.pins.values()][0].tabId`),
          "tab-2",
        );
        const savedPin = await evaluate(`workspace.snapshot('pinned').pins`);
        assert.deepEqual(savedPin, [
          {
            tabId: "tab-2",
            pluginId: "aiterminal.terminal-pet",
            panelId: "pet",
            title: "Terminal Pet",
          },
        ]);
        await evaluate(
          `workspace.pins.clear();workspace.renderPins();switchToTab('tab-2')`,
        );
        for (const scale of [1, 1.25, 1.5, 2]) {
          await client.send("Emulation.setDeviceMetricsOverride", {
            width: 1280,
            height: 850,
            deviceScaleFactor: scale,
            mobile: false,
          });
          await evaluate("workspace.fit()");
          await delay(180);
          assert.equal(
            await evaluate(
              `['tab-1','tab-2','tab-3'].every(id=>{const t=terminalTabs.get(id);return t.terminal.cols>2&&t.terminal.rows>2&&t.container.clientWidth>0;})`,
            ),
            true,
          );
          const size = await evaluate(
            `({cols:terminalTabs.get('tab-2').terminal.cols,rows:terminalTabs.get('tab-2').terminal.rows})`,
          );
          assert.deepEqual(first.sizes.at(-1), size);
        }
        await screenshot("workspace-dark");
        await evaluate(
          `document.querySelector('[data-workspace-action=theme]').click()`,
        );
        await delay(200);
        await screenshot("workspace-light");
        await evaluate(
          `document.querySelector('[data-workspace-action=theme]').click()`,
        );
        const saved = await evaluate(`workspace.snapshot('fixture')`);
        saved.pins = savedPin;
        assert.equal(
          JSON.stringify(saved).includes(first.config.password),
          false,
        );
        await evaluate(`workspace.restore(${JSON.stringify(saved)})`);
        await wait(`terminalTabs.size===6`);
        assert.equal(
          await evaluate(`[...workspace.pins.values()][0].tabId`),
          "tab-5",
          "restored panel belongs to restored SSH session",
        );
        assert.equal(
          await evaluate(
            `[...terminalTabs.values()].filter(i=>i.pendingRemote).every(i=>!i.localTerminalActive&&!i.localTerminalStarting)`,
          ),
          true,
        );
        const restored = await evaluate(`activeTabId`);
        assert.equal(
          (
            await evaluate(
              `electronAPI.terminalExecuteAudited('printf NEVER','${restored}')`,
            )
          ).success,
          false,
          "restored SSH cannot execute locally",
        );
        assert.equal(
          await evaluate(
            `autoConnectSSH(${JSON.stringify(first.config)},'tab-5')`,
          ),
          true,
        );
        assert.equal(
          await evaluate(`[...workspace.pins.values()][0]?.tabId`),
          "tab-5",
          "initial connection preserves restored panel reference",
        );
        await evaluate(
          `for(const id of ['tab-4','tab-5','tab-6'])doCloseTab(id);switchToTab('tab-2');workspace.detach('tab-3')`,
        );
        assert.equal(
          await evaluate(`isTabVisible('tab-3')&&!isTabVisible('tab-2')`),
          true,
        );
        await evaluate(`doCloseTab('tab-3');switchToTab('tab-2')`);
        assert.equal(
          (await evaluate(`electronAPI.sshSendRaw('LATE','tab-3')`)).success,
          false,
        );
        await evaluate(`electronAPI.sshSendRaw('STILL_ALIVE','tab-2')`);
        await wait(`(${text("tab-2")}).includes('ALPHA_REPLY:STILL_ALIVE')`);
        await evaluate(`electronAPI.sshDisconnect('tab-2')`);
        await wait(
          `terminalTabs.get('tab-2').pendingRemote&&!terminalTabs.get('tab-2').isConnected`,
        );
        assert.equal(
          await evaluate(`sendTerminalInput('tab-2','NEVER_LOCAL')`),
          false,
        );
        assert.equal(
          (
            await evaluate(
              `electronAPI.terminalExecuteAudited('printf NEVER_LOCAL','tab-2')`,
            )
          ).success,
          false,
        );
        assert.equal(
          await evaluate(
            `terminalTabs.get('tab-2').localTerminalActive||terminalTabs.get('tab-2').localTerminalStarting`,
          ),
          false,
        );
        assert.equal(
          await evaluate(
            `autoConnectSSH(${JSON.stringify(first.config)},'tab-2')`,
          ),
          true,
        );
        await evaluate(`electronAPI.sshSendRaw('RECONNECTED','tab-2')`);
        await wait(`(${text("tab-2")}).includes('ALPHA_REPLY:RECONNECTED')`);
        await evaluate(
          `Promise.all([createNewTerminalTab(),createNewTerminalTab()])`,
        );
        assert.equal(
          await evaluate(
            `[...terminalTabs].every(([id,info])=>info.container.id==='terminalContainer-'+id.split('-')[1])`,
          ),
          true,
        );
        console.log(
          "Workspace smoke ok: native splits/shortcuts, real SSH transports/SFTP, " +
            (process.platform === "win32"
              ? "local WSL skipped on hosted Windows"
              : "local PTY") +
            ", mouse focus/input, backend sizes, DPI, drag/drop/zoom/detach, model and draft isolation, panel ownership, credential-free restore, SSH disconnect/reconnect, closed ownership, concurrent creation",
        );
      },
      {
        prepareProfile: (profile) =>
          fs.writeFileSync(
            path.join(profile, "known_hosts"),
            first.knownHosts + second.knownHosts,
          ),
      },
    );
  } finally {
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
    await first.close();
    await second.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
