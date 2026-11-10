'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runElectronSmoke } = require('./clipboardSmoke');
const { createWorkspaceSshServer } = require('../test/fixtures/workspaceSshServer');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    const name = '中文😀 report.txt';
    const first = await createWorkspaceSshServer('FILES', { [name]: 'ALPHA file bytes 中文', 'other.txt': 'other' });
    const second = await createWorkspaceSshServer('OTHER', { [name]: 'BETA different file' });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-file-links-'));
    const destination = path.join(directory, 'download.txt');
    let control, dialogs;
    try {
        await runElectronSmoke(async ({ evaluate, client }) => {
            const wait = async (predicate, label) => {
                const end = Date.now() + 15000;
                while (Date.now() < end) { if (await predicate()) return; await delay(60); }
                throw new Error('File links timeout: ' + label);
            };
            await client.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
            await evaluate(`workspace.split('horizontal','tab-1')`);
            for (const [id, server] of [['tab-1', first], ['tab-2', second]])
                assert.equal(await evaluate(`autoConnectSSH(${JSON.stringify(server.config)},'${id}')`), true);
            await evaluate(`switchToTab('tab-1');electronAPI.sshSendRaw(${JSON.stringify('ls\r')},'tab-1')`);
            await wait(() => evaluate(`terminalTabs.get('tab-1').terminal.buffer.active.getLine(0)?.translateToString().includes(${JSON.stringify(name)})`), 'ls output');
            const before = await evaluate(`terminalTabs.get('tab-1').terminal.buffer.active.getLine(0).translateToString()`);
            // Real xterm linkifier + mouse click; the native save dialog fixture
            // supplies a temporary path, while SSH/SFTP and disk transfer are real.
            await evaluate(`document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))`);
            const point = await evaluate(`(()=>{const t=terminalTabs.get('tab-1').terminal,r=t.element.querySelector('.xterm-screen').getBoundingClientRect();return {x:r.x+r.width/t.cols/2,y:r.y+r.height/t.rows/2}})()`);
            await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
            try {
                await wait(() => evaluate(`terminalTabs.get('tab-1').terminal.element.title.includes(${JSON.stringify(name)})`), 'hover resolves SFTP filename');
            } catch (error) {
                throw new Error(error.message + '\n' + JSON.stringify(await evaluate(`(async()=>({listing:await electronAPI.sshListTerminalFiles('tab-1'),line:AITerminalFileLinks.readLogicalLine(terminalTabs.get('tab-1').terminal,1)?.text,title:terminalTabs.get('tab-1').terminal.element.title,mode:terminalTabs.get('tab-1').terminal.modes.mouseTrackingMode}))()`)));
            }
            fs.writeFileSync(control, JSON.stringify({ destination, hold: true }));
            await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
            await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
            await wait(() => fs.existsSync(dialogs), 'download save dialog');
            await evaluate(`switchToTab('tab-2')`);
            fs.writeFileSync(control, JSON.stringify({ destination, hold: false }));
            await wait(() => fs.existsSync(destination) && fs.statSync(destination).size === Buffer.byteLength('ALPHA file bytes 中文'), 'complete download');
            assert.equal(fs.readFileSync(destination, 'utf8'), 'ALPHA file bytes 中文');
            assert.deepEqual(first.downloads, ['/fixture/' + name]);
            assert.deepEqual(second.downloads, []);
            assert.equal(await evaluate(`terminalTabs.get('tab-1').terminal.buffer.active.getLine(0).translateToString()`), before, 'download does not corrupt terminal output');
            await delay(1300);
            assert.equal(await evaluate(`electronAPI.sshGetCurrentPath('tab-1').then(r=>r.path)`), '/fixture', 'delayed login-directory detection cannot overwrite the shell prompt directory');
            // Validate column mapping against real xterm Unicode 11 cells.
            const geometry = await evaluate(`(async()=>{const t=terminalTabs.get('tab-1').terminal;t.resize(16,12);t.reset();await new Promise(r=>t.write('中文 x.txt  ${'😀'.repeat(1)}.txt',r));
                const line=AITerminalFileLinks.readLogicalLine(t,1);return AITerminalFileLinks.matches(line,[{name:'x.txt'},{name:'😀.txt'}],1).map(x=>({name:x.name,range:x.range}));})()`);
            assert.deepEqual(geometry[0], { name: '😀.txt', range: { start: { x: 13, y: 1 }, end: { x: 2, y: 2 } } });
            assert.deepEqual(geometry[1], { name: 'x.txt', range: { start: { x: 6, y: 1 }, end: { x: 10, y: 1 } } });
            const wideWrap = await evaluate(`(async()=>{const t=terminalTabs.get('tab-1').terminal;t.reset();await new Promise(r=>t.write('         prefix中文.txt',r));return AITerminalFileLinks.matches(AITerminalFileLinks.readLogicalLine(t,1),[{name:'prefix中文.txt'}],1).map(x=>x.range)})()`);
            assert.deepEqual(wideWrap, [{start:{x:10,y:1},end:{x:8,y:2}}], 'wide glyph wrapping past the last column does not insert a filename space');
            const snapshot = await evaluate(`electronAPI.sshListTerminalFiles('tab-1')`);
            assert.equal(snapshot.success, true);
            await evaluate(`electronAPI.sshSendRaw(${JSON.stringify('cd /\r')},'tab-1')`);
            await wait(() => evaluate(`electronAPI.sshGetCurrentPath('tab-1').then(r=>r.path==='/')`), 'root directory is tracked instead of the login home');
            const moved = await evaluate(`electronAPI.sshDownloadFile(${JSON.stringify('/fixture/' + name)},'tab-1',${JSON.stringify(snapshot.token)})`);
            assert.equal(moved.success, false, 'directory change rejects old file links');
            await evaluate(`electronAPI.sshDisconnect('tab-1')`);
            assert.equal(await evaluate(`autoConnectSSH(${JSON.stringify(second.config)},'tab-1')`), true);
            const stale = await evaluate(`electronAPI.sshDownloadFile(${JSON.stringify('/fixture/' + name)},'tab-1',${JSON.stringify(snapshot.token)})`);
            assert.equal(stale.success, false, 'reconnect rejects old download link');
            assert.equal(fs.readFileSync(dialogs, 'utf8').trim().split('\n').length, 1);
            console.log('Terminal file links smoke ok: ordinary ls, real mouse download, Unicode/wrapped cell ranges, SFTP bytes, tab ownership, reconnect rejection, no terminal output injection');
        }, {
            entry: path.join(__dirname, '../test/fixtures/fileDownloadHost.js'),
            prepareProfile(profile) {
                control = path.join(profile, 'download-control.json'); dialogs = path.join(profile, 'download-dialogs.jsonl');
                fs.writeFileSync(control, JSON.stringify({ destination, hold: false }));
                fs.writeFileSync(path.join(profile, 'known_hosts'), first.knownHosts + second.knownHosts);
            },
        });
    } finally { await first.close(); await second.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
