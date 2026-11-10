'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareNativeDependencies } = require('../scripts/prepareNativeDependencies');

test('macOS node-pty spawn helpers are made executable', { skip: process.platform === 'win32' }, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiterminal-node-pty-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const helper = path.join(root, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper');
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, 'helper');
    fs.chmodSync(helper, 0o644);

    const prepared = prepareNativeDependencies(root, 'darwin');

    assert.deepEqual(prepared, [helper]);
    assert.notEqual(fs.statSync(helper).mode & 0o111, 0);
});

test('native dependency preparation is a no-op on Linux', () => {
    assert.deepEqual(prepareNativeDependencies('/missing', 'linux'), []);
});

test('Windows rebuild restores matching ConPTY assets next to rebuilt native modules', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiterminal-conpty-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const pty = path.join(root, 'node_modules', 'node-pty');
    const source = path.join(pty, 'prebuilds', 'win32-x64', 'conpty');
    fs.mkdirSync(source, { recursive: true });
    for (const name of ['conpty.dll', 'OpenConsole.exe']) fs.writeFileSync(path.join(source, name), 'bundled-' + name);
    const output = path.join(pty, 'build', 'Release');
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'conpty.node'), 'rebuilt-addon');
    const { Arch } = require('builder-util');
    require('../scripts/afterExtract')({ packager: { info: { appDir: root } }, electronPlatformName: 'win32', arch: Arch.x64 });
    const prepared = prepareNativeDependencies(root, 'win32', 'x64');
    assert.equal(prepared.length, 2);
    for (const file of prepared) assert.equal(fs.readFileSync(file, 'utf8'), 'bundled-' + path.basename(file));
    assert.equal(fs.readFileSync(path.join(output, 'conpty.node'), 'utf8'), 'rebuilt-addon');
    assert.throws(() => prepareNativeDependencies(root, 'win32', 'arm64'), /missing for arm64/);
    fs.unlinkSync(path.join(source, 'conpty.dll'));
    assert.throws(() => prepareNativeDependencies(root, 'win32', 'x64'), /missing for x64/);
});
