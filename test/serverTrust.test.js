'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createVerifiedServerTrust,
    isTrustedRemoteSession,
    serverIdentity
} = require('../lib/serverTrust');

test('server trust identity is scoped to normalized host, port, and username', () => {
    assert.equal(
        serverIdentity({ host: ' Example.TEST ', port: '2222', username: 'root' }),
        serverIdentity({ host: 'example.test', port: 2222, username: 'root' })
    );
    assert.notEqual(
        serverIdentity({ host: 'example.test', port: 22, username: 'root' }),
        serverIdentity({ host: 'example.test', port: 22, username: 'deploy' })
    );
});

test('server trust requires an accepted host fingerprint and explicit opt-in', () => {
    const config = { host: 'example.test', port: 22, username: 'root', trustServer: true };
    assert.equal(createVerifiedServerTrust(config, { fingerprint: 'SHA256:test' }), null);
    assert.equal(createVerifiedServerTrust({ ...config, trustServer: false }, { accepted: true, fingerprint: 'SHA256:test' }), null);
    assert.deepEqual(createVerifiedServerTrust(config, { accepted: true, fingerprint: 'SHA256:test' }), {
        identity: serverIdentity(config),
        fingerprint: 'SHA256:test'
    });
});

test('trusted execution only applies to the verified active SSH stream', () => {
    const stream = {};
    const identity = serverIdentity({ host: 'example.test', port: 22, username: 'root' });
    const connectionInfo = {
        sshStream: stream,
        sshServerIdentity: identity,
        sshHostFingerprint: 'SHA256:test',
        sshExecutionTrust: { identity, fingerprint: 'SHA256:test' }
    };
    assert.equal(isTrustedRemoteSession(connectionInfo, stream), true);
    assert.equal(isTrustedRemoteSession(connectionInfo, {}), false);
    connectionInfo.sshHostFingerprint = 'SHA256:changed';
    assert.equal(isTrustedRemoteSession(connectionInfo, stream), false);
});
