'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const ROOT = path.join(__dirname, '..');
const WORKFLOW_FILE = '.github/workflows/windows-build.yml';
const DEFAULT_REPO = 'Amo-Zeng/AITerminal-build';
const DEFAULT_TIMEOUT_MINUTES = 45;
const PLATFORM_NAMES = ['windows-x64', 'linux-x64', 'macos'];

function usage() {
    return `Usage: npm run publish:github-build -- [options]

Push the current source to a new release/* branch and wait for the existing
Windows/Linux/macOS GitHub Actions matrix to build and download its artifacts.

Options:
  --repo OWNER/REPO       GitHub build repository (default: ${DEFAULT_REPO})
  --branch NAME           Explicit branch; must be main or release/*
  --timeout MINUTES       Workflow wait timeout (default: ${DEFAULT_TIMEOUT_MINUTES})
  --no-wait               Push only; do not query Actions or download artifacts
  --no-download            Wait for Actions but do not download artifacts
  --no-extract             Keep downloaded artifact ZIP files without extraction
  --skip-checks            Skip npm test, secret scan, and npm audit (not recommended)
  --dry-run               Print the plan without changing Git or GitHub
  --help                  Show this help

Authentication:
  Set GITHUB_TOKEN, GH_TOKEN, or AITERMINAL_GITHUB_TOKEN. The token is read
  from the environment only; it is never placed in a Git URL, command line,
  repository file, or log. A fine-grained token needs Contents: Read/Write and
  Actions: Read on the private build repository.
  If the local proxy breaks GitHub requests, the script retries directly;
  set AITERMINAL_GITHUB_DIRECT=1 to force direct GitHub/API/artifact traffic.
`;
}

function parseArgs(argv) {
    const options = {
        repo: process.env.AITERMINAL_BUILD_REPO || DEFAULT_REPO,
        branch: '',
        timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
        wait: true,
        download: true,
        extract: true,
        checks: true,
        dryRun: false,
        help: false
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value = () => {
            if (index + 1 >= argv.length) throw new Error(`${arg} requires a value`);
            index += 1;
            return argv[index];
        };
        switch (arg) {
            case '--repo':
                options.repo = value();
                break;
            case '--branch':
                options.branch = value();
                break;
            case '--timeout': {
                const parsed = Number(value());
                if (!Number.isInteger(parsed) || parsed < 1 || parsed > 240) {
                    throw new Error('--timeout must be an integer from 1 to 240');
                }
                options.timeoutMinutes = parsed;
                break;
            }
            case '--no-wait':
                options.wait = false;
                options.download = false;
                break;
            case '--no-download':
                options.download = false;
                break;
            case '--no-extract':
                options.extract = false;
                break;
            case '--skip-checks':
                options.checks = false;
                break;
            case '--dry-run':
                options.dryRun = true;
                break;
            case '--help':
            case '-h':
                options.help = true;
                break;
            default:
                throw new Error(`unknown option: ${arg}`);
        }
    }
    return options;
}

