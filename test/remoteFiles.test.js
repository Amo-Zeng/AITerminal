"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { listRemoteFiles, withRemoteSftp } = require("../lib/remoteFiles");

function fixture() {
  const channel = new EventEmitter();
  channel.closed = 0;
  channel.end = () => {
    channel.closed++;
    channel.emit("close");
  };
  channel.realpath = (_path, callback) => callback(null, "/logs");
  const connection = { sftp: (callback) => callback(null, channel) };
  return { connection, channel };
}

test("SFTP directory listing preserves names and orders directories before files", async () => {
  const { connection, channel } = fixture();
  channel.readdir = (_path, callback) =>
    callback(null, [
      {
        filename: "中文 file\nname.txt",
        attrs: { isDirectory: () => false, size: 9 },
      },
      { filename: "logs", attrs: { isDirectory: () => true, size: 0 } },
      { filename: ".", attrs: { isDirectory: () => true } },
    ]);
  const result = await listRemoteFiles(connection, ".");
  assert.equal(result.path, "/logs");
  assert.deepEqual(
    result.files.map((file) => file.name),
    ["logs", "中文 file\nname.txt"],
  );
  assert.equal(channel.closed, 1);
});

test("a replaced connection cancels directory callbacks and transfer completion", async () => {
  const { connection, channel } = fixture();
  let valid = true,
    complete;
  channel.readdir = (_path, callback) => {
    complete = callback;
  };
  const listing = listRemoteFiles(connection, ".", () => valid);
  await new Promise((resolve) => setImmediate(resolve));
  valid = false;
  complete(null, []);
  await assert.rejects(listing, /会话已变化/);
  assert.equal(channel.closed, 1);

  const transfer = fixture();
  valid = true;
  const pending = withRemoteSftp(
    transfer.connection,
    () => valid,
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  valid = false;
  complete("downloaded");
  await assert.rejects(pending, /会话已变化/);
  let opened = false;
  await assert.rejects(
    withRemoteSftp(
      {
        sftp() {
          opened = true;
        },
      },
      () => false,
      () => {},
    ),
    /会话已变化/,
  );
  assert.equal(opened, false);
});

test("SFTP errors and malformed metadata close channels without hanging", async () => {
  for (const mode of ["error", "close", "metadata", "throw", "oversized"]) {
    const { connection, channel } = fixture();
    channel.readdir = () => {};
    if (mode === "metadata")
      channel.readdir = (_path, cb) =>
        cb(null, [{ filename: "broken", attrs: {} }]);
    if (mode === "throw")
      channel.realpath = () => {
        throw new Error("sync failure");
      };
    if (mode === "oversized")
      channel.readdir = (_path, cb) => cb(null, Array(5001));
    const pending = listRemoteFiles(connection, ".");
    if (mode === "error") channel.emit("error", new Error("transport failed"));
    if (mode === "close") channel.emit("close");
    await assert.rejects(pending);
    assert.equal(channel.closed, 1, mode);
  }
  await assert.rejects(
    listRemoteFiles(
      {
        sftp() {
          throw new Error("not connected");
        },
      },
      ".",
    ),
    /not connected/,
  );
});

test("timed out SFTP negotiation disposes a late channel without executing work", async () => {
  let negotiated,
    executed = false;
  const pending = withRemoteSftp(
    {
      sftp(callback) {
        negotiated = callback;
      },
    },
    () => true,
    () => {
      executed = true;
    },
    10,
  );
  await assert.rejects(pending, /超时/);
  const { channel } = fixture();
  negotiated(null, channel);
  assert.equal(executed, false);
  assert.equal(channel.closed, 1);
});
