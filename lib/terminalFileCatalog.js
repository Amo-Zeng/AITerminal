'use strict';
const { randomUUID } = require('node:crypto');

// One bounded directory snapshot per tab. A link is a reference to its SSH
// connection and directory, never to whichever tab happens to be active later.
class TerminalFileCatalog {
    constructor() { this.snapshots = new WeakMap(); }
    async list(owner, { valid, load }) {
        if (!owner?.sshConnection || !valid()) throw new Error('SSH 会话已变化');
        const connection = owner.sshConnection, directory = owner.currentWorkingDirectory;
        const previous = this.snapshots.get(owner);
        if (previous?.connection === connection && previous.directory === directory && Date.now() - previous.created < 2000)
            return previous.promise;
        const snapshot = { connection, directory, created: Date.now(), token: randomUUID(), paths: new Set() };
        this.snapshots.set(owner, snapshot);
        snapshot.promise = (async () => {
            const result = await load();
            if (!valid() || owner.sshConnection !== connection || owner.currentWorkingDirectory !== directory || this.snapshots.get(owner) !== snapshot)
                throw new Error('SSH 目录或会话已变化');
            if (!result.success) throw new Error(result.error || '读取目录失败');
            const files = result.files.filter(file => !file.isDirectory && typeof file.name === 'string' && file.name && !/[\x00-\x1f\x7f/]/.test(file.name)).map(file => {
                const remotePath = result.path.replace(/\/$/, '') + '/' + file.name;
                snapshot.paths.add(remotePath);
                return { name: file.name, path: remotePath };
            });
            return { success: true, token: snapshot.token, files, path: result.path };
        })();
        return snapshot.promise;
    }
    accepts(owner, remotePath, token) {
        const snapshot = owner && this.snapshots.get(owner);
        return !!snapshot && snapshot.token === token && snapshot.connection === owner.sshConnection &&
            snapshot.directory === owner.currentWorkingDirectory && Date.now() - snapshot.created < 60000 && snapshot.paths.has(remotePath);
    }
}
module.exports = { TerminalFileCatalog };
