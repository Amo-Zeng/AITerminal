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

function prepareNativeDependencies(projectRoot = path.resolve(__dirname, '..'), platform = process.platform) {
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
            ? `prepared ${helpers.length} node-pty macOS spawn-helper file(s)`
            : 'native dependency permissions ok');
    } catch (error) {
        console.error(`native dependency preparation failed: ${error.message}`);
        process.exit(1);
    }
}
