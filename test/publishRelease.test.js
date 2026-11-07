'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { releaseIdentity, collectArtifacts, publishRelease, releaseNotes } = require('../scripts/publishRelease');
const sha = 'a'.repeat(40), previousSha = 'b'.repeat(40);
const platforms = ['windows-x64', 'linux-x64', 'macos'];
const identity = () => releaseIdentity({ repository: 'example/terminal', sha, version: '1.6.0', runId: '300', runNumber: '9', ref: 'refs/heads/main' });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function files(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-release-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const names = ['AITerminal-1.6.0-x64-Setup.exe', 'AITerminal-1.6.0.AppImage', 'AITerminal-1.6.0-arm64.dmg'];
    for (const [i, platform] of platforms.entries()) {
        const directory = path.join(root, 'input', `AITerminal-${platform}-${sha}`); fs.mkdirSync(directory, { recursive: true });
        const data = `fixture installer ${platform}`;
        fs.writeFileSync(path.join(directory, names[i]), data);
        fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), `${digest(data)}  ${names[i]}\n`);
        fs.writeFileSync(path.join(directory, 'sbom.cdx.json'), JSON.stringify({ bomFormat: 'CycloneDX', metadata: { component: { name: 'aiterminal', version: '1.6.0' } } }));
    }
    return { root, input: path.join(root, 'input'), output: path.join(root, 'output') };
}
function github({ failedPlatform, oldRelease = false, comparison = 'ahead', failUpload = false } = {}) {
    const calls = [], assets = [], tags = new Map(), releases = new Map(); let latest = null, nextId = 10;
    if (oldRelease) {
        latest = { id: 1, tag_name: 'v1.6.0', target_commitish: previousSha, draft: false, body: '', html_url: 'old-release' };
        releases.set('v1.6.0', latest); tags.set('v1.6.0', previousSha);
    }
    const api = async (method, route, body, binary) => {
        calls.push({ method, route, body: binary ? undefined : body });
        const endpoint = route.replace('/repos/example/terminal', '');
        if (endpoint === '/actions/runs/300') return { head_sha: sha, run_number: 9, event: 'push', path: '.github/workflows/windows-build.yml' };
        if (endpoint === '/actions/runs/300/jobs?per_page=100') return { jobs: platforms.map(p => ({ name: `Build ${p}`, conclusion: p === failedPlatform ? 'failure' : 'success' })) };
        if (endpoint === '/releases/latest') return latest;
        if (endpoint.startsWith('/compare/')) return { status: comparison };
        if (endpoint.startsWith('/git/ref/tags/')) { const target = tags.get(decodeURIComponent(endpoint.slice('/git/ref/tags/'.length))); return target ? { object: { type: 'commit', sha: target } } : null; }
        if (endpoint.startsWith('/releases/tags/')) return releases.get(endpoint.slice('/releases/tags/'.length)) || null;
        if (method === 'POST' && endpoint === '/releases') {
            const result = { ...body, id: nextId++, upload_url: 'https://uploads.github.com/repos/example/terminal/releases/10/assets{?name,label}', html_url: 'https://github.com/example/terminal/releases/tag/' + body.tag_name };
            releases.set(body.tag_name, result); return result;
        }
        if (method === 'GET' && /^\/releases\/\d+\/assets\?per_page=100$/.test(endpoint)) return [...assets];
        if (binary) {
            if (failUpload) { failUpload = false; throw new Error('simulated upload failure'); }
            const name = new URL(route).searchParams.get('name');
            const asset = { id: nextId++, name, state: 'uploaded', size: body.length, digest: 'sha256:' + digest(body) }; assets.push(asset); return asset;
        }
        if (method === 'DELETE') { assets.splice(assets.findIndex(a => endpoint.endsWith('/' + a.id)), 1); return null; }
        if (method === 'PATCH') {
            const release = [...releases.values()].find(r => endpoint === '/releases/' + r.id); assert.ok(release);
            Object.assign(release, body); tags.set(release.tag_name, sha); if (body.make_latest === 'true') latest = release; return release;
        }
        throw new Error(`Unexpected fixture request ${method} ${route}`);
    };
    return { api, calls, assets, tags, releases, latest: () => latest };
}
test('release staging requires all three matching installers, checksums and SBOMs', t => {
    const f = files(t); const assets = collectArtifacts(f.input, f.output, identity());
    assert.equal(assets.length, 8);
    const sums = fs.readFileSync(path.join(f.output, 'SHA256SUMS.txt'), 'utf8');
    for (const asset of assets.filter(a => a.name !== 'SHA256SUMS.txt')) assert.ok(sums.includes(`${asset.digest.slice(7)}  ${asset.name}\n`));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.output, 'release-provenance.json'))).sourceCommit, sha);
    assert.throws(() => collectArtifacts(f.input, f.output, identity()), /empty/);
    const bad = files(t); fs.writeFileSync(path.join(bad.input, `AITerminal-linux-x64-${sha}`, 'AITerminal-1.6.0.AppImage'), 'corrupt');
    assert.throws(() => collectArtifacts(bad.input, bad.output, identity()), /Checksum mismatch/); assert.equal(fs.existsSync(bad.output), false);
    const missing = files(t); fs.unlinkSync(path.join(missing.input, `AITerminal-macos-${sha}`, 'sbom.cdx.json'));
    assert.throws(() => collectArtifacts(missing.input, missing.output, identity()), /missing/);
});
test('failed platform cannot create a release or upload assets', async t => {
    const f = files(t), mock = github({ failedPlatform: 'windows-x64' });
    await assert.rejects(publishRelease({ identity: identity(), assets: collectArtifacts(f.input, f.output, identity()), changelog: '', api: mock.api }), /Build not successful/);
    assert.equal(mock.calls.some(c => c.method !== 'GET'), false);
});
test('publication stages and verifies all assets before advancing latest, and reruns are idempotent', async t => {
    const f = files(t), mock = github(), id = identity(), assets = collectArtifacts(f.input, f.output, id);
    const result = await publishRelease({ identity: id, assets, changelog: '## 1.6.0 - 2026-11-07\n\n- Current update\n\n## 1.5.1 - old\nold notes', api: mock.api });
    assert.equal(result.tag, 'v1.6.0'); assert.equal(mock.latest().draft, false); assert.equal(mock.assets.length, 8);
    const create = mock.calls.find(c => c.method === 'POST' && c.route.endsWith('/releases')); assert.equal(create.body.draft, true);
    const publishIndex = mock.calls.findIndex(c => c.method === 'PATCH');
    assert.equal(mock.calls.slice(0, publishIndex).filter(c => c.route.startsWith('https://uploads.')).length, 8);
    assert.match(mock.latest().body, /Current update/); assert.doesNotMatch(mock.latest().body, /old notes/);
    const mutations = mock.calls.filter(c => c.method !== 'GET').length;
    assert.equal((await publishRelease({ identity: id, assets, changelog: '', api: mock.api })).alreadyPublished, true);
    assert.equal(mock.calls.filter(c => c.method !== 'GET').length, mutations);
    mock.assets[0].digest = 'sha256:wrong';
    await assert.rejects(publishRelease({ identity: id, assets, changelog: '', api: mock.api }), /verification failed/);
    assert.equal(mock.calls.filter(c => c.method === 'DELETE').length, 0, 'published assets are never replaced');
});
test('interrupted uploads leave the public release unchanged and can resume the draft', async t => {
    const f = files(t), mock = github({ oldRelease: true, failUpload: true }), id = identity(), assets = collectArtifacts(f.input, f.output, id);
    await assert.rejects(publishRelease({ identity: id, assets, changelog: '', api: mock.api }), /upload failure/);
    assert.equal(mock.latest().id, 1); assert.equal(mock.releases.get('v1.6.0-build.9').draft, true);
    const result = await publishRelease({ identity: id, assets, changelog: '', api: mock.api });
    assert.equal(result.tag, 'v1.6.0-build.9'); assert.equal(mock.tags.get('v1.6.0'), previousSha); assert.equal(mock.latest().tag_name, result.tag);
});
test('an older source build is downloadable without replacing the newest download', async t => {
    const f = files(t), mock = github({ oldRelease: true, comparison: 'behind' }), id = identity();
    const result = await publishRelease({ identity: id, assets: collectArtifacts(f.input, f.output, id), changelog: '', api: mock.api });
    assert.equal(result.latest, false); assert.equal(mock.latest().id, 1);
});
test('tag and version must agree and credentials never appear in release notes', () => {
    assert.throws(() => releaseIdentity({ ...identity(), ref: 'refs/tags/v9.0.0' }), /match/);
    assert.match(releaseNotes(identity(), ''), /Source: https:\/\/github.com\/example\/terminal\/commit\/a{40}/);
});
