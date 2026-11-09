"use strict";

// Functional baseline: real local PTYs in an isolated temporary Electron profile.
// --splits adds 8 visible panes and a short output burst; this is not a benchmark.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { runElectronSmoke } = require("./clipboardSmoke");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(check, label) {
  const until = Date.now() + 20000;
  do {
    if (await check()) return;
    await delay(50);
  } while (Date.now() < until);
  throw new Error(`Timed out: ${label}`);
}

async function main() {
  const withSplits = process.argv.includes("--splits");
  const source = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
  }).trim();
  const result = {
    date: new Date().toISOString(),
    source,
    sourceDirty: !!execFileSync("git", ["status", "--porcelain"], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
    }).trim(),
    applicationVersion: require("../package.json").version,
    platform: `${process.platform} ${process.arch} ${os.release()}`,
    mode: "isolated Electron headless, disabled GPU, local PTYs only",
    limitations:
      "No SSH or cross-platform performance guarantee; no long-running load, memory or input-latency measurements.",
    checkpoints: [],
  };
  await runElectronSmoke(async ({ evaluate, client }) => {
    try {
      for (const count of [1, 8, 16, 32]) {
        while ((await evaluate("terminalTabs.size")) < count)
          await evaluate("createNewTerminalTab()");
        await eventually(
          () =>
            evaluate(
              `[...terminalTabs.values()].every(info => info.localTerminalActive && info.localTerminalUsingPty)`,
            ),
          `${count} real PTYs`,
        );
        const responses = await evaluate(
          `Promise.all([...terminalTabs.keys()].map(id => window.electronAPI.terminalLocalSend(id, "printf '%s%s\\\\n' 'AIT_BASELINE_${count}_' '" + id + "'\\r")))`,
        );
        assert.ok(
          responses.every((item) => item?.success),
          "Every PTY accepts its own input",
        );
        await eventually(
          () =>
            evaluate(`(() => {
                    return [...terminalTabs].every(([id, info]) => {
                        const b = info.terminal.buffer.active;
                        return Array.from({length:b.length}, (_,i)=>b.getLine(i)?.translateToString(true)).includes('AIT_BASELINE_${count}_'+id);
                    });
                })()`),
          `${count} terminal outputs`,
        );
        const state = await evaluate(`(() => {
                    const tabs = [...terminalTabs];
                    return {
                        tabs: tabs.length,
                        realPtys: tabs.filter(([,i])=>i.localTerminalActive && i.localTerminalUsingPty).length,
                        visible: tabs.filter(([id])=>isTabVisible(id)).length,
                        isolated: tabs.every(([id, info])=> {
                            const b=info.terminal.buffer.active;
                            return !Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').some(line=>line.startsWith('AIT_BASELINE_${count}_')&&line!=='AIT_BASELINE_${count}_'+id);
                        }),
                        viewport: {width:innerWidth,height:innerHeight}
                    };
                })()`);
        assert.equal(state.isolated, true);
        assert.equal(state.visible, 1);
        result.checkpoints.push(state);
      }
      if (withSplits) {
        await client.send("Emulation.setDeviceMetricsOverride", {
          width: 1920,
          height: 1080,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await evaluate(`(() => {
                    for (const [source,target,edge] of [[2,1,'right'],[3,1,'bottom'],[4,2,'bottom'],[5,1,'bottom'],[6,3,'bottom'],[7,2,'bottom'],[8,4,'bottom']])
                        workspace.move('tab-'+source,'tab-'+target,edge);
                    workspace.fit();
                })()`);
        await eventually(
          () =>
            evaluate(
              `[...terminalTabs].filter(([id])=>isTabVisible(id)).length===8`,
            ),
          "8 visible panes",
        );
        const commands = Array.from({ length: 32 }, (_, i) => {
          const id = "tab-" + (i + 1);
          return {
            id,
            command: `i=0; while [ "$i" -lt 100 ]; do printf '%s %s\\n' 'BURST_${id}' "$i"; i=$((i+1)); sleep 0.1; done; printf '%s%s\\n' 'DONE_' '${id}'\r`,
          };
        });
        const responses = await evaluate(
          `Promise.all(${JSON.stringify(commands)}.map(({id,command})=>electronAPI.terminalLocalSend(id,command)))`,
        );
        assert.ok(responses.every((item) => item.success));
        await eventually(
          () =>
            evaluate(
              `[...terminalTabs].every(([id,info])=>{const b=info.terminal.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)).includes('DONE_'+id);})`,
            ),
          "32 short output bursts complete",
        );
        const state = await evaluate(`(() => {
                    const tabs=[...terminalTabs];
                    return {
                        tabs:tabs.length, realPtys:tabs.filter(([,i])=>i.localTerminalActive&&i.localTerminalUsingPty).length,
                        visible:tabs.filter(([id])=>isTabVisible(id)).length,
                        isolated:tabs.every(([id,info])=>{const b=info.terminal.buffer.active;return !Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').some(line=>line.startsWith('BURST_')&&!line.startsWith('BURST_'+id+' '));}),
                        panes:tabs.filter(([id])=>isTabVisible(id)).map(([id,info])=>({id,cols:info.terminal.cols,rows:info.terminal.rows})),
                        viewport:{width:innerWidth,height:innerHeight}, linesPerSession:100, intervalMs:100
                    };
                })()`);
        assert.equal(state.isolated, true);
        assert.equal(state.visible, 8);
        assert.ok(state.panes.every((pane) => pane.cols > 30 && pane.rows > 3));
        result.splitCheck = state;
      }
      await evaluate(
        `(() => {for (const id of [...terminalTabs.keys()]) if (id !== 'tab-1') doCloseTab(id);})()`,
      );
      await eventually(
        () =>
          evaluate(
            `terminalTabs.size === 1 && activeTabId === 'tab-1' && terminalTabs.get('tab-1').localTerminalActive`,
          ),
        "return to one tab",
      );
      result.closedBackToOne = true;
    } finally {
      await evaluate(
        `(() => {for (const id of [...terminalTabs.keys()]) stopLocalTerminalForTab(id);})()`,
      );
    }
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
