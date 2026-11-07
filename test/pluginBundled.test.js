'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork, spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { PluginManager } = require('../lib/pluginManager');
const { PluginRuntime, hostEnvironment } = require('../lib/pluginRuntime');
const { createPluginServices } = require('../lib/pluginServices');
const catalog = require('../plugins/catalog');
const PET = 'aiterminal.terminal-pet', QUEST = 'aiterminal.ops-quest', GIT = 'aiterminal.git-time-machine';
function fixture(t, ids, service) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-bundled-'));
    const manager = new PluginManager({ filePath: path.join(root, 'plugins.json'), catalog });
    for (const id of ids) manager.install(catalog.find(p => p.id === id), 'bundled');
    const first = { tabId: 'same-id', pluginIds: new Set(ids), pluginConfig: {} }, second = { tabId: 'same-id', pluginIds: new Set(ids), pluginConfig: {} };
    const capture = owner => owner.binding || { target: 'local', shell: process.platform === 'win32' ? 'powershell' : 'posix', cwd: root, valid: () => !owner.closed };
    const runtime = new PluginRuntime({ manager, owned: owner => !owner.closed, capture,
        service: service || (async () => { throw new Error('unexpected privileged service'); }),
        launch: () => fork(path.resolve('lib/pluginHost.js'), [], { env: hostEnvironment(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }) });
    t.after(async () => { runtime.close(); await new Promise(resolve => setTimeout(resolve, 1200)); fs.rmSync(root, { recursive: true, force: true }); });
    const invoke = (id, tool, params = {}, owner = first) => runtime.invoke(owner, id, 'tool', tool, params);
    return { root, manager, runtime, first, second, capture, invoke };
}
function git(directory, args) {
    // Git for Windows does not accept Node's \\.\nul device path as a
    // configuration file. Keep the fixture isolated with a real empty file
    // outside the repository, on every platform.
    const config = path.join(path.dirname(directory), 'empty.gitconfig');
    fs.writeFileSync(config, '');
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(directory, 'no-hooks')}`, '-C', directory, ...args], {
        encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr); return result.stdout;
}
test('bundled plugins validate, remain opt-in and keep the original catalog', () => {
    const manager = new PluginManager({ filePath: path.join(os.tmpdir(), `absent-${process.pid}`, 'plugins.json'), catalog });
    assert.equal(manager.catalog.size, 10);
    assert.equal(manager.defaultIds().size, 0);
    assert.deepEqual([...manager.catalog.get(PET).permissions, ...manager.catalog.get(QUEST).permissions], []);
    assert.equal(manager.catalog.get(GIT).permissions.includes('files.write'), false);
});
test('pet reacts to owned tasks once, excludes its own tools and preserves state across host recycling', async t => {
    const { runtime, first, second, invoke } = fixture(t, [PET]);
    first.pluginConfig[PET] = { name: '第一只', species: '猫' };
    second.pluginConfig[PET] = { name: '第二只', species: '机器人' };
    assert.equal((await invoke(PET, 'interact', { action: '摸摸' })).affection, 3);
    assert.equal((await invoke(PET, 'visit', {}, second)).affection, 0);
    const event = { id: 'task-1', pluginId: GIT, output: 'never read this output' };
    await runtime.emit(first, 'task.started', event);
    assert.equal((await invoke(PET, 'visit')).activeTasks, 1);
    await runtime.emit(first, 'task.completed', event);
    await runtime.emit(first, 'task.completed', event);
    await runtime.emit(first, 'task.started', event); // late start must not resurrect it
    await runtime.emit(first, 'task.completed', { ...event, id: 'self', pluginId: PET });
    let result = await invoke(PET, 'visit');
    assert.equal(result.completed, 1); assert.equal(result.activeTasks, 0);
    assert.doesNotMatch(JSON.stringify(runtime.snapshot(first, PET).panels), /never read/);
    await runtime.emit(first, 'task.error', { ...event, id: 'failure' });
    await runtime.emit(first, 'task.cancelled', { ...event, id: 'cancelled' });
    for (let i = 0; i < 2; i++) {
        await runtime.emit(first, 'task.started', { status: 'started' });
        await runtime.emit(first, 'task.completed', { status: 'completed' });
        await runtime.emit(first, 'task.completed', { status: 'completed' });
    }
    runtime.stop(await runtime.ensure(first, PET));
    first.pluginConfig[PET].name = '改名后';
    result = await invoke(PET, 'visit');
    assert.equal(result.name, '改名后'); assert.equal(result.completed, 3); assert.equal(result.failed, 1); assert.equal(result.cancelled, 1);
    assert.equal((await invoke(PET, 'visit', {}, second)).completed, 0);
    runtime.disable(first, PET);
    assert.equal((await invoke(PET, 'visit')).completed, 0);
});
test('quest scoring, hints, duplicate answers and progress survive recycling without crossing tabs', async t => {
    const { runtime, first, second, invoke } = fixture(t, [QUEST]);
    const question = await invoke(QUEST, 'next');
    assert.equal(question.id, 'inodes'); assert.equal(question.answer, undefined); assert.equal(question.explanation, undefined);
    assert.deepEqual(await invoke(QUEST, 'next'), question, 'double clicking next keeps the unanswered question');
    await invoke(QUEST, 'hint');
    const answered = await invoke(QUEST, 'answer', { choice: 'B' });
    assert.equal(answered.correct, true); assert.equal(answered.points, 5); assert.match(answered.explanation, /inode/);
    assert.deepEqual(await invoke(QUEST, 'answer', { choice: 'D' }), answered);
    await assert.rejects(invoke(QUEST, 'answer', { choice: 'Z' }), /参数/);
    assert.equal((await invoke(QUEST, 'score', {}, second)).points, 0);
    runtime.stop(await runtime.ensure(first, QUEST));
    assert.equal((await invoke(QUEST, 'score')).points, 5);
    first.pluginConfig[QUEST] = { category: 'Git与终端' };
    assert.equal((await invoke(QUEST, 'next')).id, 'git-rescue');
    await invoke(QUEST, 'answer', { choice: 'A' });
    assert.equal((await invoke(QUEST, 'score')).points, 15);
    await assert.rejects(invoke(QUEST, 'reset'), /勾选/);
    assert.equal((await invoke(QUEST, 'score')).points, 15);
    assert.equal((await invoke(QUEST, 'reset', { confirm: true })).points, 0);
    first.pluginConfig[QUEST] = { category: '全部' };
    for (const choice of ['B', 'C', 'A', 'D', 'B', 'C', 'A', 'D']) { await invoke(QUEST, 'next'); await invoke(QUEST, 'answer', { choice }); }
    const finished = await invoke(QUEST, 'next');
    assert.equal(finished.done, true); assert.equal(finished.points, 80); assert.equal(finished.total, 8); assert.ok(finished.badges.includes('全能排障官'));
});
test('Git timeline uses real commands with literal paths, supports empty/detached repositories and limits model data', async t => {
    const f = fixture(t, [GIT]);
    const repo = path.join(f.root, "repo 'quoted' ; $(echo literal)"); fs.mkdirSync(repo);
    git(repo, ['init', '--initial-branch=main']);
    f.first.pluginConfig[GIT] = { directory: repo, count: 2, style: '侦探故事' };
    const audits = [], requests = [];
    f.runtime.service = createPluginServices({ capture: f.capture,
        approve: async (_o, command, audit) => { audits.push({ command, audit }); return !audit.requiresConfirmation; },
        context: (_o, task) => ({ tabId: 'same-id', target: task.binding.target, shell: task.binding.shell }),
        model: async (_o, params) => { requests.push(params); return '从第一次提交开始，这个项目逐渐成形。'; }
    });
    assert.equal((await f.invoke(GIT, 'timeline')).commits.length, 0);
    await f.invoke(GIT, 'story'); assert.equal(requests.length, 0, 'empty repository does not need AI');
    fs.writeFileSync(path.join(repo, 'readme.txt'), 'SOURCE_CONTENT_MUST_STAY_LOCAL');
    git(repo, ['add', '--', 'readme.txt']); git(repo, ['commit', '-m', 'feat: 第一行代码']);
    git(repo, ['commit', '--allow-empty', '-m', 'fix: 引号 " ; $(echo text)']);
    fs.appendFileSync(path.join(repo, 'readme.txt'), '\nchanged');
    const before = git(repo, ['status', '--porcelain=v1']);
    const report = await f.invoke(GIT, 'timeline');
    assert.equal(report.commits.length, 2); assert.equal(report.branch, 'main'); assert.equal(report.trackedChanges, 1);
    assert.match(report.commits[1].subject, /第一行/);
    assert.equal(report.commits[0].subject, 'fix: 引号 " ; $(echo text)');
    assert.ok(audits.every(a => a.audit.requiresConfirmation === false));
    assert.equal((await f.invoke(GIT, 'story')).commits, 2);
    assert.equal(requests[0].allowTools, false);
    const sent = JSON.parse(requests[0].messages[1].content);
    assert.deepEqual(Object.keys(sent), ['commits']);
    assert.deepEqual(Object.keys(sent.commits[0]), ['hash', 'date', 'subject']);
    assert.doesNotMatch(JSON.stringify(requests), /SOURCE_CONTENT|fixture@example|repo 'quoted'/);
    assert.equal(git(repo, ['status', '--porcelain=v1']), before, 'reads do not modify the worktree');
    git(repo, ['checkout', '--detach']);
    assert.equal((await f.invoke(GIT, 'timeline')).branch, '游离 HEAD');
    await assert.rejects(f.invoke(GIT, 'timeline', { directory: path.join(f.root, 'not-found') }), /Git 读取失败/);
    await assert.rejects(f.invoke(GIT, 'timeline', { directory: '\n' }), /有效仓库路径/);
    const previous = f.runtime.service;
    f.runtime.service = (owner, method, params, task) => method === 'models.request' ? Promise.reject(new Error('fixture model unavailable')) : previous(owner, method, params, task);
    await assert.rejects(f.invoke(GIT, 'story'), /model unavailable/);
    const panel = f.runtime.snapshot(f.first, GIT).panels.find(p => p.id === 'story');
    assert.equal(panel.title, '故事生成失败'); assert.doesNotMatch(panel.text, /逐渐成形/);
});
test('Git commands run on the bound SSH channel and never read the host repository', { skip: process.platform === 'win32' }, async t => {
    const f = fixture(t, [GIT]);
    const repo = path.join(f.root, 'remote repo'); fs.mkdirSync(repo); git(repo, ['init', '--initial-branch=remote-branch']); git(repo, ['commit', '--allow-empty', '-m', 'REMOTE_ONLY']);
    const commands = [];
    f.first.binding = { target: 'remote', shell: 'posix', cwd: repo, valid: () => true, connection: { exec(command, _options, callback) {
        commands.push(command);
        const child = spawn('/bin/sh', ['-c', command]);
        const stream = new EventEmitter(); stream.stderr = new EventEmitter(); stream.close = () => child.kill(); stream.signal = () => child.kill();
        child.stdout.on('data', data => stream.emit('data', data)); child.stderr.on('data', data => stream.stderr.emit('data', data)); child.on('error', e => stream.emit('error', e)); child.on('close', (code, signal) => stream.emit('close', code, signal));
        callback(null, stream);
    } } };
    f.runtime.service = createPluginServices({ capture: f.capture, approve: async () => true, context: () => ({ target: 'remote', shell: 'posix' }) });
    const report = await f.invoke(GIT, 'timeline');
    assert.equal(report.target, 'remote'); assert.equal(report.branch, 'remote-branch'); assert.equal(report.commits[0].subject, 'REMOTE_ONLY'); assert.equal(commands.length, 5);
});
