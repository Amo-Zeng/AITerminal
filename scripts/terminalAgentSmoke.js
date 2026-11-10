"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { runElectronSmoke } = require("./clipboardSmoke");
const {
  createWorkspaceSshServer,
} = require("../test/fixtures/workspaceSshServer");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ait-screen-chain-"));
  let outer, inner;
  const other = await createWorkspaceSshServer("OTHER");
  const requests = [],
    answers = [];
  let hold = null;
  const model = http.createServer((req, res) => {
    let body = "";
    req.on("data", (data) => (body += data));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const answer = answers.shift() || { action: "ask", text: "WAITING_TEST" };
      const send = () => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(answer) } }],
          }),
        );
      };
      if (hold === true) hold = send;
      else setTimeout(send, 250);
    });
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  try {
    if (process.platform !== "win32") {
      const {
        terminalChainServer,
      } = require("../test/fixtures/terminalChainServer");
      outer = await terminalChainServer("OUTER", root);
      inner = await terminalChainServer("INNER", root);
    } else outer = await createWorkspaceSshServer("OUTER");
    await runElectronSmoke(
      async ({ evaluate, client }) => {
        // Windows headless desktops may start at 800x600 regardless of the
        // requested native window size. Keep screen-content assertions at the
        // app's default viewport; appearanceSmoke covers narrow layouts.
        await client.send("Emulation.setDeviceMetricsOverride", {
          width: 1400, height: 900, deviceScaleFactor: 1, mobile: false,
        });
        await evaluate(`workspace.fit()`);
        const wait = async (check, label) => {
          const until = Date.now() + 20000;
          do {
            if (await check()) return;
            await delay(50);
          } while (Date.now() < until);
          throw new Error("Screen agent timeout: " + label);
        };
        const text = (id) =>
          `(()=>{const b=terminalTabs.get('${id}').terminal.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join(${JSON.stringify("\n")});})()`;
        const check = async (expression) => {
          const result = await evaluate(expression);
          assert.equal(result.success, true, result.error || result.message);
          return result;
        };
        const config = {
          aiApiKey: "fixture-placeholder",
          aiBaseUrl: `http://127.0.0.1:${model.address().port}`,
          aiModel: "screen-fixture",
          enableAI: true,
          aiDisplayMode: "terminal",
        };
        if (process.platform !== "win32") {
          await wait(
            () => evaluate(`terminalTabs.get('tab-1').localTerminalActive`),
            "local PTY",
          );
          await check(
            `electronAPI.aiConfigure(${JSON.stringify(config)},'tab-1')`,
          );
          answers.push(
            { action: "line", text: "printf '%s%s\\n' 'LOCAL_SCREEN_' 'ONLY'" },
            { action: "complete", text: "LOCAL_TASK_COMPLETE" },
          );
          await check(
            `electronAPI.aiTakeoverStart({task:'验证本地终端'},'tab-1')`,
          );
          await wait(
            () =>
              evaluate(
                `terminalTabs.get('tab-1').aiResult?.response.includes('LOCAL_TASK_COMPLETE')`,
              ),
            "local agent completed",
          );
          assert.ok(
            await evaluate(`(${text("tab-1")}).includes('LOCAL_SCREEN_ONLY')`),
          );
          requests.length = 0;
        }
        await evaluate(`workspace.split('horizontal','tab-1')`);
        await check(
          `autoConnectSSH(${JSON.stringify(other.config)},'tab-2').then(success=>({success}))`,
        );
        await check(
          `autoConnectSSH(${JSON.stringify(outer.config)},'tab-1').then(success=>({success}))`,
        );
        if (inner) {
          const command = `ssh -tt -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PreferredAuthentications=none -p ${inner.port} fixture@127.0.0.1\r`;
          await check(
            `electronAPI.sshSendRaw(${JSON.stringify(command)},'tab-1')`,
          );
          await wait(
            () => evaluate(`(${text("tab-1")}).includes('INNER$')`),
            "nested SSH shell",
          );
        } else {
          // A successful SSH channel handshake does not mean xterm has parsed
          // its first output frame. Capture only after the fixture is visible.
          await wait(
            () => evaluate(`(${text("tab-1")}).includes('OUTER_READY')`),
            "SSH greeting rendered before screen capture",
          );
        }
        const baselineExec = outer.exec?.length || 0;
        await check(
          `electronAPI.aiConfigure(${JSON.stringify(config)},'tab-1')`,
        );
        await evaluate(
          `terminalTabs.get('tab-1').aiConfigSnapshot=sanitizeConfigForStorage(${JSON.stringify(config)});switchToTab('tab-1')`,
        );
        answers.push(
          {
            action: "line",
            text: inner ? "printf 'SCOPE=%s\\n' \"$AIT_SCOPE\"" : "SCREEN_ONLY",
            reason: "确认当前终端的实际层级",
          },
          { action: "complete", text: "SCREEN_TASK_COMPLETE" },
        );
        await evaluate(
          `commandInput.value='识别当前终端并验证目标';document.getElementById('startTakeover').click()`,
        );
        await wait(() => requests.length > 0, "model screen request");
        await evaluate(`switchToTab('tab-2')`);
        await wait(
          () =>
            evaluate(
              `terminalTabs.get('tab-1').aiResult?.response.includes('SCREEN_TASK_COMPLETE')`,
            ),
          "task completed on original pane",
        );
        assert.equal(await evaluate("activeTabId"), "tab-2");
        assert.equal(
          other.input.join("").includes("SCREEN_ONLY") ||
            other.input.join("").includes("SCOPE="),
          false,
        );
        assert.equal(
          await evaluate(`(${text("tab-1")}).includes('[AI接管]')`),
          false,
          "agent logs do not corrupt TUI screen",
        );
        assert.ok(
          requests[0].messages
            .at(-1)
            .content.includes(inner ? "INNER$" : "OUTER_READY"),
        );
        assert.equal(
          requests[0].tools,
          undefined,
          "screen control exposes no host execution tools",
        );
        if (inner) {
          assert.equal(
            await evaluate(`(${text("tab-1")}).includes('SCOPE=INNER')`),
            true,
          );
          assert.ok(inner.input.join("").includes("$AIT_SCOPE"));
          assert.equal(
            outer.exec.length,
            baselineExec,
            "no hidden first-hop exec during screen takeover",
          );
          const interactive =
            "printf '\\033[?1049h\\033[2J\\033[HINTERACTIVE_READY'; stty -echo -icanon; key=$(dd bs=1 count=1 2>/dev/null); stty echo icanon; printf '\\033[?1049lINTERACTIVE_KEY=%s\\n' \"$key\"\r";
          await check(
            `electronAPI.sshSendRaw(${JSON.stringify(interactive)},'tab-1')`,
          );
          await wait(
            () =>
              evaluate(
                `terminalTabs.get('tab-1').terminal.buffer.active.type==='alternate'&&(${text("tab-1")}).includes('INTERACTIVE_READY')`,
              ),
            "alternate screen",
          );
          answers.push(
            { action: "send", text: "x", reason: "回应正在等待按键的交互程序" },
            { action: "complete", text: "INTERACTIVE_COMPLETE" },
          );
          const requestIndex = requests.length;
          await check(
            `electronAPI.aiTakeoverStart({task:'操作当前交互界面',target:'terminal'},'tab-1')`,
          );
          await wait(
            () =>
              evaluate(
                `terminalTabs.get('tab-1').aiResult?.response.includes('INTERACTIVE_COMPLETE')`,
              ),
            "interactive agent completed",
          );
          assert.ok(
            await evaluate(`(${text("tab-1")}).includes('INTERACTIVE_KEY=x')`),
          );
          assert.ok(
            requests[requestIndex].messages
              .at(-1)
              .content.includes('"buffer":"alternate"'),
          );
        }
        // A response arriving after manual input cannot press keys in either pane.
        hold = true;
        answers.push({ action: "line", text: "LATE_INPUT_MUST_NOT_RUN" });
        await check(
          `electronAPI.aiTakeoverStart({task:'等待并输入',target:'terminal'},'tab-1')`,
        );
        await wait(() => typeof hold === "function", "held response");
        await evaluate(
          `switchToTab('tab-1');terminalTabs.get('tab-1').terminal.focus()`,
        );
        await client.send("Input.insertText", { text: "manual-input" });
        await wait(
          () => evaluate(`terminalTabs.get('tab-1').aiWaitingForUserInput`),
          "manual pause",
        );
        hold();
        hold = null;
        await delay(400);
        assert.equal(
          outer.input.join("").includes("LATE_INPUT_MUST_NOT_RUN"),
          false,
        );
        assert.equal(
          inner?.input.join("").includes("LATE_INPUT_MUST_NOT_RUN") || false,
          false,
        );
        assert.equal(
          await evaluate(
            `terminalTabs.get('tab-1').terminal.element.contains(document.activeElement)`,
          ),
          true,
          "manual typing keeps terminal focus",
        );
        assert.equal(
          await evaluate(`terminalTabs.get('tab-1').aiWaitingForUserInput`),
          true,
        );
        await check(`electronAPI.sshDisconnect('tab-1')`);
        assert.equal(
          (await evaluate(`electronAPI.aiTakeoverResume('继续','tab-1')`))
            .success,
          false,
        );
        console.log(
          "Terminal agent smoke ok: " +
            (inner
              ? "local PTY, real SSH → SSH → shell, inner-host execution, alternate-screen interaction"
              : "Windows real SSH transport") +
            ", focused launch, background ownership, screen context, no hidden exec, no TUI pollution, manual pause without stealing focus, late response rejection, disconnect invalidation",
        );
      },
      {
        prepareProfile: (profile) =>
          fs.writeFileSync(
            path.join(profile, "known_hosts"),
            outer.knownHosts + other.knownHosts,
          ),
      },
    );
  } finally {
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
    await outer?.close();
    await inner?.close();
    await other.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
