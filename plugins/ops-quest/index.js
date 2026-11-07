'use strict';
const quests = [
    { id: 'inodes', category: 'Linux', title: '还有空间，为什么写不进？', evidence: '应用：No space left on device\ndf -h /data：容量使用 42%\ndf -i /data：inode 使用 100%\n/data/cache 下存在大量小文件', question: '下一步最合理的行动是？', options: ['直接扩容内存', '确认小文件来源和保留策略，再按业务范围清理', '重启网络服务', '不做检查，删除整个 /data'], correct: 'B', hint: '容量和文件数量是两种不同的限制。', explanation: 'inode 耗尽也会返回 ENOSPC。证据指向小文件数量；先定位来源、确认保留策略和备份，再做范围明确的清理，不能直接删除业务目录。' },
    { id: 'deleted-open', category: 'Linux', title: '文件删了，磁盘却没回来', evidence: 'df：/var 仍使用 96%\ndu：可见文件总量明显小于 df 已用量\nlsof +L1：worker 持有一个 20 GiB 的 deleted 日志文件', question: '哪种处理符合现有证据？', options: ['反复执行 rm', '格式化分区', '先确认日志重开机制，再受控重开日志或重启对应服务', '删除所有用户账户'], correct: 'C', hint: '目录里的名字消失，不代表进程已放开文件。', explanation: '删除只移除了目录项。进程仍持有文件描述符时空间不会释放；应确认服务支持的日志重开方式，必要时安排受控重启并验证空间恢复。' },
    { id: 'oom', category: 'Linux', title: '悄悄消失的进程', evidence: '应用突然退出，退出码 137\n内核日志：Memory cgroup out of memory: Killed process ...\n容器 memory.max = 256 MiB，峰值接近限制', question: '现在能得出的可靠结论是？', options: ['内核日志支持内存限制触发 OOM，应分析峰值和限制', '退出码 137 在任何情况下都证明 OOM', '必然是磁盘故障', '关掉所有内存限制即可完成排障'], correct: 'A', hint: '退出码是线索，内核日志才补上了关键证据。', explanation: '137 表示常见的 SIGKILL 退出结果，单独看不能证明 OOM。本题结合内核日志和 cgroup 限制，才支持 OOM 判断；需分析峰值、泄漏和合理资源预算。' },
    { id: 'docker-port', category: '容器与网络', title: '容器里能访问，外面却不行', evidence: '容器内部 curl 127.0.0.1:8080 成功\n端口映射 8080:8080\n容器内 ss -lnt：应用只监听 127.0.0.1:8080', question: '最应先验证哪一个假设？', options: ['镜像一定损坏', '必须开放宿主机所有端口', '需要关闭所有防火墙', '应用只绑定容器回环接口，应核对监听地址和暴露范围'], correct: 'D', hint: '端口映射不会把容器内的回环地址变成外部接口。', explanation: '只监听容器回环地址时，来自容器网络接口的流量到不了该监听端口。核对应用监听地址和预期暴露范围，再验证映射、防火墙及访问控制。' },
    { id: 'dns', category: '容器与网络', title: 'IP 通，名字不通', evidence: 'curl https://service.example：Could not resolve host\ncurl --resolve service.example:443:192.0.2.10 https://service.example 成功\n同一时刻应用日志只有解析失败', question: '下一步应先收集哪类证据？', options: ['盲目重装应用', '检查当前解析器配置、DNS 查询与缓存', '删除数据库', '修改 Git 分支'], correct: 'B', hint: '--resolve 绕过了名称查询，但保留了主机名语义。', explanation: '同一地址通过 --resolve 可以访问，支持先调查 DNS 路径。检查解析器配置、查询响应和缓存；这并不证明所有网络链路都永远正常。' },
    { id: 'ssh-key', category: '容器与网络', title: '主机钥匙变了', evidence: 'SSH：REMOTE HOST IDENTIFICATION HAS CHANGED\n服务器最近有重装计划，但你尚未确认执行结果\n连接目标是生产服务器', question: '最合理的下一步是？', options: ['无条件关闭主机密钥检查', '把警告当成网络波动', '通过可信渠道核实新指纹和重装记录，再更新信任', '把私钥发给陌生人核验'], correct: 'C', hint: '重装可能解释变化，但不能代替身份核验。', explanation: '指纹变化可能来自合法重装，也可能是连接被劫持。应通过独立可信渠道确认指纹与变更记录；直接删除记录或关闭检查会跳过身份验证。' },
    { id: 'git-rescue', category: 'Git与终端', title: '提交去了哪里？', evidence: '你误把分支指向了较早的提交\n刚才的提交不在 git log 当前分支里\ngit reflog 仍记录了那次提交的对象 ID', question: '如何优先保护这份工作？', options: ['确认对象 ID，创建一个救援分支保留它，再决定后续恢复', '立即清理全部不可达对象', '删除 .git 后重新开始', '直接 force push 覆盖远端'], correct: 'A', hint: '先给仍存在的提交一个可达的引用。', explanation: 'reflog 可帮助找到引用的历史位置。在确认对象 ID 后创建救援分支，可以先保留提交，再审查差异和恢复方案；不要急着清理对象或覆盖远端。' },
    { id: 'tmux-mouse', category: 'Git与终端', title: '滚轮怎么不听话了？', evidence: 'tmux 开启 mouse on，并排两个窗格\n滚轮和右键由终端应用接管\n你希望临时使用终端自身的文本选择与复制', question: '在 AITerminal 中可以先试哪个操作？', options: ['不停缩放字体', '向 Shell 输入随机转义字符', '删除 tmux 配置', '按住 Shift 使用鼠标，临时绕过应用鼠标模式'], correct: 'D', hint: '这是终端选择与应用鼠标上报之间的切换。', explanation: 'AITerminal 支持 Shift 临时绕过应用鼠标模式，使用终端选择或右键复制粘贴。正常模式下鼠标事件属于 tmux；字符漂移还应另查字号、Unicode 宽度和 resize。' }
];
exports.activate = ctx => {
    let queue = Promise.resolve();
    const serial = fn => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
    const initial = () => ({ current: null, answers: {}, hints: [] });
    const summary = state => {
        const results = Object.values(state.answers), correct = results.filter(answer => answer.correct).length;
        return { completed: results.length, total: quests.length, correct, points: results.reduce((sum, answer) => sum + answer.points, 0), badges: [
            ...(results.length ? ['迈出第一步'] : []), ...(correct >= 4 ? ['证据侦探'] : []), ...(results.length === quests.length ? ['巡检冒险家'] : []), ...(correct === quests.length && !state.hints.length ? ['全能排障官'] : [])
        ] };
    };
    const score = async state => {
        const result = summary(state);
        await ctx.ui.publish('score', { type: 'text', title: '冒险手册', text: `完成 ${result.completed}/${result.total} · 答对 ${result.correct} · 积分 ${result.points}\n徽章：${result.badges.join('、') || '等待解锁'}\n进度属于本标签；停用插件或关闭标签后重新开始。` });
        return result;
    };
    const show = async state => {
        const quest = quests.find(q => q.id === state.current);
        if (!quest) return { done: true, ...await score(state) };
        const answered = state.answers[quest.id], hinted = state.hints.includes(quest.id);
        const text = [`【模拟关卡 · ${quest.category}】${quest.title}`, '', quest.evidence, '', quest.question,
            ...quest.options.map((option, i) => `${'ABCD'[i]}. ${option}`),
            ...(hinted ? ['', `提示：${quest.hint}`] : []),
            ...(answered ? ['', `${answered.correct ? '答对了' : '这次没有选对'} · +${answered.points} 分 · 正确答案 ${quest.correct}`, quest.explanation] : []),
            '', '本关不会执行任何真实命令。'
        ].join('\n');
        await ctx.ui.publish('quest', { type: 'text', title: quest.title, text });
        return { id: quest.id, category: quest.category, title: quest.title, evidence: quest.evidence, question: quest.question, options: quest.options, ...(hinted ? { hint: quest.hint } : {}), ...(answered ? { answer: quest.correct, explanation: quest.explanation, ...answered } : {}) };
    };
    const useState = fn => serial(async () => {
        const saved = await ctx.state.read(), state = saved.value || initial();
        return fn(state, async () => ctx.state.write(state, saved.revision));
    });
    ctx.tools.register('next', () => useState(async (state, save) => {
        const current = quests.find(q => q.id === state.current);
        if (!current || state.answers[state.current] || (ctx.config.category !== '全部' && current.category !== ctx.config.category)) {
            const next = quests.find(q => !state.answers[q.id] && (ctx.config.category === '全部' || q.category === ctx.config.category));
            state.current = next?.id || null; await save();
            if (!next) {
                await ctx.ui.publish('quest', { type: 'text', title: '本分类已通关', text: '这个分类的关卡已经全部完成！切换分类继续挑战，或确认后重新开始。' });
                return { done: true, ...await score(state) };
            }
        }
        await score(state); return show(state);
    }));
    ctx.tools.register('hint', () => useState(async (state, save) => {
        if (!state.current) throw new Error('先点击“开始 / 下一关”。');
        if (!state.answers[state.current] && !state.hints.includes(state.current)) { state.hints.push(state.current); await save(); }
        return show(state);
    }));
    ctx.tools.register('answer', ({ choice }) => useState(async (state, save) => {
        const quest = quests.find(q => q.id === state.current);
        if (!quest) throw new Error('先点击“开始 / 下一关”。');
        if (!state.answers[quest.id]) {
            const correct = choice === quest.correct;
            state.answers[quest.id] = { choice, correct, points: correct ? state.hints.includes(quest.id) ? 5 : 10 : 0 };
            await save();
        }
        await score(state); return show(state);
    }));
    ctx.tools.register('score', () => useState(score));
    ctx.tools.register('reset', ({ confirm = false }) => useState(async (state, save) => {
        if (!confirm) throw new Error('请勾选确认清空进度。');
        Object.assign(state, initial()); await save();
        await ctx.ui.publish('quest', { type: 'text', title: '准备出发', text: '进度已重置，点击“开始 / 下一关”。' });
        return score(state);
    }));
};
