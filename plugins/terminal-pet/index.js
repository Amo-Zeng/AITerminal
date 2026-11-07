'use strict';
const ID = 'aiterminal.terminal-pet';
const faces = { 猫: [' /\_/\\', '( o.o )', ' > ^ <'], 狐狸: [' /\   /\\', '( o   o )', ' \\  v  /'], 机器人: [' [ o_o ]', ' /|___|\\', '   | |'] };
const tips = [
    '发布前确认当前主机和目录，别把生产环境当成测试环境。',
    '先保存排障证据，再做修改；一次只验证一个假设。',
    '备份的价值在于可以恢复，记得演练恢复过程。',
    'tmux 里先确认当前窗格；复制时按住 Shift 可绕过应用鼠标模式。',
    '磁盘满不一定是容量问题，也可能是 inode 用完了。',
    '长任务结束让 Webhook 来提醒你，先伸伸懒腰。'
];
exports.activate = ctx => {
    let queue = Promise.resolve();
    const serial = fn => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
    const initial = () => ({ completed: 0, failed: 0, cancelled: 0, affection: 0, running: [], finished: [], aiSequence: 0, mood: '等你来玩', message: '今天也一起把事情做好。' });
    const publish = async state => {
        const level = Math.floor(state.completed / 5) + 1;
        const result = { name: ctx.config.name, species: ctx.config.species, level, experience: state.completed * 10, completed: state.completed, failed: state.failed, cancelled: state.cancelled, affection: state.affection, activeTasks: state.running.length, mood: state.running.length ? '认真监工中' : state.mood, message: state.message };
        await ctx.ui.publish('pet', { type: 'text', title: `${ctx.config.name} · Lv.${level}`, text: [
            ...faces[ctx.config.species], '', `${ctx.config.name}（${ctx.config.species}） · ${result.mood}`,
            `经验 ${result.experience} · 亲密度 ${state.affection}/100 · 进行中 ${state.running.length}`,
            `完成 ${state.completed} · 失败 ${state.failed} · 取消 ${state.cancelled}`, '', state.message,
            '', '本标签会话记录；停用插件或关闭标签后重新开始。'
        ].join('\n') });
        return result;
    };
    const update = fn => serial(async () => {
        const saved = await ctx.state.read(), state = saved.value || initial();
        if (fn) {
            if (fn(state) === false) return;
            await ctx.state.write(state, saved.revision);
        }
        return publish(state);
    });
    ctx.tools.register('visit', () => update());
    ctx.tools.register('interact', ({ action = '摸摸' }) => update(state => {
        state.affection = Math.min(100, state.affection + (action === '投喂' ? 5 : 3));
        state.mood = action === '散步' ? '神清气爽' : '开心';
        state.message = `${action === '投喂' ? '啊呜，收到一块小饼干！' : action === '散步' ? '起来走走，眼睛也休息一下。' : '蹭蹭你的手，继续一起加油。'}\n${tips[(state.affection + state.completed) % tips.length]}`;
    }));
    for (const event of ['started', 'completed', 'error', 'cancelled']) {
        ctx.events.on(`task.${event}`, task => {
            // Our own tools must not award experience or trigger a feedback loop.
            if (task.pluginId === ID) return;
            return update(state => {
                const isAI = !task.id;
                if (isAI && event === 'started') {
                    if (state.running.some(id => id.startsWith('ai:'))) return false;
                    state.aiSequence++;
                }
                const key = isAI ? `ai:${state.aiSequence}` : `plugin:${task.id}`;
                if (state.finished.includes(key)) return false;
                if (event === 'started') {
                    if (state.running.includes(key)) return false;
                    state.running = [...state.running, key].slice(-100);
                    state.message = '你专心做事，我在这里陪着你。';
                } else {
                    state.running = state.running.filter(id => id !== key);
                    state.finished = [...state.finished, key].slice(-80);
                    if (event === 'completed') { state.completed++; state.mood = '开心'; state.message = '又完成一件事！记得核实结果，再给自己点个赞。'; }
                    if (event === 'error') { state.failed++; state.mood = '陪你排障'; state.message = '先别急，看看日志和退出码。我们从最小的假设开始。'; }
                    if (event === 'cancelled') { state.cancelled++; state.mood = '休息一下'; state.message = '暂停也是进展，想清楚再继续。'; }
                }
            });
        });
    }
};
