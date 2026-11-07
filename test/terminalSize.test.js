'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeTerminalSize } = require('../lib/terminalSize');

test('terminal dimensions use stable defaults for invalid input', () => {
    assert.deepEqual(sanitizeTerminalSize(undefined, 'not-a-number'), { cols: 80, rows: 24 });
});

test('terminal dimensions are integer-clamped to safe PTY and SSH bounds', () => {
    assert.deepEqual(sanitizeTerminalSize('10000', '-1'), { cols: 1000, rows: 2 });
    assert.deepEqual(sanitizeTerminalSize(91.9, 37.2), { cols: 91, rows: 37 });
});
