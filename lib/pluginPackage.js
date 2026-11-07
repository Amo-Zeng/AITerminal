'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateManifest, digest, MAX_MANIFEST_BYTES } = require('./pluginManifest');
const { MAX_PACKAGE_BYTES } = require('./pluginManifestV2');
function parsePackage(raw) {
    if (Buffer.byteLength(raw) > MAX_PACKAGE_BYTES) throw new Error('插件包超过 2 MiB');
    const value = JSON.parse(raw);
    if (value.schemaVersion === 1 && Buffer.byteLength(raw) > MAX_MANIFEST_BYTES) throw new Error('插件清单超过 128 KiB');
    return validateManifest(value);
}
function materialize(root, raw) {
    const manifest = validateManifest(raw), hash = digest(manifest);
    const target = path.join(root, manifest.id, hash);
    if (fs.existsSync(target)) {
        for (const [name, content] of Object.entries(manifest.files || {})) {
            const file = path.join(target, name);
            if (!fs.lstatSync(file).isFile() || fs.readFileSync(file, 'utf8') !== content) throw new Error('已安装插件文件校验失败');
        }
        return target;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const staging = `${target}.${crypto.randomUUID()}.staging`;
    fs.mkdirSync(staging, { mode: 0o700 });
    try {
        for (const [name, content] of Object.entries(manifest.files || {})) {
            const file = path.join(staging, name);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
        }
        fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
        fs.renameSync(staging, target);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
    return target;
}
async function readPackage(filePath) {
    const file = await fs.promises.open(filePath, 'r');
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES) throw new Error('请选择不超过 2 MiB 的插件包');
        const buffer = Buffer.alloc(MAX_PACKAGE_BYTES + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        return parsePackage(buffer.subarray(0, bytesRead).toString('utf8'));
    } finally { await file.close(); }
}
async function readDirectory(directory) {
    const manifest = JSON.parse(await fs.promises.readFile(path.join(directory, 'plugin.json'), 'utf8'));
    const names = manifest.sourceFiles || [manifest.entry]; delete manifest.sourceFiles;
    if (!Array.isArray(names) || names.length > 64) throw new Error('sourceFiles 无效');
    manifest.files = {};
    let bytes = 0;
    for (const name of names) {
        if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.(?:js|cjs|json|txt)$/.test(name) || name === 'manifest.json') throw new Error('开发文件路径无效');
        let resolved = directory;
        for (const part of name.split('/')) { resolved = path.join(resolved, part); if ((await fs.promises.lstat(resolved)).isSymbolicLink()) throw new Error('插件开发目录不支持符号链接'); }
        const stat = await fs.promises.stat(resolved); bytes += stat.size;
        if (!stat.isFile() || bytes > MAX_PACKAGE_BYTES) throw new Error('插件文件超过大小限制');
        manifest.files[name] = await fs.promises.readFile(resolved, 'utf8');
    }
    return validateManifest(manifest);
}
module.exports = { parsePackage, materialize, readPackage, readDirectory };