function parseRepository(value) {
    let input = String(value || '').trim();
    if (/^https?:\/\//i.test(input) && !/^https?:\/\/github\.com\//i.test(input)) {
        throw new Error(`invalid GitHub repository: ${value}`);
    }
    input = input.replace(/^https?:\/\/github\.com\//i, '');
    input = input.replace(/^git@github\.com:/i, '');
    input = input.replace(/^ssh:\/\/git@github\.com\//i, '');
    input = input.replace(/^github\.com\//i, '');
    input = input.replace(/\.git\/?$/, '').replace(/\/$/, '');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input)) {
        throw new Error(`invalid GitHub repository: ${value}`);
    }
    return input;
}

function buildDefaultBranch(version = '0.0.0', now = new Date()) {
    const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const safeVersion = String(version).replace(/[^A-Za-z0-9._-]/g, '-');
    return `release/aiterminal-${safeVersion}-${stamp}`;
}

function validateBuildBranch(branch) {
    if (!/^(?:main|release\/[A-Za-z0-9._/-]+)$/.test(branch)) {
        throw new Error('build branch must be main or release/* so the existing workflow is triggered');
    }
    if (branch.includes('..') || branch.endsWith('/') || branch.includes('//')) {
        throw new Error(`unsafe build branch: ${branch}`);
    }
}

function getToken() {
    const token = process.env.AITERMINAL_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
    return token.trim();
}

function redact(value, secret = getToken()) {
    const text = String(value || '');
    return secret ? text.split(secret).join('[REDACTED]') : text;
}

function commandName(name) {
    return process.platform === 'win32' && name === 'npm' ? 'npm.cmd' : name;
}

function safeEnvironment() {
    const environment = { ...process.env };
    for (const name of ['AITERMINAL_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'AITERMINAL_GIT_TOKEN']) {
        delete environment[name];
    }
    return environment;
}

function withoutProxy(environment) {
    const result = { ...environment };
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) {
        delete result[name];
    }
    return result;
}

function runCommand(command, args, options = {}) {
    const result = spawnSync(commandName(command), args, {
        cwd: options.cwd || ROOT,
        env: options.env || safeEnvironment(),
        encoding: 'utf8',
        stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe']
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
        throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}${details ? `\n${redact(details)}` : ''}`);
    }
    return String(result.stdout || '').trim();
}

function git(args, options = {}) {
    return runCommand('git', args, options);
}

function isGitRepository() {
    try {
        return git(['rev-parse', '--is-inside-work-tree']) === 'true';
    } catch {
        return false;
    }
}

function hasGitHead() {
    try {
        git(['rev-parse', '--verify', 'HEAD']);
        return true;
    } catch {
        return false;
    }
}

function prepareAskPass(token) {
    if (!token) return { path: '', cleanup() {} };
    const suffix = process.platform === 'win32' ? '.cmd' : '.sh';
    const filePath = path.join(os.tmpdir(), `aiterminal-git-askpass-${process.pid}-${Date.now()}${suffix}`);
    const content = process.platform === 'win32'
        ? '@echo off\r\necho(%~1| findstr /I /C:"Username" >NUL && (echo x-access-token) || (echo %AITERMINAL_GIT_TOKEN%)\r\n'
        : '#!/bin/sh\ncase "$1" in\n  *Username*) printf \'%s\\n\' "x-access-token" ;;\n  *) printf \'%s\\n\' "$AITERMINAL_GIT_TOKEN" ;;\nesac\n';
    fs.writeFileSync(filePath, content, { mode: 0o700 });
    try { fs.chmodSync(filePath, 0o700); } catch {}
    return {
        path: filePath,
        cleanup() {
            try { fs.rmSync(filePath, { force: true }); } catch {}
        }
    };
}

function gitEnvironment(token, askPassPath, direct = false) {
    const environment = {
        ...safeEnvironment(),
        GIT_ASKPASS: askPassPath,
        GIT_TERMINAL_PROMPT: '0',
        AITERMINAL_GIT_TOKEN: token
    };
    return direct ? withoutProxy(environment) : environment;
}

function ensureGitIdentity() {
    let name = '';
    let email = '';
    try { name = git(['config', '--local', '--get', 'user.name']); } catch {}
    try { email = git(['config', '--local', '--get', 'user.email']); } catch {}
    if (!name) git(['config', 'user.name', 'AITerminal Release Bot']);
    if (!email) git(['config', 'user.email', 'aiterminal-release@users.noreply.github.com']);
}

function ensureGitBranch(branch, dryRun = false) {
    if (!isGitRepository()) {
        if (dryRun) return 'new repository';
        git(['init', '-b', branch]);
    } else if (!hasGitHead()) {
        if (!dryRun) git(['checkout', '--orphan', branch]);
    } else if (!dryRun) {
        const current = git(['branch', '--show-current']);
        if (current !== branch) {
            const exists = git(['branch', '--list', branch]);
            if (exists) git(['switch', branch]);
            else git(['switch', '--create', branch]);
        }
    }
    return branch;
}

function stageAndCommit(version, dryRun = false) {
    if (dryRun) return { changed: true, commit: 'DRY-RUN' };
    git(['add', '-A']);
    const staged = git(['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
    if (!staged.length && hasGitHead()) {
        return { changed: false, commit: git(['rev-parse', 'HEAD']) };
    }
    ensureGitIdentity();
    const message = `chore(release): sync AITerminal ${version}`;
    git(['commit', '-m', message]);
    return { changed: true, commit: git(['rev-parse', 'HEAD']) };
}

function ensureRemote(repo, token, dryRun = false) {
    const remoteName = 'github-build';
    const expected = `https://github.com/${repo}.git`;
    if (dryRun) return { name: remoteName, url: expected };
    let current = '';
    try { current = git(['remote', 'get-url', remoteName]); } catch {}
    if (current && current.replace(/\.git$/, '') !== expected.replace(/\.git$/, '')) {
        throw new Error(`remote ${remoteName} already points to a different repository; refusing to replace it`);
    }
    if (!current) git(['remote', 'add', remoteName, expected]);
    return { name: remoteName, url: expected };
}

function pushBranch(remoteName, branch, token, dryRun = false) {
    if (dryRun) return;
    const askPass = prepareAskPass(token);
    try {
        // Reset credential helpers for this one command so Git cannot save the
        // token into a user's global credential store after a successful push.
        const args = ['-c', 'credential.helper=', 'push', '--set-upstream', remoteName, branch];
        const direct = process.env.AITERMINAL_GITHUB_DIRECT === '1';
        try {
            git(args, { env: gitEnvironment(token, askPass.path, direct), inherit: true });
        } catch (error) {
            if (direct || !proxyEnvironmentConfigured()) throw error;
            console.log('Git push through the configured proxy failed; retrying directly...');
            git(args, { env: gitEnvironment(token, askPass.path, true), inherit: true });
        }
    } finally {
        askPass.cleanup();
    }
}

function runPreflightChecks() {
    const commands = [
        ['npm', ['test']],
        ['npm', ['run', 'security:scan']],
        ['npm', ['audit', '--audit-level=high']]
    ];
    for (const [command, args] of commands) {
        console.log(`> ${command} ${args.join(' ')}`);
        try {
            runCommand(command, args, { inherit: true });
        } catch (error) {
            if (command !== 'npm' || args[0] !== 'audit' || !proxyEnvironmentConfigured()) throw error;
            console.log('npm audit through the configured proxy failed; retrying directly...');
            runCommand(command, args, { env: withoutProxy(safeEnvironment()), inherit: true });
        }
    }
}

function apiPath(repo, suffix) {
    return `/repos/${repo}${suffix}`;
}

function proxyEnvironmentConfigured() {
    return Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy);
}

function removeHeader(headers, name) {
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
    }
}

