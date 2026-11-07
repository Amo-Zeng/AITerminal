'use strict';

const fs = require('fs');
const path = require('path');

const MAX_SECRET_BYTES = 256 * 1024;

class SecureStore {
    constructor({ safeStorage, filePath, fsImpl = fs }) {
        this.safeStorage = safeStorage;
        this.filePath = filePath;
        this.fs = fsImpl;
    }

    isAvailable() {
        try {
            if (!this.safeStorage?.isEncryptionAvailable?.()) return false;
            const backend = this.safeStorage?.getSelectedStorageBackend?.();
            return backend !== 'basic_text';
        } catch {
            return false;
        }
    }

    readEnvelope() {
        try {
            const raw = this.fs.readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            return parsed && parsed.version === 1 && parsed.values && typeof parsed.values === 'object'
                ? parsed
                : { version: 1, values: {} };
        } catch {
            return { version: 1, values: {} };
        }
    }

    writeEnvelope(envelope) {
        const directory = path.dirname(this.filePath);
        this.fs.mkdirSync(directory, { recursive: true });
        const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
        this.fs.writeFileSync(temporaryPath, JSON.stringify(envelope), { mode: 0o600 });
        try { this.fs.chmodSync(temporaryPath, 0o600); } catch {}
        this.fs.renameSync(temporaryPath, this.filePath);
        try { this.fs.chmodSync(this.filePath, 0o600); } catch {}
    }

    save(key, value) {
        if (!this.isAvailable()) return { success: false, error: 'secure-storage-unavailable' };
        if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(key)) {
            return { success: false, error: 'invalid-secret-key' };
        }
        const serialized = JSON.stringify(value && typeof value === 'object' ? value : {});
        if (Buffer.byteLength(serialized, 'utf8') > MAX_SECRET_BYTES) {
            return { success: false, error: 'secret-value-too-large' };
        }
        const envelope = this.readEnvelope();
        envelope.values[key] = this.safeStorage.encryptString(serialized).toString('base64');
        this.writeEnvelope(envelope);
        return { success: true };
    }

    load(key) {
        if (!this.isAvailable()) return { success: false, error: 'secure-storage-unavailable' };
        if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(key)) {
            return { success: false, error: 'invalid-secret-key' };
        }
        const encoded = this.readEnvelope().values[key];
        if (!encoded) return { success: true, value: null };
        try {
            const serialized = this.safeStorage.decryptString(Buffer.from(encoded, 'base64'));
            const value = JSON.parse(serialized);
            return { success: true, value: value && typeof value === 'object' ? value : {} };
        } catch {
            return { success: false, error: 'secure-storage-read-failed' };
        }
    }

    delete(key) {
        if (!this.isAvailable()) return { success: false, error: 'secure-storage-unavailable' };
        const envelope = this.readEnvelope();
        delete envelope.values[key];
        this.writeEnvelope(envelope);
        return { success: true };
    }
}

module.exports = { MAX_SECRET_BYTES, SecureStore };
