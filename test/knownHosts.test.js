'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    hostToken,
    inspectHostKey,
    parseKnownHosts,
    rememberHostKey,
    serializeKnownHosts
} = require('../lib/knownHosts');

function sshKey(type, payload) {
    const typeBuffer = Buffer.from(type);
    const body = Buffer.from(payload);
    const key = Buffer.alloc(4 + typeBuffer.length + body.length);
    key.writeUInt32BE(typeBuffer.length, 0);
    typeBuffer.copy(key, 4);
    body.copy(key, 4 + typeBuffer.length);
    return key;
}

test('known_hosts tokens match OpenSSH host and non-default port syntax', () => {
    assert.equal(hostToken('example.test', 22), 'example.test');
    assert.equal(hostToken('example.test', 2222), '[example.test]:2222');
});

test('unknown keys become trusted only after they are remembered', () => {
    const records = new Map();
    const key = sshKey('ssh-ed25519', 'key-one');
    assert.equal(inspectHostKey(records, 'example.test', 22, key).status, 'unknown');
    rememberHostKey(records, 'example.test', 22, key);
    assert.equal(inspectHostKey(records, 'example.test', 22, key).status, 'trusted');
});

test('changed host keys are detected and serialization is OpenSSH compatible', () => {
    const records = new Map();
    rememberHostKey(records, 'example.test', 22, sshKey('ssh-ed25519', 'key-one'));
    const changed = inspectHostKey(records, 'example.test', 22, sshKey('ssh-ed25519', 'key-two'));
    assert.equal(changed.status, 'changed');
    assert.notEqual(changed.fingerprint, changed.previousFingerprint);
    const parsed = parseKnownHosts(serializeKnownHosts(records));
    assert.equal(parsed.get('example.test').fingerprint, records.get('example.test').fingerprint);
});

test('hashed and malformed known_hosts entries are ignored without trusting them', () => {
    const records = parseKnownHosts('|1|salt|hash ssh-ed25519 AAAA\ninvalid');
    assert.equal(records.size, 0);
});
