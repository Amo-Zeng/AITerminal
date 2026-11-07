'use strict';
exports.activate = ctx => {
    const argv = (...args) => ['docker', ...(ctx.config.context ? ['--context', ctx.config.context] : []), ...args];
    const container = value => { if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)) throw new Error('容器名称或 ID 无效'); return value; };
    const run = async (args, requiresConfirmation = false) => {
        const result = await ctx.terminal.exec({ argv: args, requiresConfirmation });
        if (result.exitCode !== 0) throw new Error(result.output.slice(-4000) || `Docker 退出码 ${result.exitCode}`);
        return result;
    };
    ctx.prompts.register('environment', () => `Docker 环境标记：${ctx.config.label}。工具只操作所属标签的终端目标。`);
    ctx.tools.register('environment', async () => {
        const context = await ctx.context.read();
        const result = { label: ctx.config.label, ...context };
        await ctx.ui.publish('environment', { type: 'text', title: ctx.config.label, text: JSON.stringify(result, null, 2) });
        return result;
    });
    ctx.tools.register('list', async () => {
        const result = await run(argv('ps', '-a', '--format', '{{json .}}'));
        const rows = result.output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        await ctx.ui.publish('containers', { type: 'table', title: ctx.config.label, columns: ['ID', '名称', '镜像', '状态'], rows: rows.slice(0, 100).map(r => [r.ID, r.Names, r.Image, r.Status]) });
        return rows;
    });
    ctx.tools.register('restart', ({ container: id }) => run(argv('restart', container(id)), true));
    ctx.tools.register('logs', async ({ container: id, follow = false }) => {
        const args = argv('logs', '--tail', String(ctx.config.tail), ...(follow ? ['--follow'] : []), container(id));
        if (!follow) return run(args);
        const { sessionId } = await ctx.terminal.open({ argv: args });
        let cursor = 0;
        while (!ctx.signal.aborted) {
            const result = await ctx.terminal.read(sessionId, { cursor, waitMs: 1000 }); cursor = result.cursor;
            if (result.text) ctx.progress(result.text);
            if (result.ended) { if (result.error || result.exitCode !== 0) throw new Error(result.error || `日志退出码 ${result.exitCode}`); return { exitCode: result.exitCode }; }
        }
    });
    ctx.tools.register('inspect', async ({ container: id }) => {
        id = container(id);
        ctx.progress('正在收集容器状态');
        const state = await run(argv('inspect', id));
        ctx.progress('正在收集最近日志');
        const logs = await run(argv('logs', '--tail', String(ctx.config.tail), id));
        return { state: JSON.parse(state.output), logs: logs.output };
    });
};
