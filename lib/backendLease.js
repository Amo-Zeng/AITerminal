'use strict';

function ownsBackendLease(owner, slot, lease) {
    return !!owner && !!slot && !!lease && lease.active === true && owner[slot] === lease;
}

function cancelBackendLease(owner, slot, reason = 'cancelled') {
    const lease = owner?.[slot];
    if (!lease || typeof lease.cancel !== 'function') return false;
    return lease.cancel(reason);
}

function beginBackendLease(owner, slot, backend, onCancel) {
    if (!owner || typeof owner !== 'object') throw new TypeError('owner must be an object');
    if (typeof slot !== 'string' || !slot) throw new TypeError('slot must be a non-empty string');
    cancelBackendLease(owner, slot, 'superseded');

    let active = true;
    const lease = {
        backend,
        get active() {
            return active;
        },
        release() {
            if (!active || owner[slot] !== lease) return false;
            active = false;
            owner[slot] = null;
            return true;
        },
        cancel(reason = 'cancelled') {
            if (!active) return false;
            active = false;
            if (owner[slot] === lease) owner[slot] = null;
            if (typeof onCancel === 'function') onCancel(reason, backend);
            return true;
        }
    };
    owner[slot] = lease;
    return lease;
}

function releaseBackendLease(owner, slot, lease) {
    if (!ownsBackendLease(owner, slot, lease) || typeof lease.release !== 'function') return false;
    return lease.release();
}

module.exports = {
    beginBackendLease,
    cancelBackendLease,
    ownsBackendLease,
    releaseBackendLease
};
