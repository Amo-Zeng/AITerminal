'use strict';
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');
const { findPackagedExecutable } = require('./packageStartupSmoke');
function runtimeFiles(root) {
    const files = ['main.js', 'preload.js', 'renderer.js', 'rendererSecurity.js', 'rendererStorage.js', 'pluginCenter.js', 'pluginCenter.css', 'workspaceRenderer.js', 'workspace.css', 'index.html'];
    for (const directory of ['lib', 'plugins']) {
        const walk = relative => {
            for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
                const file = path.join(relative, entry.name);
                if (entry.isDirectory()) walk(file);
                else if (/\.(js|json)$/.test(file)) files.push(file);
            }
        };
        walk(directory);
    }
    return files;
}
function verifyPackageSource(root, archive, files = runtimeFiles(root)) {
    for (const file of files) {
        const bytes = asar.extractFile(archive, file);
        if (!fs.readFileSync(path.join(root, file)).equals(bytes)) throw new Error(`packaged source mismatch: ${file}`);
    }
    const expected = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const actual = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
    for (const key of ['name', 'version', 'main', 'license']) if (actual[key] !== expected[key]) throw new Error(`packaged metadata mismatch: ${key}`);
    for (const [name, version] of Object.entries(expected.dependencies)) if (actual.dependencies[name] !== version) throw new Error(`packaged dependency mismatch: ${name}`);
    return files.length;
}
function main() {
    const root = path.resolve(__dirname, '..');
    const executable = process.argv[2] ? path.resolve(process.argv[2]) : findPackagedExecutable(path.join(root, 'release'));
    const archive = process.platform === 'darwin' ? path.join(path.dirname(executable), '..', 'Resources', 'app.asar') : path.join(path.dirname(executable), 'resources', 'app.asar');
    console.log(`packaged source verified: ${verifyPackageSource(root, archive)} runtime files + metadata/dependencies`);
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { verifyPackageSource, runtimeFiles };
