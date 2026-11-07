'use strict';

function normalizePort(value) {
    const port = Number.parseInt(value, 10);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 22;
}

function serverIdentity(config = {}) {
    const host = String(config.host || '').trim().toLowerCase();
    const username = String(config.username || '').trim();
    if (!host || !username) return '';
    return JSON.stringify([host, normalizePort(config.port), username]);
}

function createVerifiedServerTrust(config = {}, verification = {}) {
    const identity = serverIdentity(config);
    const fingerprint = typeof verification.fingerprint === 'string' ? verification.fingerprint.trim() : '';
    if (config.trustServer !== true || verification.accepted !== true || !identity || !fingerprint) return null;
    return { identity, fingerprint };
}

function isTrustedRemoteSession(connectionInfo, backend = connectionInfo?.sshStream) {
    const trust = connectionInfo?.sshExecutionTrust;
    return !!(
        backend &&
        connectionInfo?.sshStream === backend &&
        trust?.identity &&
        trust.identity === connectionInfo.sshServerIdentity &&
        trust.fingerprint &&
        trust.fingerprint === connectionInfo.sshHostFingerprint
    );
}

module.exports = {
    createVerifiedServerTrust,
    isTrustedRemoteSession,
    normalizePort,
    serverIdentity
};
