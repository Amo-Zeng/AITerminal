'use strict';
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { schema } = require('./pluginSchema');
const crypto = require('crypto');
async function activateMcp(ctx, manifest, report = () => {}) {
    const client = new Client({ name: 'AITerminal', version: '1.0.0' });
    const config = manifest.mcp;
    const transport = config.transport === 'stdio'
        ? new (require('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport)({ command: config.command, args: config.args, stderr: 'pipe' })
        : new (require('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport)(new URL(config.url));
    ctx.onDispose(() => client.close());
    if (transport.stderr) transport.stderr.on('data', () => {});
    report('mcp-connect');
    await client.connect(transport, { timeout: 15000 });
    report('mcp-catalog');
    const capabilities = client.getServerCapabilities();
    const response = capabilities?.tools ? await client.listTools({}, { timeout: 15000 }) : { tools: [] };
    if (response.nextCursor || response.tools.length > 30) throw new Error('MCP 工具超过当前每插件 30 个的上限');
    const original = new Map();
    manifest.tools = response.tools.map(tool => {
        const id = 'mcp-' + crypto.createHash('sha256').update(tool.name).digest('hex').slice(0, 20);
        original.set(id, tool.name);
        const input = { ...tool.inputSchema }; delete input.$schema;
        return { id, title: tool.title || tool.name, description: tool.description || tool.name, inputSchema: schema(input), timeoutMs: 120000, destructive: tool.annotations?.destructiveHint !== false };
    });
    for (const tool of manifest.tools) ctx.tools.register(tool.id, async params => {
        const result = await client.callTool({ name: original.get(tool.id), arguments: params }, undefined, { signal: ctx.signal, timeout: tool.timeoutMs });
        if (result.isError) throw new Error(result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 2000) || 'MCP 工具执行失败');
        return result;
    });
    if (capabilities?.resources) {
        manifest.tools.push({ id: 'resource-list', title: '资源列表', description: '列出 MCP 资源', inputSchema: schema(), timeoutMs: 15000, destructive: false }, { id: 'resource-read', title: '读取资源', description: '按 URI 读取 MCP 资源', inputSchema: schema({ type: 'object', properties: { uri: { type: 'string', maxLength: 2000 } }, required: ['uri'] }), timeoutMs: 30000, destructive: false });
        ctx.tools.register('resource-list', () => client.listResources({}, { signal: ctx.signal, timeout: 15000 }));
        ctx.tools.register('resource-read', ({ uri }) => client.readResource({ uri }, { signal: ctx.signal, timeout: 30000 }));
    }
}
module.exports = { activateMcp };
