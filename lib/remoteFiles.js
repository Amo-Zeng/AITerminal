"use strict";

// Bind each channel to the connection captured before an asynchronous action.
// A reconnect must never redirect an old file operation to the new server.
function withRemoteSftp(connection, valid, operation, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let sftp,
      timer,
      settled = false;
    const check = () => {
      if (settled || !valid()) throw new Error("SSH 会话已变化");
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sftp?.end();
      } catch {}
      if (error) reject(error);
      else resolve(value);
    };
    timer = setTimeout(
      () => finish(new Error("SFTP 操作超时")),
      timeoutMs > 0 ? timeoutMs : 15000,
    );
    try {
      check();
      connection.sftp((error, channel) => {
        if (settled) {
          try {
            channel?.end();
          } catch {}
          return;
        }
        sftp = channel;
        if (error) return finish(error);
        // Large transfers have no total-duration cap, but channel negotiation does.
        if (timeoutMs === 0) clearTimeout(timer);
        try {
          channel.on("error", (error) => finish(error));
          channel.once("close", () => finish(new Error("SFTP 连接已关闭")));
          check();
          Promise.resolve(operation(channel, check)).then((value) => {
            try {
              check();
              finish(null, value);
            } catch (error) {
              finish(error);
            }
          }, finish);
        } catch (error) {
          finish(error);
        }
      });
    } catch (error) {
      finish(error);
    }
  });
}

// Use the SFTP protocol: parsing `ls` loses spaces, Unicode and newline names.
function listRemoteFiles(connection, remotePath, valid = () => true) {
  return withRemoteSftp(connection, valid, async (channel, check) => {
    const canonical = await new Promise((resolve, reject) =>
      channel.realpath(remotePath || ".", (error, value) =>
        error ? reject(error) : resolve(value),
      ),
    );
    check();
    const entries = await new Promise((resolve, reject) =>
      channel.readdir(canonical, (error, value) =>
        error ? reject(error) : resolve(value),
      ),
    );
    check();
    if (entries.length > 5000)
      throw new Error("目录超过 5000 项，请在终端使用筛选命令查看");
    const files = entries
      .filter((entry) => ![".", ".."].includes(entry.filename))
      .map((entry) => ({
        name: entry.filename,
        isDirectory: entry.attrs.isDirectory(),
        isImage: /\.(png|jpe?g|gif|webp|bmp)$/i.test(entry.filename),
        size: entry.attrs.size,
      }))
      .sort(
        (a, b) =>
          Number(b.isDirectory) - Number(a.isDirectory) ||
          a.name.localeCompare(b.name),
      );
    return { success: true, isRfeResult: true, files, path: canonical };
  });
}

module.exports = { listRemoteFiles, withRemoteSftp };