function directHttpRequest(url, options = {}, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const client = target.protocol === 'http:' ? http : https;
        const headers = { ...(options.headers || {}) };
        const request = client.request(target, {
            method: options.method || 'GET',
            headers,
            timeout: options.timeoutMs || 30000
        }, (response) => {
            const location = response.headers.location;
            if (location && response.statusCode >= 300 && response.statusCode < 400) {
                if (redirectCount >= 5) {
                    response.resume();
                    reject(new Error('too many GitHub redirects'));
                    return;
                }
                response.resume();
                const redirectedUrl = new URL(location, target).toString();
                const redirectedHeaders = { ...headers };
                if (new URL(redirectedUrl).hostname !== target.hostname) {
                    removeHeader(redirectedHeaders, 'authorization');
                }
                directHttpRequest(redirectedUrl, {
                    ...options,
                    headers: redirectedHeaders
                }, redirectCount + 1).then(resolve, reject);
                return;
            }

            const body = response;
            resolve({
                status: response.statusCode || 0,
                ok: response.statusCode >= 200 && response.statusCode < 300,
                statusText: response.statusMessage || '',
                body,
                async text() {
                    const chunks = [];
                    for await (const chunk of body) chunks.push(Buffer.from(chunk));
                    return Buffer.concat(chunks).toString('utf8');
                }
            });
        });
        request.once('error', reject);
        request.once('timeout', () => request.destroy(new Error('request timed out')));
        if (options.body) request.write(options.body);
        request.end();
    });
}

