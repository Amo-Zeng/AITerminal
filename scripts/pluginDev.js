'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readDirectory, readPackage } = require('../lib/pluginPackage');
const { pluginId } = require('../lib/pluginManifest');
async function main(args = process.argv.slice(2)) {
    const [command, input, extra] = args;
    if (!['new', 'pack', 'validate'].includes(command) || !input) throw new Error('用法：node scripts/pluginDev.js new <目录> <插件ID> | pack <目录> <输出.json> | validate <目录或插件包>');
    if (command === 'new') {
        const id = pluginId(extra);
        const directory = path.resolve(input);
        fs.mkdirSync(directory, { recursive: false });
        const manifest = { schemaVersion: 2, id, name: id, version: '1.0.0', description: '我的 AITerminal 插件', author: 'Your name', license: 'Apache-2.0', runtime: 'node', entry: 'index.js', engines: { aiterminal: '>=1.5.0', pluginApi: '^1.1.0' }, permissions: ['context.read'], configSchema: { type: 'object', properties: { greeting: { type: 'string', title: '问候语', default: '你好' } } }, tools: [{ id: 'hello', title: '问候', description: '读取当前标签信息并显示面板', inputSchema: { type: 'object', properties: { name: { type: 'string', default: '朋友' } } } }], panels: [{ id: 'greeting', title: '问候' }] };
        fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
        fs.writeFileSync(path.join(directory, 'index.js'), `'use strict';\n/** @param {import('./sdk').PluginContext<{greeting: string}>} ctx */\nexports.activate = ctx => {\n    ctx.tools.register('hello', async ({ name = '朋友' }) => {\n        const context = await ctx.context.read();\n        const text = ctx.config.greeting + '，' + name + '！标签：' + context.tabId;\n        await ctx.ui.publish('greeting', { type: 'text', text });\n        return { text };\n    });\n};\n`);
        fs.copyFileSync(path.join(__dirname, '../plugins/sdk/index.d.ts'), path.join(directory, 'sdk.d.ts'));
        console.log(`插件模板已创建：${directory}`); return;
    }
    const source = path.resolve(input);
    const manifest = fs.statSync(source).isDirectory() ? await readDirectory(source) : await readPackage(source);
    if (command === 'validate') { console.log(`有效插件：${manifest.id}@${manifest.version}，${manifest.tools?.length || manifest.actions.length} 个工具/动作`); return; }
    if (!extra) throw new Error('pack 需要输出文件路径');
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.resolve(extra), bytes, { flag: 'wx' });
    console.log(`已打包 ${manifest.id}@${manifest.version}\nSHA-256: ${crypto.createHash('sha256').update(bytes).digest('hex')}`);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
