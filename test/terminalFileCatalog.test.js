'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TerminalFileCatalog } = require('../lib/terminalFileCatalog');
const listing = { success: true, path: '/files', files: [{ name: '中文 file.txt' }, { name: 'folder', isDirectory: true }, { name: 'line\nbreak' }] };
test('file links keep their tab, SSH connection, directory and exact path', async () => {
    const catalog = new TerminalFileCatalog(), owner = { sshConnection: {}, currentWorkingDirectory: '/files' };
    let loads = 0;
    const options = { valid: () => true, load: async () => { loads++; return listing; } };
    const result = await catalog.list(owner, options);
    assert.equal((await catalog.list(owner, options)).token, result.token);
    assert.equal(loads, 1);
    assert.equal(result.files.length, 1);
    assert.equal(catalog.accepts(owner, '/files/中文 file.txt', result.token), true);
    assert.equal(catalog.accepts({ ...owner }, '/files/中文 file.txt', result.token), false);
    assert.equal(catalog.accepts(owner, '/files/unlisted', result.token), false);
    owner.currentWorkingDirectory = '/elsewhere';
    assert.equal(catalog.accepts(owner, '/files/中文 file.txt', result.token), false);
    owner.currentWorkingDirectory = '/files'; owner.sshConnection = {};
    assert.equal(catalog.accepts(owner, '/files/中文 file.txt', result.token), false);
});
test('delayed directory listings cannot survive reconnect or directory changes', async () => {
    for (const field of ['sshConnection', 'currentWorkingDirectory']) {
        const catalog = new TerminalFileCatalog(), owner = { sshConnection: {}, currentWorkingDirectory: '/files' };
        let finish;
        const request = catalog.list(owner, { valid: () => true, load: () => new Promise(resolve => { finish = resolve; }) });
        owner[field] = field === 'sshConnection' ? {} : '/new';
        finish(listing);
        await assert.rejects(request, /已变化/);
    }
});