async function requestGitHubUrl(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    const requestOptions = {
        method: options.method || 'GET',
        headers,
        body: options.body,
        signal: AbortSignal.timeout(options.timeoutMs || 30000)
    };
    const directOnly = process.env.AITERMINAL_GITHUB_DIRECT === '1';
    if (directOnly) return directHttpRequest(url, options);

    let response;
    try {
        response = await fetch(url, requestOptions);
    } catch (error) {
        if (!proxyEnvironmentConfigured()) throw new Error(`fetch failed: ${error.message}`);
        try {
            return await directHttpRequest(url, options);
        } catch (directError) {
            throw new Error(`fetch failed: ${error.message}; direct retry failed: ${directError.message}`);
        }
    }

    // Some local proxies return a misleading 404 when they strip the
    // Authorization header. Retry repository checks directly before reporting
    // that a private repository is inaccessible.
    if (response.status === 404 && proxyEnvironmentConfigured() && options.retryNotFound) {
        try { await response.body?.cancel(); } catch {}
        try {
            return await directHttpRequest(url, options);
        } catch {
            // Keep the original response so the caller can report its status.
        }
    }
    return response;
}

class GitHubApiError extends Error {
    constructor(status, message, endpoint) {
        super(`GitHub API ${status}: ${message}`);
        this.name = 'GitHubApiError';
        this.status = status;
        this.endpoint = endpoint;
    }
}

