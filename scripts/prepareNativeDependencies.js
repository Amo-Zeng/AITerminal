'use strict';

const fs = require('fs');
const path = require('path');

function findNodePtySpawnHelpers(projectRoot) {
    const nodePtyRoot = path.join(projectRoot, 'node_modules', 'node-pty');
    const helpers = [path.join(nodePtyRoot, 'build', 'Release', 'spawn-helper')];
    const prebuildsRoot = path.join(nodePtyRoot, 'prebuilds');
    if (fs.existsSync(prebuildsRoot)) {
        for (const entry of fs.readdirSync(prebuildsRoot, { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name.startsWith('darwin-')) {
                helpers.push(path.join(prebuildsRoot, entry.name, 'spawn-helper'));
            }
        }
    }
    return helpers.filter((helper) => fs.existsSync(helper) && fs.statSync(helper).isFile());
}

function prepareWindowsConpty(projectRoot, arch) {
    const root = path.join(projectRoot, 'node_modules', 'node-pty');
    const source = path.join(root, 'prebuilds', `win32-${arch}`, 'conpty');
    const names = ['conpty.dll', 'OpenConsole.exe'];
    for (const name of names) {
        const file = path.join(source, name);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile() || !fs.statSync(file).size)
            throw new Error(`node-pty bundled ConPTY is missing for ${arch}: ${name}`);
    }
    const prepared = [];
    // electron/rebuild recreates build/Release without running node-pty's
    // postinstall asset copy. Each compiled module loads its adjacent DLL.
    for (const folder of ['Release', 'Debug']) {
        const output = path.join(root, 'build', folder);
        if (!fs.existsSync(path.join(output, 'conpty.node'))) continue;
        const destination = path.join(output, 'conpty');
        fs.mkdirSync(destination, { recursive: true });
        for (const name of names) {
            const file = path.join(destination, name);
            fs.copyFileSync(path.join(source, name), file);
            prepared.push(file);
        }
    }
    return prepared;
}

function prepareNativeDependencies(projectRoot = path.resolve(__dirname, '..'), platform = process.platform, arch = process.arch) {
    if (platform === 'win32') return prepareWindowsConpty(projectRoot, arch);
    if (platform !== 'darwin') return [];
    const helpers = findNodePtySpawnHelpers(projectRoot);
    if (!helpers.length) throw new Error('node-pty macOS spawn-helper was not found');
    for (const helper of helpers) {
        const mode = fs.statSync(helper).mode & 0o777;
        fs.chmodSync(helper, mode | 0o111);
        if ((fs.statSync(helper).mode & 0o111) === 0) {
            throw new Error(`node-pty spawn-helper is not executable: ${helper}`);
        }
    }
    return helpers;
}

module.exports = { findNodePtySpawnHelpers, prepareNativeDependencies };

if (require.main === module) {
    try {
        const helpers = prepareNativeDependencies();
        console.log(helpers.length
            ? `prepared ${helpers.length} node-pty runtime file(s)`
            : 'native dependency permissions ok');
    } catch (error) {
        console.error(`native dependency preparation failed: ${error.message}`);
        process.exit(1);
    }
}
