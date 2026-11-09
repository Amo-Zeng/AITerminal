'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runElectronSmoke } = require('./clipboardSmoke');
const { quotePosix } = require('../lib/shellCommand');

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-documented-'));
    const file = path.join(directory, 'file with spaces.txt'); fs.writeFileSync(file, 'upload fixture');
    try {
        await runElectronSmoke(async ({ client, evaluate }) => {
            await evaluate(`(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'documented-file'; document.body.append(input); })()`);
            const { root } = await client.send('DOM.getDocument');
            const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#documented-file' });
            await client.send('DOM.setFileInputFiles', { nodeId, files: [file] });
            const dropped = await evaluate(`(() => { const files = document.getElementById('documented-file').files; return { oldPath: files[0].path ?? null, paths: getDroppedFilePaths(files, 'tab-1') }; })()`);
            assert.equal(dropped.oldPath, null, 'Electron no longer exposes File.path');
            assert.deepEqual(dropped.paths, [file], 'real File crosses the preload bridge and resolves its disk path');
            assert.equal(await evaluate("electronAPI.getPathForFile(new File(['in memory'], 'memory.txt'))"), '', 'synthetic files have no disk path');
            if (process.platform === 'win32') {
                console.log('File bridge verified; local shell send requires initialized WSL Ubuntu and is covered on Linux/macOS CI.');
                return;
            }
            const waitFor = async predicate => {
                const deadline = Date.now() + 15000;
                while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
                throw new Error('Documented terminal flow timed out');
            };
            await waitFor(() => evaluate("terminalTabs.get('tab-1')?.localTerminalActive === true"));
            const resultFile = path.join(directory, 'command result.txt');
            const command = `printf '%s' 'two  quoted words' | cat > ${quotePosix(resultFile)}`;
            await evaluate(`selectCommand(${JSON.stringify(command)}); executeSpecialCommand()`);
            await waitFor(() => fs.existsSync(resultFile) && fs.readFileSync(resultFile, 'utf8') === 'two  quoted words');
            assert.equal(await evaluate("commandInput.value"), '');
            console.log('Saved command → send → audited IPC → real local PTY verified with quotes, pipes and spaced paths.');
        });
        console.log('Documented file and command flows smoke ok');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
