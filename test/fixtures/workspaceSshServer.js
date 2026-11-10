"use strict";
const { Server, utils } = require("ssh2");
const crypto = require("node:crypto");
const {
  rememberHostKey,
  serializeKnownHosts,
} = require("../../lib/knownHosts");

// A real loopback SSH/SFTP transport with a deterministic echo shell. It never
// executes received commands on the machine running tests.
async function createWorkspaceSshServer(name, fileContents = null, { beforeFileRead } = {}) {
  const key = utils.generateKeyPairSync("ed25519").private;
  const password = crypto.randomBytes(16).toString("hex");
  const clients = new Set(),
    sizes = [],
    input = [];
  const downloads = [];
  const server = new Server({ hostKeys: [key] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => {});
    client.on("authentication", (ctx) =>
      ctx.method === "password" && ctx.password === password
        ? ctx.accept()
        : ctx.reject(),
    );
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        if (fileContents) session.on("exec", (accept, _reject, info) => {
          const channel = accept();
          // A separate exec channel starts in the login home, not the shell's cwd.
          channel.end(info.command === 'pwd' ? '/login\n' : '');
          channel.exit(0);
        });
        session.on("pty", (accept, _reject, info) => {
          sizes.push({ cols: info.cols, rows: info.rows });
          accept();
        });
        session.on("window-change", (accept, _reject, info) => {
          sizes.push({ cols: info.cols, rows: info.rows });
          accept?.();
        });
        session.on("shell", (accept) => {
          const channel = accept();
          channel.write(`${name}_READY\r\n`);
          channel.on("data", (data) => {
            input.push(data.toString());
            if (fileContents && data.toString().trim() === 'cd /') {
              channel.write('\r\nfixture@host:/$ ');
              return;
            }
            if (fileContents && data.toString().trim() === 'ls') {
              channel.write('\x1b[2J\x1b[H' + Object.keys(fileContents).map(filename => `\x1b[32m${filename}\x1b[0m`).join('  ') + '\r\nfixture@host:/fixture$ ');
              return;
            }
            channel.write(
              `${name}_REPLY:${data.toString().replace(/[\r\n]+$/, "")}\r\n`,
            );
          });
          channel.on("error", () => {});
        });
        session.on("sftp", (accept) => {
          const channel = accept();
          const handles = new Set();
          const fileHandles = new Map();
          const attrs = size => ({ mode: 0o100644, size, uid: 0, gid: 0, atime: 0, mtime: 0 });
          if (fileContents) {
            channel.on('OPEN', (id, file) => {
              const filename = file.replace(/^\/fixture\//, '');
              if (!Object.hasOwn(fileContents, filename)) return channel.status(id, 2);
              const handle = crypto.randomBytes(8);
              fileHandles.set(handle.toString('hex'), Buffer.from(fileContents[filename]));
              downloads.push(file);
              channel.handle(id, handle);
            });
            channel.on('FSTAT', (id, handle) => {
              const data = fileHandles.get(handle.toString('hex'));
              if (data) channel.attrs(id, attrs(data.length)); else channel.status(id, 2);
            });
            channel.on('READ', async (id, handle, offset, length) => {
              const data = fileHandles.get(handle.toString('hex'));
              if (!data) return channel.status(id, 2);
              if (offset >= data.length) return channel.status(id, 1);
              try {
                await beforeFileRead?.();
                channel.data(id, data.subarray(offset, offset + length));
              } catch {
                if (!channel.destroyed) channel.status(id, 4);
              }
            });
          }
          channel.on("REALPATH", (reqid, value) =>
            channel.name(reqid, [
              {
                filename: value === "." ? "/fixture" : value,
                longname: "",
                attrs: {},
              },
            ]),
          );
          channel.on("OPENDIR", (reqid) => {
            const handle = crypto.randomBytes(8);
            handles.add(handle.toString("hex"));
            channel.handle(reqid, handle);
          });
          channel.on("READDIR", (reqid, handle) => {
            if (!handles.delete(handle.toString("hex")))
              return channel.status(reqid, 1);
            if (fileContents) return channel.name(reqid, Object.entries(fileContents).map(([filename, data]) => ({ filename, longname: '', attrs: attrs(Buffer.byteLength(data)) })));
            channel.name(reqid, [
              {
                filename: `${name} 中文 file\nname.txt`,
                longname: "",
                attrs: {
                  mode: 0o100644,
                  size: 4,
                  uid: 0,
                  gid: 0,
                  atime: 0,
                  mtime: 0,
                },
              },
              {
                filename: "logs",
                longname: "",
                attrs: {
                  mode: 0o040755,
                  size: 0,
                  uid: 0,
                  gid: 0,
                  atime: 0,
                  mtime: 0,
                },
              },
            ]);
          });
          channel.on("CLOSE", (reqid) => channel.status(reqid, 0));
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
    config: {
      host: "127.0.0.1",
      port,
      username: "fixture",
      password,
      enableAI: false,
      rememberPassword: false,
    },
    knownHosts: serializeKnownHosts(records),
    sizes,
    input,
    downloads,
    close: async () => {
      for (const client of clients) client.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
module.exports = { createWorkspaceSshServer };
