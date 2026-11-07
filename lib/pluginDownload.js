'use strict';
const https = require('https');
const crypto = require('crypto');
const { MAX_MANIFEST_BYTES, parseManifest } = require('./pluginManifest');

function validatePluginUrl(raw) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.href.length > 2048) {
        throw new Error('插件 URL 必须使用 HTTPS，且不能包含凭据、查询参数或片段');
    }
    return url;
}
async function downloadManifest(rawUrl, expectedHash = '', options = {}) {
    const maxBytes = options.maxBytes || MAX_MANIFEST_BYTES;
    if (typeof expectedHash !== 'string' || (expectedHash && !/^[a-f0-9]{64}$/i.test(expectedHash))) throw new Error('SHA-256 应为 64 位十六进制');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const fetchBytes = (url, redirects = 0) => new Promise((resolve, reject) => {
        const req = https.get(validatePluginUrl(String(url)), { signal: controller.signal, headers: { 'User-Agent': 'AITerminal-PluginCenter', Accept: 'application/json' } }, res => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                res.resume();
                if (redirects >= 3) return reject(new Error('插件下载重定向过多'));
                try { resolve(fetchBytes(new URL(res.headers.location, url), redirects + 1)); } catch (e) { reject(e); }
                return;
            }
            if (res.statusCode !== 200) { res.resume(); reject(new Error(`插件下载失败：HTTP ${res.statusCode}`)); return; }
            const chunks = []; let size = 0;
            res.on('data', chunk => {
                size += chunk.length;
                if (size > maxBytes) { res.destroy(new Error(options.maxBytes ? '插件下载超过大小限制' : '插件清单超过 128 KiB')); return; }
                chunks.push(chunk);
            });
            res.on('error', reject);
            res.on('aborted', () => reject(new Error('插件下载中断')));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', error => reject(new Error(error.name === 'AbortError' ? '插件下载超时' : '插件下载网络错误')));
    });
    try {
        const url = validatePluginUrl(rawUrl);
        const bytes = await fetchBytes(url);
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        if (expectedHash && hash !== expectedHash.toLowerCase()) throw new Error('插件 SHA-256 与预期不符');
        return { manifest: (options.parse || parseManifest)(bytes.toString('utf8')), source: url.origin + url.pathname, downloadHash: hash };
    } finally { clearTimeout(timer); }
}
function downloadPackage(url, hash) {
    return downloadManifest(url, hash, { maxBytes: require('./pluginManifestV2').MAX_PACKAGE_BYTES, parse: require('./pluginPackage').parsePackage });
}
async function downloadCatalog(url) {
    const result = await downloadManifest(url, '', { parse: raw => {
        const value = JSON.parse(raw);
        if (value.schemaVersion !== 1 || !Array.isArray(value.plugins) || value.plugins.length > 100) throw new Error('插件源索引格式无效');
        return value.plugins.map(item => {
            const { pluginId } = require('./pluginManifest');
            const link = validatePluginUrl(item.url).href;
            if (!/^[a-f0-9]{64}$/i.test(item.sha256)) throw new Error('插件源条目必须声明 SHA-256');
            return { id: pluginId(item.id), name: String(item.name || item.id).slice(0, 80), description: String(item.description || '').slice(0, 1000), version: String(item.version || ''), url: link, sha256: item.sha256.toLowerCase() };
        });
    } });
    return result.manifest;
}
module.exports = { validatePluginUrl, downloadManifest, downloadPackage, downloadCatalog };
