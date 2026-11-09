"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../lib/workspaceLayout");
test("nested splits preserve sessions and collapse only the removed branch", () => {
  const tree = L.split(
    L.split(L.leaf("a"), "a", "b"),
    "b",
    "c",
    "vertical",
    true,
  );
  assert.deepEqual(L.leaves(tree), ["a", "c", "b"]);
  assert.deepEqual(L.leaves(L.remove(tree, "c")), ["a", "b"]);
  assert.deepEqual(L.remove(L.remove(tree, "a"), "b"), L.leaf("c"));
  assert.deepEqual(L.leaves(L.map(tree, (id) => "new-" + id)), [
    "new-a",
    "new-c",
    "new-b",
  ]);
  assert.throws(() => L.split(tree, "a", "b"));
});
test("workspace restore rejects duplicate, dangling and deeply nested sessions", () => {
  const input = {
    version: 1,
    sessions: [{ id: "a" }, { id: "b" }],
    groups: [L.split(L.leaf("a"), "a", "b")],
  };
  assert.equal(L.validate(input).sessions.length, 2);
  assert.throws(() =>
    L.validate({ ...input, groups: [L.leaf("a"), L.leaf("a")] }),
  );
  assert.throws(() => L.validate({ ...input, groups: [L.leaf("a")] }));
  assert.throws(() => L.validate({ ...input, groups: [L.leaf("other")] }));
  let tree = L.leaf("a");
  for (let i = 0; i < 34; i++)
    tree = { type: "split", axis: "vertical", children: [tree, L.leaf("b")] };
  assert.throws(() => L.validate({ ...input, groups: [tree] }));
});
test("layout files cannot persist credentials or automatically executed commands", () => {
  const result = L.validate({
    version: 1,
    sessions: [
      {
        id: "a",
        connection: {
          host: "example",
          username: "ops",
          password: "secret",
          passphrase: "secret",
          aiApiKey: "secret",
          aiBaseUrl: "https://secret",
          autoCommand: "danger",
          webhookConfig: { url: "secret" },
        },
      },
    ],
    groups: [L.leaf("a")],
    active: "a",
  });
  assert.deepEqual(result.sessions[0].connection, {
    host: "example",
    username: "ops",
    port: 22,
    authMethod: "password",
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});
