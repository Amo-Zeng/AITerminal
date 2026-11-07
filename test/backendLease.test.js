'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    beginBackendLease,
    cancelBackendLease,
    ownsBackendLease,
    releaseBackendLease
} = require('../lib/backendLease');

test('a new backend lease synchronously cancels the superseded attempt', () => {
    const owner = { pending: null };
    const cancelled = [];
    const first = beginBackendLease(owner, 'pending', { id: 1 }, (reason) => cancelled.push(reason));
    const second = beginBackendLease(owner, 'pending', { id: 2 });

    assert.deepEqual(cancelled, ['superseded']);
    assert.equal(first.active, false);
    assert.equal(ownsBackendLease(owner, 'pending', first), false);
    assert.equal(ownsBackendLease(owner, 'pending', second), true);
});

test('a late release from an old attempt cannot clear the current lease', () => {
    const owner = { pending: null };
    const first = beginBackendLease(owner, 'pending', { id: 1 });
    const second = beginBackendLease(owner, 'pending', { id: 2 });

    assert.equal(releaseBackendLease(owner, 'pending', first), false);
    assert.equal(owner.pending, second);
    assert.equal(releaseBackendLease(owner, 'pending', second), true);
    assert.equal(owner.pending, null);
    assert.equal(second.active, false);
    assert.equal(second.cancel('late cancellation'), false);
});

test('cancelling a lease is idempotent and revokes ownership before cleanup', () => {
    const owner = { pending: null };
    let ownerValueDuringCleanup = 'not-called';
    const lease = beginBackendLease(owner, 'pending', { id: 1 }, () => {
        ownerValueDuringCleanup = owner.pending;
    });

    assert.equal(cancelBackendLease(owner, 'pending', 'closed'), true);
    assert.equal(ownerValueDuringCleanup, null);
    assert.equal(lease.cancel('again'), false);
    assert.equal(owner.pending, null);
});
