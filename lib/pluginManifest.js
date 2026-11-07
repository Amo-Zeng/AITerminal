'use strict';

const crypto = require('crypto');
const { auditCommand } = require('./securityAudit');

const MAX_MANIFEST_BYTES = 128 * 1024;
const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
    return value;
}
function fields(value, allowed, label) {
    object(value, label);
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) throw new Error(`${label} 不支持字段 ${key}`);
    }
}
function text(value, label, max, optional = false) {
    if (optional && (value === undefined || value === '')) return '';
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
        throw new Error(`${label} 无效或超过 ${max} 字符`);
    }
    return value.trim();
}
function pluginId(value) {
    if (typeof value !== 'string' || value.length > 80 || !ID.test(value)) throw new Error('插件/动作 ID 无效');
    return value;
}
function validateManifest(input) {
    if (input?.schemaVersion === 2) return require('./pluginManifestV2').validateManifestV2(input, validateManifest);
    fields(input, ['schemaVersion', 'id', 'name', 'version', 'description', 'author', 'license', 'instructions', 'tags', 'actions'], '插件');
    if (input.schemaVersion !== 1) throw new Error('仅支持 AITerminal 插件 schemaVersion: 1');
    const version = text(input.version, 'version', 40);
    if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('version 必须是语义版本号');
    if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.length > 8)) throw new Error('tags 最多 8 项');
    if (input.actions !== undefined && (!Array.isArray(input.actions) || input.actions.length > 12)) throw new Error('actions 最多 12 项');
    const actions = (input.actions || []).map(action => {
        fields(action, ['id', 'title', 'description', 'target', 'commands'], '动作');
        fields(action.commands, ['posix', 'powershell'], 'commands');
        const commands = {};
        for (const shell of ['posix', 'powershell']) {
            if (action.commands[shell] !== undefined) {
                commands[shell] = text(action.commands[shell], 'command', 8000);
                if (/\r/.test(commands[shell]) || /^(?:plugin_run\s*\(|__(?:INTERACTIVE|REPL|MCP)__)/.test(commands[shell])) throw new Error('命令不能包含回车控制符、递归插件调用或内部控制协议');
            }
        }
        if (!Object.keys(commands).length) throw new Error('动作必须声明至少一种 Shell 命令');
        const target = action.target || 'any';
        if (!['any', 'local', 'remote'].includes(target)) throw new Error('动作 target 无效');
        return { id: pluginId(action.id), title: text(action.title, '动作标题', 80), description: text(action.description, '动作说明', 500, true), target, commands };
    });
    if (new Set(actions.map(a => a.id)).size !== actions.length) throw new Error('动作 ID 重复');
    const manifest = {
        schemaVersion: 1, id: pluginId(input.id), name: text(input.name, '名称', 80), version,
        description: text(input.description, '说明', 1000), author: text(input.author, '作者', 100),
        license: text(input.license, '许可证', 80), instructions: text(input.instructions, 'AI 指引', 12000, true),
        tags: [...new Set((input.tags || []).map(t => text(t, '标签', 30)))], actions
    };
    if (!manifest.instructions && !actions.length) throw new Error('插件必须提供 AI 指引或终端动作');
    return manifest;
}
function parseManifest(raw) {
    if (Buffer.byteLength(raw, 'utf8') > MAX_MANIFEST_BYTES) throw new Error('插件清单超过 128 KiB');
    return validateManifest(JSON.parse(raw));
}
function digest(manifest) {
    return crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}
function describeManifest(manifest) {
    return {
        ...manifest,
        digest: digest(manifest),
        permissions: [...new Set([manifest.instructions && 'ai.instructions', manifest.actions.length && 'terminal.execute', ...(manifest.permissions || [])].filter(Boolean))],
        actions: manifest.actions.map(action => ({ ...action, audits: Object.fromEntries(Object.entries(action.commands).map(([shell, command]) => [shell, auditCommand(command)])) }))
    };
}
function parsePluginCall(command) {
    if (!/^plugin_run\s*\(/.test(String(command).trim())) return null;
    const match = /^plugin_run\(\s*"([a-z0-9.-]+)"\s*,\s*"([a-z0-9.-]+)"\s*\)\s*$/.exec(String(command).trim());
    if (!match) throw new Error('插件调用格式应为 plugin_run("插件ID", "动作ID")');
    return { pluginId: pluginId(match[1]), actionId: pluginId(match[2]) };
}
function parsePluginToolCall(command) {
    if (!/^plugin_tool\s*\(/.test(String(command).trim())) return null;
    const match = /^plugin_tool\(([\s\S]*)\)\s*$/.exec(String(command).trim());
    if (!match || match[1].length > 65536) throw new Error('插件工具调用格式无效');
    let args;
    try { args = JSON.parse('[' + match[1] + ']'); } catch { throw new Error('工具参数必须为 JSON：plugin_tool("插件ID", "工具ID", {})'); }
    if (args.length !== 3 || !args[2] || typeof args[2] !== 'object' || Array.isArray(args[2])) throw new Error('插件工具参数无效');
    return { pluginId: pluginId(args[0]), toolId: pluginId(args[1]), params: args[2] };
}

module.exports = { MAX_MANIFEST_BYTES, pluginId, validateManifest, parseManifest, describeManifest, digest, parsePluginCall, parsePluginToolCall };
