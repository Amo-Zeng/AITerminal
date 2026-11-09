'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PLATFORMS = ['windows-x64', 'linux-x64', 'macos'];
const MARKER = /<!-- aiterminal-release (\{[^\n]+\}) -->/;
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function releaseIdentity({ repository, sha, version, runId, runNumber, ref }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha) || !/^\d+\.\d+\.\d+$/.test(version) || !/^\d+$/.test(String(runId)) || !/^\d+$/.test(String(runNumber))) throw new Error('Invalid release identity');
    const tag = `v${version}`;
    if (ref?.startsWith('refs/tags/') && ref !== `refs/tags/${tag}`) throw new Error('Release tag must match package.json version');
    return { repository, sha, version, runId: String(runId), runNumber: String(runNumber), ref, tag };
}
function regularFile(file) { if (!fs.lstatSync(file).isFile()) throw new Error(`Expected a regular file: ${path.basename(file)}`); }
function collectArtifacts(input, output, identity) {
    const { sha, version, runId, repository } = identity;
    if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error('Release staging directory must be empty');
    const collected = [];
    const installers = { 'windows-x64': `AITerminal-${version}-x64-Setup.exe`, 'linux-x64': `AITerminal-${version}.AppImage`, macos: `AITerminal-${version}-arm64.dmg` };
    // Validate all platforms before writing staging files or making API changes.
    for (const platform of PLATFORMS) {
        const directory = path.join(input, `AITerminal-${platform}-${sha}`);
        const name = installers[platform];
        const entries = fs.readdirSync(directory).sort();
        if (JSON.stringify(entries) !== JSON.stringify([name, 'SHA256SUMS.txt', 'sbom.cdx.json'].sort())) throw new Error(`Unexpected or missing ${platform} release files`);
        for (const entry of entries) regularFile(path.join(directory, entry));
        const installer = path.join(directory, name), digest = hash(installer);
        const sums = fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8').trim().split(/\r?\n/);
        if (sums.length !== 1 || sums[0] !== `${digest}  ${name}`) throw new Error(`Checksum mismatch: ${platform}`);
        if (!fs.statSync(installer).size) throw new Error(`Empty installer: ${platform}`);
        const sbom = JSON.parse(fs.readFileSync(path.join(directory, 'sbom.cdx.json'), 'utf8'));
        if (sbom.bomFormat !== 'CycloneDX' || sbom.metadata?.component?.name !== 'aiterminal' || sbom.metadata.component.version !== version) throw new Error(`SBOM version mismatch: ${platform}`);
        collected.push({ source: installer, name, digest }, { source: path.join(directory, 'sbom.cdx.json'), name: `sbom-${platform}.cdx.json` });
    }
    fs.mkdirSync(output, { recursive: true });
    for (const file of collected) fs.copyFileSync(file.source, path.join(output, file.name));
    const provenance = { repository, sourceCommit: sha, version, workflowRun: `https://github.com/${repository}/actions/runs/${runId}`, runId, runNumber: identity.runNumber,
        installers: collected.filter(file => file.digest).map(({ name, digest }) => ({ name, sha256: digest })) };
    fs.writeFileSync(path.join(output, 'release-provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
    const names = fs.readdirSync(output).sort();
    fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), names.map(name => `${hash(path.join(output, name))}  ${name}`).join('\n') + '\n');
    return [...names, 'SHA256SUMS.txt'].sort().map(name => ({ name, file: path.join(output, name), size: fs.statSync(path.join(output, name)).size, digest: 'sha256:' + hash(path.join(output, name)) }));
}
function metadata(release) {
    try { return JSON.parse(MARKER.exec(release?.body || '')?.[1] || 'null'); } catch { return null; }
}
function releaseNotes(identity, changelog) {
    const section = changelog.split(`## ${identity.version} - `)[1]?.split('\n').slice(1).join('\n').split('\n## ')[0].trim();
    return `三平台安装包 / Desktop installers\n\n${section || 'Includes the changes in the source commit linked below.'}\n\n` +
        '- Windows x64：下载 Setup.exe；本地终端与 AI 使用 WSL Ubuntu，请先完成 Ubuntu 初始化。\n' +
        '- Linux x64：下载 AppImage，并添加执行权限。\n' +
        '- macOS arm64：下载 DMG；此包未签名、未公证，请核验来源。\n\n' +
        '请使用 SHA256SUMS.txt 核验附件；各平台 SBOM 和源码对应关系随包提供。\n\n' +
        'macOS：将校验无误的应用拖入 Applications；若提示“已损坏”或无法验证开发者，可在系统终端执行：\n\n' +
        '```bash\nsudo xattr -r -d com.apple.quarantine /Applications/AITerminal.app\n```\n\n' +
        `安装与排障 / Installation: https://github.com/${identity.repository}/blob/${identity.sha}/INSTALLATION.md\n\n` +
        `Source: https://github.com/${identity.repository}/commit/${identity.sha}\n` +
        `Build: https://github.com/${identity.repository}/actions/runs/${identity.runId}\n\n` +
        `<!-- aiterminal-release ${JSON.stringify({ sha: identity.sha, runId: identity.runId, runNumber: identity.runNumber, version: identity.version })} -->`;
}

