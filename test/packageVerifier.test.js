'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAsarPath } = require('../scripts/verifyWindowsPackage');

test('normalizes ASAR paths emitted with Windows separators', () => {
    assert.equal(normalizeAsarPath('\\main.js'), '/main.js');
    assert.equal(normalizeAsarPath('\\lib\\terminalSize.js'), '/lib/terminalSize.js');
    assert.equal(normalizeAsarPath('/package.json'), '/package.json');
});
