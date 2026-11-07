'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeTerminalInput } = require('../lib/terminalInput');

test('legacy mouse coordinates survive the IPC string round-trip as raw bytes', () => {
    const raw = Buffer.from([0x1b, 0x5b, 0x4d, 0x60, 0xc8, 0x30]);
    const payload = JSON.parse(JSON.stringify({ data: raw.toString('latin1'), encoding: 'binary' }));
    assert.deepEqual(decodeTerminalInput(payload.data, payload.encoding), raw);
    assert.notDeepEqual(Buffer.from(payload.data, 'utf8'), raw);
});

test('Unicode typing and SGR mouse input retain UTF-8 semantics', () => {
    assert.equal(decodeTerminalInput('中😀'), '中😀');
    assert.equal(decodeTerminalInput('\x1b[<64;120;20M'), '\x1b[<64;120;20M');
});

test('invalid binary data and unknown input encodings are rejected', () => {
    assert.throws(() => decodeTerminalInput('中', 'binary'), /Invalid/);
    assert.throws(() => decodeTerminalInput('anything', 'base64'), /Invalid/);
    assert.throws(() => decodeTerminalInput({}, 'utf8'), /Invalid/);
});
