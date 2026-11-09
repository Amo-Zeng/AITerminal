"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TerminalAgent,
  parseAction,
  inputFor,
} = require("../lib/terminalAgent");
const { TerminalScreenBroker } = require("../lib/terminalScreen");
const screen = {
  cols: 80,
  rows: 24,
  screen: "inner$ ",
  cursor: { x: 7, y: 0 },
  buffer: "normal",
};
function setup(overrides = {}) {
  const writes = [],
    events = [],
    audits = [];
  const agent = new TerminalAgent({
    read: async () => screen,
    write: (x) => writes.push(x),
    model: async () => JSON.stringify({ action: "complete", text: "done" }),
    valid: () => true,
    approve: async (_subject, audit) => {
      audits.push(audit);
      return true;
    },
    event: (type, message) => events.push({ type, message }),
    cancel() {},
    delay: async () => {},
    ...overrides,
  });
  return { agent, writes, events, audits };
}
test("terminal action parser rejects escape sequences, unsupported tools and ambiguous multi-actions", () => {
  assert.throws(() => parseAction('{"action":"exec","text":"pwd"}'));
  assert.throws(() =>
    parseAction(JSON.stringify({ action: "send", text: "x\r\nrm -rf /" })),
  );
  assert.throws(() =>
    parseAction('{"action":"read"}\n{"action":"line","text":"pwd"}'),
  );
  assert.equal(
    inputFor(parseAction('{"action":"line","text":"echo ~"}'), screen),
    "echo ~\r",
  );
  assert.equal(
    inputFor(parseAction('{"action":"key","key":"UP"}'), {
      applicationCursor: true,
    }),
    "\x1bOA",
  );
});
test("pause and backend replacement revoke a delayed model input, resume never replays it", async () => {
  for (const reason of ["pause", "replace"]) {
    let complete,
      valid = true;
    const f = setup({
      model: () =>
        new Promise((r) => {
          complete = r;
        }),
      valid: () => valid,
    });
    f.agent.resume("task");
    await new Promise((r) => setImmediate(r));
    if (reason === "pause") f.agent.pause();
    else valid = false;
    complete('{"action":"line","text":"NEVER"}');
    await f.agent.done;
    assert.deepEqual(f.writes, []);
    f.agent.stop();
  }
});
test("partial inputs are accumulated for audit and denial pauses before ENTER", async () => {
  const actions = [
    { action: "send", text: "r" },
    { action: "send", text: "m -rf /" },
    { action: "key", key: "ENTER" },
  ];
  const f = setup({
    model: async () => JSON.stringify(actions.shift()),
    approve: async (subject, audit) => !audit.requiresConfirmation,
  });
  f.agent.resume("test");
  await f.agent.done;
  assert.deepEqual(f.writes, ["r"]);
  assert.equal(f.events.at(-1).type, "user_input");
});
test("late approval is invalidated by manual pause and does not write", async () => {
  let allow;
  const f = setup({
    model: async () =>
      '{"action":"line","text":"rm -rf /fixture","confirm":true}',
    approve: () =>
      new Promise((r) => {
        allow = r;
      }),
  });
  f.agent.resume("test");
  await new Promise((r) => setImmediate(r));
  f.agent.pause();
  allow(true);
  await f.agent.done;
  assert.equal(f.writes.length, 0);
});
test("long tasks keep the original goal and latest human correction within bounded history", async () => {
  let calls = 0;
  const f = setup({
    read: async () => ({ ...screen, screen: "x".repeat(24000) }),
    model: async (messages) => {
      assert.ok(messages[1].content.includes("ORIGINAL_GOAL"));
      if (calls >= 40)
        assert.ok(messages[1].content.includes("HUMAN_CORRECTION"));
      assert.ok(
        messages.reduce((size, item) => size + item.content.length, 0) < 140000,
      );
      calls++;
      return '{"action":"read"}';
    },
  });
  f.agent.resume("ORIGINAL_GOAL");
  await f.agent.done;
  assert.equal(calls, 40);
  assert.equal(f.events.at(-1).type, "user_input");
  f.agent.resume("HUMAN_CORRECTION");
  await f.agent.done;
  assert.equal(calls, 80);
  assert.ok(
    f.agent.history.reduce((size, item) => size + item.content.length, 0) <=
      192000,
  );
});
test("screen broker rejects another window, another pane, stale and timed out replies", async () => {
  const broker = new TerminalScreenBroker(20);
  let request,
    valid = true;
  const sender = {
    send(_channel, payload) {
      request = payload;
    },
  };
  const pending = broker.request(sender, "a", () => valid);
  assert.equal(broker.accept({}, { ...request, screen }), false);
  assert.equal(
    broker.accept(sender, { ...request, tabId: "b", screen }),
    false,
  );
  valid = false;
  broker.accept(sender, { ...request, screen });
  await assert.rejects(pending, /变化/);
  valid = true;
  const timeout = broker.request(sender, "a", () => valid);
  await assert.rejects(timeout, /超时/);
  assert.equal(broker.pending.size, 0);
});
