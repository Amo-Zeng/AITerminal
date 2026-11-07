'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    DEFAULT_REPO,
    PLATFORM_NAMES,
    WORKFLOW_FILE,
    buildDefaultBranch,
    formatRepositoryAccessError,
    parseArgs,
    parseRepository,
    redact,
    validateBuildBranch
} = require('../scripts/publishGitHubBuild');

test('normalizes supported GitHub repository forms without embedding credentials', () => {
    assert.equal(parseRepository('Amo-Zeng/AITerminal-build'), DEFAULT_REPO);
    assert.equal(parseRepository('https://github.com/Amo-Zeng/AITerminal-build.git'), DEFAULT_REPO);
    assert.equal(parseRepository('git@github.com:Amo-Zeng/AITerminal-build.git'), DEFAULT_REPO);
    assert.equal(parseRepository('ssh://git@github.com/Amo-Zeng/AITerminal-build.git'), DEFAULT_REPO);
    assert.throws(() => parseRepository('https://example.test/repo'), /invalid GitHub repository/);
    assert.throws(() => parseRepository('owner/repo/extra'), /invalid GitHub repository/);
});

test('generated branches trigger the existing workflow and remain unique', () => {
    const branch = buildDefaultBranch('1.3.0', new Date('2026-08-21T02:03:04.000Z'));
    assert.equal(branch, 'release/aiterminal-1.3.0-20260821020304');
    assert.doesNotThrow(() => validateBuildBranch(branch));
    assert.throws(() => validateBuildBranch('feature/not-built'), /main or release/);
    assert.throws(() => validateBuildBranch('release/../main'), /unsafe/);
});

test('CLI parser keeps waiting and artifact extraction enabled by default', () => {
    const defaults = parseArgs([]);
    assert.equal(defaults.repo, DEFAULT_REPO);
    assert.equal(defaults.wait, true);
    assert.equal(defaults.download, true);
    assert.equal(defaults.extract, true);

    const pushOnly = parseArgs(['--repo', 'owner/repo', '--branch', 'release/test', '--no-wait', '--skip-checks']);
    assert.equal(pushOnly.repo, 'owner/repo');
    assert.equal(pushOnly.branch, 'release/test');
    assert.equal(pushOnly.wait, false);
    assert.equal(pushOnly.download, false);
    assert.equal(pushOnly.checks, false);
});

test('release workflow contract covers all three platform artifacts', () => {
    assert.equal(WORKFLOW_FILE, '.github/workflows/windows-build.yml');
    assert.deepEqual(PLATFORM_NAMES, ['windows-x64', 'linux-x64', 'macos']);
});

test('token redaction never emits the supplied secret', () => {
    const token = 'github-secret-for-test';
    const output = redact(`request failed: ${token}`, token);
    assert.equal(output, 'request failed: [REDACTED]');
    assert.equal(output.includes(token), false);
});

test('repository access errors explain GitHub private-repository 404 behavior', () => {
    const message = formatRepositoryAccessError(
        'Amo-Zeng/AITerminal-build',
        { status: 404 },
        'Amo-Zeng',
        [{ full_name: 'Amo-Zeng/AITerminal', private: false }]
    );
    assert.match(message, /cannot access Amo-Zeng\/AITerminal-build/);
    assert.match(message, /private repositories without access as 404/);
    assert.match(message, /Amo-Zeng\/AITerminal/);
});

test('repository access errors distinguish invalid and insufficient tokens', () => {
    assert.match(formatRepositoryAccessError('owner/repo', { status: 401 }), /401/);
    assert.match(formatRepositoryAccessError('owner/repo', { status: 403 }), /Contents read\/write/);
});