async function githubApiRequest(endpoint, token, options = {}) {
    if (!token) throw new Error('GitHub API access requires GITHUB_TOKEN, GH_TOKEN, or AITERMINAL_GITHUB_TOKEN');
    let response;
    try {
        response = await requestGitHubUrl(`https://api.github.com${endpoint}`, {
            method: options.method || 'GET',
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${token}`,
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'AITerminal-publish-script'
            },
            body: options.body,
            timeoutMs: options.timeoutMs || 30000,
            retryNotFound: endpoint.startsWith('/repos/')
        });
    } catch (error) {
        throw new Error(`GitHub API request failed for ${endpoint}: ${error.message}`);
    }
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) {
        const message = body?.message || response.statusText || 'GitHub API request failed';
        throw new GitHubApiError(response.status, redact(message), endpoint);
    }
    return body;
}

function githubRequest(repo, token, suffix, options = {}) {
    return githubApiRequest(apiPath(repo, suffix), token, options);
}

function formatRepositoryAccessError(repo, error, login = '', visibleRepos = []) {
    const account = login || 'the authenticated GitHub account';
    if (error?.status === 404) {
        const similar = visibleRepos
            .filter((candidate) => /aiterminal/i.test(candidate.full_name || ''))
            .map((candidate) => candidate.full_name)
            .slice(0, 5);
        const hint = similar.length
            ? ` Visible similarly named repositories: ${similar.join(', ')}.`
            : ' No similarly named repository is visible to this token.';
        return `GitHub cannot access ${repo} for ${account}. GitHub reports private repositories without access as 404; verify the owner/repository name or grant this token access to the private build repository.${hint}`;
    }
    if (error?.status === 401) {
        return `GitHub rejected the configured token while accessing ${repo} (401). Create or provide a valid token with repository access.`;
    }
    if (error?.status === 403) {
        return `GitHub denied access to ${repo} (403). Grant the token repository Contents read/write and Actions read permission, and check organization policy.`;
    }
    return error?.message || `GitHub repository access check failed for ${repo}`;
}

async function ensureRepositoryAccess(repo, token) {
    try {
        return await githubRequest(repo, token, '');
    } catch (error) {
        if (![401, 403, 404].includes(error?.status)) throw error;

        let login = '';
        let visibleRepos = [];
        try {
            const user = await githubApiRequest('/user', token);
            login = user?.login || '';
            const repositories = await githubApiRequest('/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&per_page=100', token);
            if (Array.isArray(repositories)) visibleRepos = repositories;
        } catch {
            // Preserve the original access error if the diagnostic request is
            // blocked by the same token or a transient GitHub failure.
        }
        throw new Error(formatRepositoryAccessError(repo, error, login, visibleRepos));
    }
}

async function findWorkflowRun(repo, token, branch, commit, timeoutMinutes) {
    const deadline = Date.now() + timeoutMinutes * 60 * 1000;
    let workflow;
    try {
        workflow = await githubRequest(repo, token, `/actions/workflows/${encodeURIComponent(WORKFLOW_FILE)}`);
    } catch (error) {
        if (error?.status === 404) {
            throw new Error(`GitHub Actions workflow ${WORKFLOW_FILE} is not available in ${repo}; confirm the pushed branch contains the workflow and Actions are enabled.`);
        }
        throw error;
    }
    while (Date.now() < deadline) {
        const data = await githubRequest(repo, token, `/actions/workflows/${workflow.id}/runs?branch=${encodeURIComponent(branch)}&event=push&per_page=20`);
        const run = (data.workflow_runs || []).find((candidate) => candidate.head_sha === commit);
        if (run) return waitForRun(repo, token, run, deadline);
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    throw new Error(`timed out waiting for workflow run for ${commit}`);
}

async function waitForRun(repo, token, initialRun, deadline) {
    let run = initialRun;
    while (Date.now() < deadline) {
        run = await githubRequest(repo, token, `/actions/runs/${run.id}`);
        if (run.status === 'completed') {
            if (run.conclusion !== 'success') {
                const jobs = await githubRequest(repo, token, `/actions/runs/${run.id}/jobs?per_page=100`);
                const summary = (jobs.jobs || []).map((job) => `${job.name}: ${job.conclusion || job.status}`).join('; ');
                throw new Error(`workflow failed (${run.conclusion})${summary ? `: ${summary}` : ''}\n${run.html_url}`);
            }
            return run;
        }
        await new Promise((resolve) => setTimeout(resolve, 10000));
    }
    throw new Error(`timed out waiting for workflow run ${run.html_url || run.id}`);
}

async function downloadResponse(url, token, destination) {
    const response = await requestGitHubUrl(url, {
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'AITerminal-publish-script'
        },
        timeoutMs: 120000
    });
    if (!response.ok || !response.body) {
        throw new Error(`artifact download failed with HTTP ${response.status}`);
    }
    const body = typeof response.body.pipe === 'function' ? response.body : Readable.fromWeb(response.body);
    await pipeline(body, fs.createWriteStream(destination, { mode: 0o600 }));
}

function commandAvailable(command, args = ['--version']) {
    const result = spawnSync(commandName(command), args, { env: safeEnvironment(), stdio: 'ignore' });
    return result.status === 0;
}

function powershellQuote(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function extractZip(zipPath, destination) {
    fs.mkdirSync(destination, { recursive: true });
    if (process.platform === 'win32') {
        if (!commandAvailable('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'])) return false;
        runCommand('powershell', [
            '-NoProfile', '-NonInteractive', '-Command',
            `Expand-Archive -LiteralPath ${powershellQuote(zipPath)} -DestinationPath ${powershellQuote(destination)} -Force`
        ]);
        return true;
    }
    if (!commandAvailable('unzip', ['-v'])) return false;
    runCommand('unzip', ['-q', '-o', zipPath, '-d', destination]);
    return true;
}

async function downloadArtifacts(repo, token, run, commit, extract) {
    const data = await githubRequest(repo, token, `/actions/runs/${run.id}/artifacts?per_page=100`);
    const outputRoot = path.join(ROOT, 'release', 'github-actions', `${commit.slice(0, 12)}-${Date.now()}`);
    fs.mkdirSync(outputRoot, { recursive: true });
    const downloaded = [];
    for (const platform of PLATFORM_NAMES) {
        const expected = `AITerminal-${platform}-${commit}`;
        const artifact = (data.artifacts || []).find((candidate) => candidate.name === expected);
        if (!artifact) throw new Error(`workflow succeeded but artifact is missing: ${expected}`);
        const zipPath = path.join(outputRoot, `${artifact.name}.zip`);
        await downloadResponse(artifact.archive_download_url, token, zipPath);
        const extractedPath = path.join(outputRoot, artifact.name);
        const extracted = extract ? extractZip(zipPath, extractedPath) : false;
        downloaded.push({ name: artifact.name, zipPath, extractedPath: extracted ? extractedPath : '' });
    }
    return { outputRoot, downloaded };
}

function printPlan(options, repo, branch, version) {
    console.log('Dry run: no Git commit, push, workflow dispatch, or artifact download will occur.');
    console.log(`Repository: https://github.com/${repo}`);
    console.log(`Branch: ${branch}`);
    console.log(`Workflow: ${WORKFLOW_FILE}`);
    console.log(`Version: ${version}`);
    console.log(`Checks: ${options.checks ? 'npm test + secret scan + npm audit' : 'skipped'}`);
    console.log(`After push: ${options.wait ? (options.download ? 'wait and download all platform artifacts' : 'wait only') : 'do not wait'}`);
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        console.log(usage());
        return;
    }
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const repo = parseRepository(options.repo);
    const branch = options.branch || buildDefaultBranch(packageJson.version);
    validateBuildBranch(branch);
    if (options.dryRun) {
        printPlan(options, repo, branch, packageJson.version);
        return;
    }

    const token = getToken();
    if (!token) throw new Error('pushing requires GITHUB_TOKEN, GH_TOKEN, or AITERMINAL_GITHUB_TOKEN');
    if (!fs.existsSync(path.join(ROOT, WORKFLOW_FILE))) {
        throw new Error(`required workflow is missing: ${WORKFLOW_FILE}`);
    }
    if (options.checks) {
        console.log('Running release preflight checks...');
        runPreflightChecks();
    }

    ensureGitBranch(branch);
    const commitInfo = stageAndCommit(packageJson.version);
    const remote = ensureRemote(repo, token);
    console.log(`Pushing current source to ${repo}:${branch} (${commitInfo.commit})...`);
    // Git and the REST API can use different credential chains. Treat the
    // authenticated push as the repository access check so a stale/limited
    // API token cannot block a valid Git credential before it is tried.
    pushBranch(remote.name, branch, token);
    const commit = git(['rev-parse', 'HEAD']);
    const workflowUrl = `https://github.com/${repo}/actions/workflows/${WORKFLOW_FILE}`;
    console.log(`Push complete: https://github.com/${repo}/tree/${encodeURIComponent(branch).replace(/%2F/g, '/')}`);
    console.log(`Workflow: ${workflowUrl}`);

    if (!options.wait) return;
    console.log('Waiting for the cross-platform workflow...');
    const run = await findWorkflowRun(repo, token, branch, commit, options.timeoutMinutes);
    console.log(`Workflow succeeded: ${run.html_url}`);
    if (!options.download) return;
    const result = await downloadArtifacts(repo, token, run, commit, options.extract);
    console.log(`Artifacts saved under ${result.outputRoot}`);
    for (const artifact of result.downloaded) {
        console.log(`- ${artifact.name}: ${artifact.extractedPath || artifact.zipPath}`);
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`publish:github-build failed: ${redact(error.message)}`);
        process.exit(1);
    });
}

module.exports = {
    DEFAULT_REPO,
    PLATFORM_NAMES,
    WORKFLOW_FILE,
    buildDefaultBranch,
    formatRepositoryAccessError,
    parseArgs,
    parseRepository,
    redact,
    validateBuildBranch
};
