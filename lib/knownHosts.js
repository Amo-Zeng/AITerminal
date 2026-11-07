'use strict';

const crypto = require('crypto');

function hostToken(host, port = 22) {
    const normalizedHost = String(host || '').trim();
    const normalizedPort = Number.parseInt(port, 10) || 22;
    if (normalizedPort === 22) return normalizedHost;
    return `[${normalizedHost}]:${normalizedPort}`;
}

function parsePublicKeyBlob(key) {
    const buffer = Buffer.isBuffer(key) ? key : Buffer.from(key || '');
    if (buffer.length < 4) return { type: 'unknown', blob: buffer };
    const length = buffer.readUInt32BE(0);
    if (length <= 0 || length > buffer.length - 4) return { type: 'unknown', blob: buffer };
    return { type: buffer.subarray(4, 4 + length).toString('ascii'), blob: buffer };
}

function fingerprintForHostKey(key) {
    const blob = Buffer.isBuffer(key) ? key : Buffer.from(key || '');
    const digest = crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
    return `SHA256:${digest}`;
}

function parseKnownHosts(text = '') {
    const records = new Map();
    for (const line of String(text).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const fields = trimmed.split(/\s+/);
        if (fields.length < 3 || fields[0].startsWith('|')) continue;
        const keyType = fields[1];
        const keyBase64 = fields[2];
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(keyBase64)) continue;
        for (const host of fields[0].split(',')) {
            if (!host || host.startsWith('!')) continue;
            records.set(host, {
                host,
                keyType,
                keyBase64,
                fingerprint: fingerprintForHostKey(Buffer.from(keyBase64, 'base64'))
            });
        }
    }
    return records;
}

function serializeKnownHosts(records) {
    const lines = ['# AITerminal managed known_hosts'];
    for (const record of records.values()) {
        if (!record?.host || !record.keyType || !record.keyBase64) continue;
        lines.push(`${record.host} ${record.keyType} ${record.keyBase64}`);
    }
    return `${lines.join('\n')}\n`;
}

function inspectHostKey(records, host, port, key) {
    const token = hostToken(host, port);
    const parsed = parsePublicKeyBlob(key);
    const fingerprint = fingerprintForHostKey(key);
    const previous = records.get(token);
    if (!previous) {
        return { status: 'unknown', host: token, fingerprint, keyType: parsed.type };
    }
    if (previous.fingerprint === fingerprint) {
        return { status: 'trusted', host: token, fingerprint, keyType: parsed.type };
    }
    return {
        status: 'changed',
        host: token,
        fingerprint,
        previousFingerprint: previous.fingerprint,
        keyType: parsed.type
    };
}

function rememberHostKey(records, host, port, key) {
    const buffer = Buffer.isBuffer(key) ? key : Buffer.from(key || '');
    const parsed = parsePublicKeyBlob(buffer);
    const record = {
        host: hostToken(host, port),
        keyType: parsed.type,
        keyBase64: buffer.toString('base64'),
        fingerprint: fingerprintForHostKey(buffer)
    };
    records.set(record.host, record);
    return record;
}

module.exports = {
    fingerprintForHostKey,
    hostToken,
    inspectHostKey,
    parseKnownHosts,
    parsePublicKeyBlob,
    rememberHostKey,
    serializeKnownHosts
};
