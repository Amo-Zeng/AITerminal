'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SecureStore } = require('../lib/secureStore');

function fakeSafeStorage(available = true, backend = 'kwallet6') {
    return {
        isEncryptionAvailable: () => available,
        getSelectedStorageBackend: () => backend,
        encryptString: (value) => Buffer.from(`encrypted:${value}`),
        decryptString: (value) => value.toString().replace(/^encrypted:/, '')
    };
}

test('secure store round-trips encrypted values without plaintext on disk', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-secure-'));
    const filePath = path.join(directory, 'secrets.json');
    const store = new SecureStore({ safeStorage: fakeSafeStorage(), filePath });
    assert.equal(store.save('ssh.test', { password: 'plain-secret' }).success, true);
    assert.deepEqual(store.load('ssh.test').value, { password: 'plain-secret' });
    assert.equal(fs.readFileSync(filePath, 'utf8').includes('plain-secret'), false);
    assert.equal(store.delete('ssh.test').success, true);
    assert.equal(store.load('ssh.test').value, null);
    fs.rmSync(directory, { recursive: true, force: true });
});

test('secure store refuses persistence when system encryption is unavailable', () => {
    const store = new SecureStore({ safeStorage: fakeSafeStorage(false), filePath: '/unused' });
    assert.equal(store.save('ssh.test', { password: 'x' }).error, 'secure-storage-unavailable');
});

test('secure store rejects Electron Linux basic_text fallback', () => {
    const store = new SecureStore({ safeStorage: fakeSafeStorage(true, 'basic_text'), filePath: '/unused' });
    assert.equal(store.isAvailable(), false);
});