function githubClient(token) {
    if (!token) throw new Error('GITHUB_TOKEN is required');
    return async (method, route, body, binary = false) => {
        const url = route.startsWith('https://') ? new URL(route) : new URL(route, 'https://api.github.com');
        if (!['api.github.com', 'uploads.github.com'].includes(url.hostname) || url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid GitHub API destination');
        const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(binary ? 300000 : 30000),
            headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'AITerminal-release',
                ...(body === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }) },
            body: body === undefined ? undefined : binary ? body : JSON.stringify(body) });
        if (response.status === 404 && method === 'GET') return null;
        if (!response.ok) throw new Error(`GitHub ${method} failed: HTTP ${response.status}`);
        return response.status === 204 ? null : response.json();
    };
}
async function tagCommit(api, root, tag) {
    let object = (await api('GET', `${root}/git/ref/tags/${encodeURIComponent(tag)}`))?.object;
    for (let i = 0; object?.type === 'tag' && i < 4; i++) object = (await api('GET', `${root}/git/tags/${object.sha}`))?.object;
    if (object && object.type !== 'commit') throw new Error('Cannot resolve release tag');
    return object?.sha || null;
}
function assertAssets(actual, expected) {
    if (actual.length !== expected.length) throw new Error('Release asset count mismatch');
    for (const file of expected) {
        const asset = actual.find(item => item.name === file.name);
        if (!asset || asset.state !== 'uploaded' || asset.size !== file.size || asset.digest !== file.digest) throw new Error(`Release asset verification failed: ${file.name}`);
    }
}
async function publishRelease({ identity, assets, changelog, api }) {
    const root = `/repos/${identity.repository}`;
    const run = await api('GET', `${root}/actions/runs/${identity.runId}`);
    if (!run || run.head_sha !== identity.sha || String(run.run_number) !== identity.runNumber || !['push', 'workflow_dispatch'].includes(run.event) || run.path !== '.github/workflows/windows-build.yml') throw new Error('Release source does not match a trusted build');
    const jobs = (await api('GET', `${root}/actions/runs/${identity.runId}/jobs?per_page=100`))?.jobs || [];
    for (const platform of PLATFORMS) {
        const job = jobs.find(job => job.name === `Build ${platform}`);
        if (job?.conclusion !== 'success') throw new Error(`Build not successful: ${platform}`);
    }
    let tag = identity.tag;
    let release = await api('GET', `${root}/releases/tags/${tag}`);
    let commit = await tagCommit(api, root, tag);
    if ((commit && commit !== identity.sha) || (release && metadata(release)?.runId !== identity.runId)) {
        if (identity.ref?.startsWith('refs/tags/')) throw new Error('This version tag already belongs to a different release');
        // Every completed ordinary build can be downloaded without rewriting an
        // existing version tag or replacing files that users already verified.
        tag = `${identity.tag}-build.${identity.runNumber}`;
        release = await api('GET', `${root}/releases/tags/${tag}`);
        commit = await tagCommit(api, root, tag);
    }
    if (commit && commit !== identity.sha) throw new Error('Release tag points to different source');
    if (release && (metadata(release)?.sha !== identity.sha || metadata(release)?.runId !== identity.runId)) throw new Error('Release identity conflict');
    if (release && !release.draft) {
        assertAssets(await api('GET', `${root}/releases/${release.id}/assets?per_page=100`), assets);
        return { url: release.html_url, tag, alreadyPublished: true };
    }
    const body = releaseNotes(identity, changelog);
    if (!release) release = await api('POST', `${root}/releases`, { tag_name: tag, target_commitish: identity.sha, name: `AITerminal ${tag.slice(1)}`, body, draft: true, prerelease: false });
    const currentAssets = await api('GET', `${root}/releases/${release.id}/assets?per_page=100`);
    for (const asset of currentAssets) {
        const expected = assets.find(file => file.name === asset.name);
        if (!expected || asset.digest !== expected.digest || asset.size !== expected.size || asset.state !== 'uploaded') {
            // Only our unpublished draft is repaired. Published assets are immutable.
            await api('DELETE', `${root}/releases/assets/${asset.id}`);
        }
    }
    for (const file of assets) {
        if (currentAssets.some(asset => asset.name === file.name && asset.digest === file.digest && asset.size === file.size && asset.state === 'uploaded')) continue;
        const url = new URL(release.upload_url.replace(/\{.*$/, '')); url.searchParams.set('name', file.name);
        await api('POST', url.href, fs.readFileSync(file.file), true);
    }
    assertAssets(await api('GET', `${root}/releases/${release.id}/assets?per_page=100`), assets);
    const latest = await api('GET', `${root}/releases/latest`);
    let makeLatest = true;
    if (latest && latest.id !== release.id) {
        const previous = metadata(latest)?.sha || await tagCommit(api, root, latest.tag_name);
        if (!previous) throw new Error('Cannot determine latest release source');
        if (previous !== identity.sha) {
            const comparison = await api('GET', `${root}/compare/${previous}...${identity.sha}`);
            makeLatest = comparison?.status === 'ahead';
        } else if (Number(metadata(latest)?.runNumber || 0) > Number(identity.runNumber)) makeLatest = false;
    }
    const published = await api('PATCH', `${root}/releases/${release.id}`, { body, draft: false, prerelease: false, make_latest: String(makeLatest) });
    if (await tagCommit(api, root, tag) !== identity.sha) throw new Error('Published tag source mismatch');
    if (makeLatest && (await api('GET', `${root}/releases/latest`))?.id !== published.id) throw new Error('Download page did not advance to the verified release');
    return { url: published.html_url, tag, latest: makeLatest };
}

async function main() {
    const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
    const identity = releaseIdentity({ repository: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runNumber: process.env.GITHUB_RUN_NUMBER, ref: process.env.GITHUB_REF, version });
    const assets = collectArtifacts(path.resolve(process.argv[2] || 'release/downloads'), path.resolve(process.argv[3] || 'release/publish'), identity);
    const result = await publishRelease({ identity, assets, changelog: fs.readFileSync('CHANGELOG.md', 'utf8'), api: githubClient(process.env.GITHUB_TOKEN) });
    console.log(`Release verified: ${result.url}`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Published and verified: [${result.tag}](${result.url})\n`);
}
module.exports = { releaseIdentity, collectArtifacts, publishRelease, metadata, assertAssets, releaseNotes };
if (require.main === module) main().catch(error => { console.error(`Release failed: ${error.message}`); process.exitCode = 1; });
