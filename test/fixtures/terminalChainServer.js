"use strict";
// POSIX-only integration fixture: a real interactive shell behind loopback SSH.
const { Server, utils } = require("ssh2");
const pty = require("node-pty");
const {
  rememberHostKey,
  serializeKnownHosts,
} = require("../../lib/knownHosts");
async function terminalChainServer(name, cwd) {
  const key = utils.generateKeyPairSync("ed25519").private,
    clients = new Set(),
    processes = new Set(),
    input = [],
    exec = [];
  const server = new Server({ hostKeys: [key] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => {});
    client.on("authentication", (ctx) =>
      ctx.username === "fixture" ? ctx.accept() : ctx.reject(),
    );
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        let proc,
          size = { cols: 80, rows: 24 };
        session.on("pty", (accept, _reject, info) => {
          size = { cols: info.cols, rows: info.rows };
          accept();
        });
        session.on("window-change", (accept, _reject, info) => {
          proc?.resize(info.cols, info.rows);
          accept?.();
        });
        session.on("exec", (_accept, reject, info) => {
          exec.push(info.command);
          reject();
        });
        session.on("shell", (accept) => {
          const channel = accept();
          proc = pty.spawn("/bin/bash", ["--noprofile", "--norc", "-i"], {
            ...size,
            name: "xterm-256color",
            cwd,
            env: {
              ...process.env,
              PS1: name + "$ ",
              AIT_SCOPE: name,
              TERM: "xterm-256color",
              HISTFILE: "/dev/null",
              PROMPT_COMMAND: "",
            },
          });
          processes.add(proc);
          proc.onData((data) => {
            try {
              channel.write(data);
            } catch {}
          });
          proc.onExit(({ exitCode }) => {
            processes.delete(proc);
            try {
              channel.exit(exitCode);
              channel.end();
            } catch {}
          });
          channel.on("data", (data) => {
            input.push(data.toString());
            proc.write(data.toString());
          });
          channel.on("close", () => {
            try {
              proc.kill();
            } catch {}
          });
          channel.on("error", () => {});
        });
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port,
    records = new Map();
  rememberHostKey(
    records,
    "127.0.0.1",
    port,
    utils.parseKey(key).getPublicSSH(),
  );
  return {
    port,
    config: {
      host: "127.0.0.1",
      port,
      username: "fixture",
      password: "fixture-only",
      enableAI: false,
    },
    knownHosts: serializeKnownHosts(records),
    input,
    exec,
    close: async () => {
      for (const proc of processes)
        try {
          proc.kill();
        } catch {}
      for (const client of clients) client.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
module.exports = { terminalChainServer };
