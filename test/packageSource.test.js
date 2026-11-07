'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const asar = require('@electron/asar');
const { verifyPackageSource } = require('../scripts/verifyPackageSource');
test('packaged source gate accepts exact bytes and rejects edits after packaging', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-source-gate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source'); fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'main.js'), 'module.exports = "verified";\n');
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', main: 'main.js', license: 'Apache-2.0', dependencies: {} }));
    const archive = path.join(root, 'app.asar'); await asar.createPackage(source, archive);
    assert.equal(verifyPackageSource(source, archive, ['main.js']), 1);
    fs.writeFileSync(path.join(source, 'main.js'), 'module.exports = "changed";\n');
    assert.throws(() => verifyPackageSource(source, archive, ['main.js']), /source mismatch: main.js/);
});
