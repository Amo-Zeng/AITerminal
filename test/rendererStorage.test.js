'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readObject, terminalConfig } = require('../rendererStorage');
test('damaged, null, array or unavailable saved settings do not break startup', () => {
    for (const raw of ['{bad', 'null', '[]', 'false', '3', '"x"', ' '.repeat(2 * 1024 * 1024 + 1)]) assert.deepEqual(readObject({ getItem: () => raw }, 'settings'), {});
    assert.deepEqual(readObject({ getItem: () => { throw new Error('unavailable'); } }, 'settings'), {});
    assert.deepEqual(readObject({ getItem: () => '{"__proto__":{"polluted":1},"host":"test"}' }, 'settings'), { host: 'test' });
});
test('invalid saved terminal dimensions and types fall back before xterm construction', () => {
    const defaults = { fontSize: 14, fontFamily: 'monospace', scrollback: 1000, theme: 'dark', cursorBlink: true };
    assert.deepEqual(terminalConfig({ fontSize: -3, scrollback: 'oops', theme: 'constructor', cursorBlink: null }, defaults, { dark: {} }), defaults);
    assert.equal(terminalConfig({ fontSize: 18 }, defaults, { dark: {} }).fontSize, 18);
});
