'use strict';
const semver = require('semver');
const { schema, jsonValue, defaults, validate } = require('./pluginSchema');
const API_VERSION = '1.1.0';
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const PERMISSIONS = ['terminal.execute', 'terminal.interactive', 'files.read', 'files.write', 'models.request', 'notifications.send', 'context.read', 'services.call', 'mcp.connect'];
function validateManifestV2(input, validateV1) {
    const { pluginId } = require('./pluginManifest');
    const allowed = ['schemaVersion', 'id', 'name', 'version', 'description', 'author', 'license', 'instructions', 'tags', 'actions', 'runtime', 'entry', 'files', 'engines', 'platforms', 'dependencies', 'permissions', 'configSchema', 'tools', 'panels', 'models', 'services', 'mcp'];
    for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`插件不支持字段 ${key}`);
    if (Buffer.byteLength(JSON.stringify(input)) > MAX_PACKAGE_BYTES) throw new Error('插件包超过 2 MiB');
    const base = validateV1(Object.fromEntries(['id', 'name', 'version', 'description', 'author', 'license', 'tags', 'actions'].map(k => [k, input[k]]).concat([['schemaVersion', 1], ['instructions', input.instructions || '插件扩展']])));
    if (!['node', 'mcp'].includes(input.runtime)) throw new Error('v2 runtime 必须为 node 或 mcp');
    if (!input.engines || typeof input.engines !== 'object' || !semver.validRange(input.engines.aiterminal) || !semver.validRange(input.engines.pluginApi)) throw new Error('请声明 engines.aiterminal 和 engines.pluginApi');
    const engines = { aiterminal: input.engines.aiterminal, pluginApi: input.engines.pluginApi };
    const platforms = input.platforms || ['win32', 'linux', 'darwin'];
    if (!Array.isArray(platforms) || !platforms.length || platforms.some(p => !['win32', 'linux', 'darwin'].includes(p))) throw new Error('插件平台声明无效');
    const permissions = input.permissions || [];
    if (!Array.isArray(permissions) || permissions.some(p => !PERMISSIONS.includes(p))) throw new Error('插件能力声明无效');
    const dependencies = jsonValue(input.dependencies || {}, 8192);
    if (Array.isArray(dependencies)) throw new Error('dependencies 必须为对象');
    for (const [id, range] of Object.entries(dependencies)) { pluginId(id); if (id === base.id || typeof range !== 'string' || !semver.validRange(range)) throw new Error('插件依赖声明无效'); }
    let configSchema = schema(input.configSchema);
    if (configSchema.type !== 'object') throw new Error('configSchema 必须为 object');
    const tools = (input.tools || []).map(tool => {
        if (!tool || typeof tool.title !== 'string' || tool.title.length > 100 || typeof tool.description !== 'string' || tool.description.length > 2000) throw new Error('工具标题或描述无效');
        const inputSchema = schema(tool.inputSchema);
        if (inputSchema.type !== 'object') throw new Error('工具 inputSchema 必须为 object');
        return { id: pluginId(tool.id), title: tool.title, description: tool.description, inputSchema, timeoutMs: Math.max(1000, Math.min(Number(tool.timeoutMs) || 60000, 3600000)) };
    });
    if (tools.length > 32 || new Set(tools.map(t => t.id)).size !== tools.length) throw new Error('工具过多或 ID 重复');
    const named = (items, label) => {
        if (!Array.isArray(items) || items.length > 16) throw new Error(`${label} 定义无效`);
        const result = items.map(item => ({ id: pluginId(item.id), title: String(item.title || item.id).slice(0, 100) }));
        if (new Set(result.map(i => i.id)).size !== result.length) throw new Error(`${label} ID 重复`);
        return result;
    };
    const panels = named(input.panels || [], 'panels'), models = named(input.models || [], 'models'), services = named(input.services || [], 'services');
    let files = {}, entry = '', mcp = null;
    if (input.runtime === 'node') {
        files = jsonValue(input.files || {}, MAX_PACKAGE_BYTES);
        if (Array.isArray(files) || Object.keys(files).length > 64) throw new Error('插件文件过多');
        for (const [name, content] of Object.entries(files)) {
            if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.(?:js|cjs|json|txt)$/.test(name) || name === 'manifest.json' || typeof content !== 'string') throw new Error('插件文件路径或内容无效');
        }
        entry = input.entry;
        if (typeof entry !== 'string' || !/\.(?:js|cjs)$/.test(entry) || !Object.hasOwn(files, entry)) throw new Error('插件 entry 不存在');
    } else {
        if (!permissions.includes('mcp.connect')) throw new Error('MCP 插件须声明 mcp.connect');
        mcp = jsonValue(input.mcp, 32768);
        if (!mcp || !['stdio', 'http'].includes(mcp.transport)) throw new Error('MCP transport 无效');
        if (mcp.transport === 'stdio') {
            if (typeof mcp.command !== 'string' || !mcp.command || /[\r\n\0]/.test(mcp.command) || !Array.isArray(mcp.args) || mcp.args.some(a => typeof a !== 'string' || /\0/.test(a))) throw new Error('MCP 启动命令无效');
            mcp = { transport: 'stdio', command: mcp.command, args: mcp.args };
        } else {
            const url = new URL(mcp.url);
            if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('MCP URL 需要 HTTPS 或本机 HTTP，不得嵌入凭据');
            mcp = { transport: 'http', url: url.href };
        }
        if (!input.configSchema) configSchema = schema({ type: 'object', properties: mcp.transport === 'http'
            ? { url: { type: 'string', title: 'MCP 服务 URL', default: mcp.url, maxLength: 2000 } }
            : { command: { type: 'string', title: 'MCP 服务程序', default: mcp.command, maxLength: 2000 }, args: { type: 'array', title: '启动参数', items: { type: 'string', maxLength: 2000 }, default: mcp.args } } });
    }
    return { ...base, schemaVersion: 2, instructions: input.instructions || '', runtime: input.runtime, engines, platforms, dependencies, permissions: [...new Set(permissions)], configSchema, tools, panels, models, services, entry, files, ...(mcp ? { mcp } : {}) };
}
function resolveMcpConfig(manifest, config) {
    const mcp = { ...manifest.mcp };
    if (mcp.transport === 'http') {
        if (config.url !== undefined) mcp.url = config.url;
        const url = new URL(mcp.url);
        if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('MCP URL 需要 HTTPS 或本机 HTTP，不能携带凭据');
        mcp.url = url.href;
    } else {
        if (config.command !== undefined) mcp.command = config.command;
        if (config.args !== undefined) mcp.args = config.args;
        if (typeof mcp.command !== 'string' || !mcp.command || /[\0\r\n]/.test(mcp.command) || !Array.isArray(mcp.args) || mcp.args.some(a => typeof a !== 'string' || /\0/.test(a))) throw new Error('MCP 启动参数无效');
    }
    return mcp;
}
function compatible(manifest, version = require('../package.json').version, platform = process.platform) {
    if (manifest.schemaVersion === 1) return '';
    if (!manifest.platforms.includes(platform)) return `不支持当前平台 ${platform}`;
    if (!semver.satisfies(version, manifest.engines.aiterminal, { includePrerelease: true })) return `需要 AITerminal ${manifest.engines.aiterminal}`;
    if (!semver.satisfies(API_VERSION, manifest.engines.pluginApi)) return `需要 Plugin API ${manifest.engines.pluginApi}`;
    return '';
}
module.exports = { validateManifestV2, compatible, resolveMcpConfig, API_VERSION, MAX_PACKAGE_BYTES };
