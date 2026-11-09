'use strict';

(() => {
    const api = window.electronAPI;
    const dialog = document.getElementById('pluginCenter');
    const list = document.getElementById('pluginList');
    const detail = document.getElementById('pluginDetail');
    const status = document.getElementById('pluginStatus');
    const search = document.getElementById('pluginSearch');
    const filter = document.getElementById('pluginFilter');
    let tabId, owner, entries = [], selected = null, preview = null, busy = false, generation = 0, refreshVersion = 0;
    let remoteEntries = [];
    let pendingRefresh = false;
    const drafts = new Map();

    function element(tag, text, className) {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (className) node.className = className;
        return node;
    }
    function button(label, action, data = {}, className = 'btn btn-secondary') {
        const node = element('button', label, className);
        node.type = 'button'; node.dataset.pluginAction = action;
        Object.assign(node.dataset, data); node.disabled = busy;
        return node;
    }
    function valid() { return dialog.open && ownsTerminalTab(tabId, owner); }
    function message(text, error = false) {
        status.textContent = text; status.classList.toggle('plugin-error', error);
    }
    function form(schema, values, key) {
        const node = element('div', undefined, 'plugin-form'); node.dataset.formKey = key;
        const draft = drafts.get(key) || values || {};
        for (const [name, field] of Object.entries(schema?.properties || {})) {
            const row = element('label', undefined, 'plugin-field'); row.append(element('span', field.title || name));
            let input;
            if (field.enum) { input = element('select'); for (const value of field.enum) { const option = element('option', String(value)); option.value = JSON.stringify(value); input.append(option); } }
            else input = element(['object', 'array'].includes(field.type) ? 'textarea' : 'input');
            input.dataset.field = name; input.dataset.type = field.enum ? 'enum' : field.type;
            const value = draft[name] ?? field.default;
            if (field.type === 'boolean' && !field.enum) { input.type = 'checkbox'; input.checked = value === true; }
            else {
                if (input.tagName === 'INPUT') input.type = ['number', 'integer'].includes(field.type) ? 'number' : 'text';
                input.value = value === undefined ? '' : field.enum || ['object', 'array'].includes(field.type) ? JSON.stringify(value) : String(value);
                if (field.minimum !== undefined) input.min = field.minimum;
                if (field.maximum !== undefined) input.max = field.maximum;
                if (field.maxLength) input.maxLength = field.maxLength;
                if (input.type === 'number') input.step = field.type === 'integer' ? '1' : 'any';
            }
            input.disabled = busy; input.required = schema.required?.includes(name) || false;
            const raw = drafts.get(key + ':raw')?.[name];
            if (raw) { input.value = raw.value; if (input.type === 'checkbox') input.checked = raw.checked; }
            row.append(input); if (field.description) row.append(element('small', field.description)); node.append(row);
        }
        node.addEventListener('input', () => { drafts.set(key + ':raw', Object.fromEntries([...node.querySelectorAll('[data-field]')].map(input => [input.dataset.field, { value: input.value, checked: input.checked }]))); });
        return node;
    }
    function readForm(node) {
        const value = {};
        for (const input of node.querySelectorAll('[data-field]')) {
            if (!input.reportValidity()) throw new Error('请检查表单参数');
            const { field, type } = input.dataset;
            if (type === 'boolean') value[field] = input.checked;
            else if (!input.value && !input.required) continue;
            else if (['object', 'array', 'enum'].includes(type)) value[field] = JSON.parse(input.value);
            else if (['number', 'integer'].includes(type)) value[field] = Number(input.value);
            else value[field] = input.value;
        }
        return value;
    }
    function extensions(p) {
        if (p.schemaVersion !== 2) return;
        const runtime = p.runtimeState || {};
        const states = { running: '运行中', loading: '加载中', idle: '按需启动', disabled: '已停用', stopped: '已停止', error: '错误' };
        detail.append(element('p', `运行状态：${states[runtime.status] || '未安装'} · ${p.runtime === 'mcp' ? 'MCP 服务' : '代码插件'}`, 'plugin-notice'));
        if (runtime.error) detail.append(element('p', runtime.error, 'plugin-error'));
        if (p.compatible) detail.append(element('p', p.compatible, 'plugin-error'));
        if (p.mcp) detail.append(element('pre', JSON.stringify(p.mcp, null, 2), 'plugin-command'));
        if (Object.keys(p.dependencies || {}).length) detail.append(element('p', '依赖：' + Object.entries(p.dependencies).map(([id, version]) => `${id} ${version}`).join('、')));
        if (p.installed && !preview) {
            const settings = element('details'); settings.dataset.persist = 'config:' + p.id; settings.append(element('summary', '插件配置'));
            settings.append(element('p', '配置默认只保存到本标签；“保存为用户默认”供未覆盖此配置的标签使用。', 'plugin-muted'));
            settings.append(form(p.configSchema, p.config, 'config:' + p.id), button('保存本标签配置', 'config', { id: p.id, scope: 'tab' }), button('保存当前连接配置', 'config', { id: p.id, scope: 'connection' }), button('保存为用户默认', 'config', { id: p.id, scope: 'user' })); detail.append(settings);
        }
        // Keep current results visible before the tool forms (especially quizzes).
        const panelOrder = (p.panels || []).map(panel => panel.id);
        for (const panel of [...(runtime.panels || [])].sort((a, b) => panelOrder.indexOf(a.id) - panelOrder.indexOf(b.id))) {
            const section = element('section', undefined, 'plugin-tool'); section.dataset.panelId = panel.id; section.append(element('h4', panel.title || panel.id));
            if (panel.type === 'table' && Array.isArray(panel.columns) && Array.isArray(panel.rows)) {
                const table = element('table'); const header = element('tr'); for (const column of panel.columns.slice(0, 16)) header.append(element('th', String(column))); table.append(header);
                for (const row of panel.rows.slice(0, 100)) { const tr = element('tr'); for (const cell of (Array.isArray(row) ? row : []).slice(0, 16)) tr.append(element('td', String(cell ?? ''))); table.append(tr); } section.append(table);
            } else section.append(element('pre', String(panel.text || ''), 'plugin-command'));
            const pinButton = button('固定到工作区', 'pin-panel', { id: p.id, panelId: panel.id });
            section.append(pinButton);
            detail.append(section);
        }
        for (const tool of p.tools || []) {
            const section = element('section', undefined, 'plugin-tool');
            section.append(element('strong', tool.title), element('p', tool.description));
            if (!preview && p.enabled) { section.append(form(tool.inputSchema, {}, 'tool:' + p.id + ':' + tool.id), button('运行工具', 'tool', { id: p.id, toolId: tool.id }, 'btn btn-primary')); }
            else section.append(element('pre', JSON.stringify(tool.inputSchema, null, 2), 'plugin-command'));
            detail.append(section);
        }
        if (p.enabled && !preview) for (const model of p.models || []) detail.append(button(p.modelSelected === model.id ? `取消模型适配器：${model.title}` : `使用模型适配器：${model.title}`, 'model', { id: p.modelSelected === model.id ? '' : p.id, modelId: model.id }));
        const tasks = runtime.tasks || [];
        if (tasks.length) detail.append(element('h4', '任务与输出'));
        for (const task of [...tasks].reverse().slice(0, 20)) {
            const section = element('details'); section.dataset.persist = task.id; section.open = task.state === 'running';
            section.append(element('summary', `${task.name} · ${{ running: '运行中', completed: '完成', error: '失败', cancelled: '已取消' }[task.state]} · v${task.version}`));
            section.append(element('pre', task.error || task.output || JSON.stringify(task.result, null, 2), 'plugin-command'));
            if (task.result && task.output) section.append(element('pre', JSON.stringify(task.result, null, 2), 'plugin-command'));
            if (task.state === 'running') section.append(button('取消任务', 'cancel-task', { taskId: task.id })); detail.append(section);
        }
    }
    function render() {
        const expanded = new Set([...detail.querySelectorAll('details[open][data-persist]')].map(n => n.dataset.persist));
        const scroll = detail.scrollTop;
        list.replaceChildren(); detail.replaceChildren();
        const query = search.value.trim().toLowerCase();
        const combined = [...entries, ...remoteEntries.filter(p => !entries.some(e => e.id === p.id)).map(p => ({ ...p, tags: [], actions: [], permissions: [], remote: true, author: '插件源', license: '安装预览中查看', source: p.url }))];
        const visible = combined.filter(p => (filter.value !== 'installed' || p.installed) &&
            (filter.value !== 'enabled' || p.enabled) && `${p.name} ${p.description} ${p.tags.join(' ')} ${p.id}`.toLowerCase().includes(query));
        document.getElementById('pluginCount').textContent = `${entries.filter(p => p.enabled).length} 个已启用 · ${entries.filter(p => p.installed).length} 个已安装`;
        if (!visible.length) list.append(element('p', '没有匹配的插件。可调整搜索，或从文件 / HTTPS URL 导入。', 'plugin-empty'));
        for (const p of visible) {
            const card = button('', 'select', { id: p.id }, 'plugin-card');
            card.classList.toggle('selected', selected === p.id);
            card.setAttribute('aria-pressed', String(selected === p.id));
            card.append(element('strong', p.name), element('span', p.description, 'plugin-description'));
            const badges = element('span', undefined, 'plugin-badges');
            badges.append(element('span', p.enabled ? '本标签已启用' : p.installed ? '已安装' : '可安装'));
            if (p.bundled) badges.append(element('span', '内置'));
            card.append(badges); list.append(card);
        }
        const p = preview || combined.find(e => e.id === selected);
        if (!p) { detail.append(element('p', '选择插件查看指引、权限和完整命令。', 'plugin-empty')); return; }
        detail.append(element('h3', p.name), element('p', `${p.id} · v${p.version} · ${p.author}`), element('p', p.description));
        detail.append(element('p', `许可证：${p.license} · 来源：${p.source === 'bundled' ? '应用内置' : p.source}`, 'plugin-muted'));
        detail.append(element('p', `能力：${p.permissions.join('、') || '预览安装时查看'}`));
        if (p.schemaVersion === 2 && preview) detail.append(element('p', '此插件运行代码，具有当前电脑用户权限。请确认来源可信；停用会清理插件任务。', 'plugin-notice'));
        if (preview?.files && Object.keys(preview.files).length) {
            const code = element('details'); code.append(element('summary', '查看插件代码'));
            for (const [name, content] of Object.entries(preview.files)) code.append(element('h4', name), element('pre', content, 'plugin-command'));
            detail.append(code);
        }
        if (preview) {
            if (preview.restoring) detail.append(element('p', '恢复历史版本及其用户/连接配置，所有标签的此插件配置覆盖会重置；运行中的旧任务保持原快照。', 'plugin-notice'), element('pre', JSON.stringify(preview.restoredConfig, null, 2), 'plugin-command'));
            detail.append(element('p', preview.updating ? (p.schemaVersion === 2 ? '更新会先验证新实例，现有任务使用旧版本直到完成。' : '更新会停用所有标签中的旧版本；安装后可重新启用。') : '安装后处于停用状态，由你选择在哪个标签启用。', 'plugin-notice'));
            detail.append(button(preview.updating ? '确认更新' : '确认安装', 'install', {}, 'btn btn-primary'), button('取消预览', 'cancel-preview'));
        } else if (!p.installed) {
            detail.append(button('预览安装', p.remote ? 'preview-remote' : 'preview-bundled', { id: p.id }, 'btn btn-primary'));
        } else {
            const actions = element('div', undefined, 'plugin-actions');
            actions.append(button(p.enabled ? '在本标签停用' : '在本标签启用', 'enable', { id: p.id, enabled: String(!p.enabled) }, 'btn btn-primary'));
            actions.append(button(p.defaultEnabled ? '取消新标签默认启用' : '新标签默认启用', 'default', { id: p.id, enabled: String(!p.defaultEnabled) }));
            actions.append(button('卸载', 'uninstall', { id: p.id })); detail.append(actions);
        }
        extensions(p);
        if (p.installed && !preview && p.history?.length) {
            const history = element('details'); history.append(element('summary', '版本恢复'));
            for (const version of p.history) history.append(button(`预览恢复 v${version.version}`, 'rollback', { id: p.id, digest: version.digest }));
            detail.append(history);
        }
        if (p.instructions) { detail.append(element('h4', 'AI 工作指引'), element('pre', p.instructions, 'plugin-instructions')); }
        if (p.actions.length) detail.append(element('h4', '终端动作'));
        for (const a of p.actions) {
            const section = element('section', undefined, 'plugin-tool');
            section.append(element('strong', a.title), element('p', a.description || `执行目标：${{ any: '当前终端（本地或 SSH）', local: '本地', remote: 'SSH 远程' }[a.target]}`));
            for (const [shell, command] of Object.entries(a.commands)) {
                const audit = a.audits[shell];
                section.append(element('span', `${shell} · ${audit.requiresConfirmation ? '高危：' + audit.matchedPatterns.join('、') : '未命中高危规则'}`, audit.requiresConfirmation ? 'plugin-risk' : 'plugin-muted'));
                section.append(element('pre', command, 'plugin-command'));
            }
            if (!preview && p.enabled) section.append(button('在此标签运行', 'run', { id: p.id, actionId: a.id }));
            detail.append(section);
        }
        const hash = element('details'); hash.append(element('summary', '内容校验'));
        hash.append(element('pre', `清单 SHA-256\n${p.digest}${p.downloadHash ? '\n下载文件 SHA-256\n' + p.downloadHash : ''}`, 'plugin-command')); detail.append(hash);
        for (const node of detail.querySelectorAll('details[data-persist]')) if (expanded.has(node.dataset.persist)) node.open = true;
        detail.scrollTop = scroll;
    }
    async function refresh() {
        if (!valid()) return;
        const request = ++refreshVersion, view = generation;
        const result = await api.pluginsList(tabId);
        if (!valid() || view !== generation || request !== refreshVersion) return;
        if (!result?.success) throw new Error(result?.error || '插件列表加载失败');
        entries = result.plugins;
        if (document.activeElement?.id !== 'pluginSources') document.getElementById('pluginSources').value = (result.sources || []).join('\n');
        if (!selected || !entries.some(p => p.id === selected)) selected = entries[0]?.id || null;
        if (result.warning) message(result.warning, true);
        render();
    }
    async function perform(work, successText = '') {
        if (busy || !valid()) return;
        const view = generation;
        busy = true; render();
        for (const node of dialog.querySelectorAll('[data-plugin-action]')) node.disabled = true;
        message('正在处理…');
        try {
            const result = await work();
            if (!valid() || view !== generation) return;
            if (!result?.success) throw new Error(result?.error || '操作失败');
            if (result.cancelled) { message('已取消'); return; }
            if (result.preview) { preview = result.preview; selected = preview.id; }
            else { preview = null; await refresh(); }
            message(successText || (result.preview ? '请检查插件指引和命令，再确认安装。' : '设置已保存'));
        } catch (error) {
            if (view === generation && dialog.open) message(error.message, true);
        } finally {
            if (view === generation) {
                busy = false; render();
                for (const node of dialog.querySelectorAll('.plugin-toolbar [data-plugin-action], .plugin-import [data-plugin-action], .plugin-sources [data-plugin-action]')) node.disabled = false;
            }
        }
    }
    async function open() {
        if (dialog.open) return;
        tabId = activeTabId; owner = terminalTabs.get(tabId);
        if (!owner) return;
        generation++; busy = false; entries = []; remoteEntries = []; drafts.clear(); preview = null; selected = null;
        for (const node of dialog.querySelectorAll('[data-plugin-action]')) node.disabled = false;
        document.getElementById('pluginScope').textContent = `所属会话：${owner.title} · 文件/后台工具使用${owner.isConnected ? '直连 SSH 主机' : '本地独立进程'}，不跟随终端内的嵌套 SSH。需要操作眼前页面时使用“当前终端”接管。`;
        dialog.showModal(); message('正在加载插件…'); render();
        try { await refresh(); if (!status.classList.contains('plugin-error')) message('插件指引会加入本标签的 AI 请求；终端动作继续接受高危命令审计。'); }
        catch (error) { message(error.message, true); }
        search.focus();
    }
    document.getElementById('openPluginCenter').addEventListener('click', open);
    document.getElementById('closePluginCenter').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { generation++; preview = null; if (ownsTerminalTab(tabId, owner) && activeTabId === tabId) owner.terminal.focus(); });
    search.addEventListener('input', render); filter.addEventListener('change', render);
    dialog.addEventListener('click', event => {
        const node = event.target.closest('[data-plugin-action]');
        if (!node || busy || !valid()) return;
        const { pluginAction: action, id, actionId, enabled, toolId, taskId, scope, modelId } = node.dataset;
        if (action === 'select') { selected = id; preview = null; render(); }
        else if (action === 'pin-panel') {
            const plugin = entries.find(p => p.id === id);
            const panel = plugin?.runtimeState?.panels?.find(p => p.id === node.dataset.panelId);
            if (panel && workspace) { workspace.pin(tabId, id, panel.id, panel.title || plugin.name); dialog.close(); }
        }
        else if (action === 'cancel-preview') { preview = null; render(); message('已取消预览'); }
        else if (action === 'preview-bundled') void perform(() => api.pluginsPreview({ kind: 'bundled', id }, tabId));
        else if (action === 'file') void perform(() => api.pluginsPreview({ kind: 'file' }, tabId));
        else if (action === 'directory') void perform(() => api.pluginsPreview({ kind: 'directory' }, tabId));
        else if (action === 'preview-remote') { const p = remoteEntries.find(p => p.id === id); void perform(() => api.pluginsPreview({ kind: 'url', url: p.url, sha256: p.sha256 }, tabId)); }
        else if (action === 'rollback') void perform(() => api.pluginsPreview({ kind: 'rollback', id, digest: node.dataset.digest }, tabId));
        else if (action === 'sources') { const sources = document.getElementById('pluginSources').value.split('\n').map(v => v.trim()).filter(Boolean); void perform(() => api.pluginsSources(sources, tabId)); }
        else if (action === 'catalog') void perform(async () => { const result = await api.pluginsCatalog(tabId); if (result.success) { remoteEntries = result.entries; if (result.errors.length) throw new Error(result.errors.join('；')); } return result; }, '在线目录已刷新');
        else if (action === 'config' || action === 'tool') {
            try {
                const key = action === 'config' ? 'config:' + id : 'tool:' + id + ':' + toolId;
                const formNode = [...detail.querySelectorAll('[data-form-key]')].find(n => n.dataset.formKey === key);
                const params = readForm(formNode);
                void perform(async () => {
                    const result = action === 'config' ? await api.pluginsConfig(id, scope, params, tabId) : await api.pluginsTool(id, toolId, params, tabId);
                    if (result.success && action === 'config') { drafts.delete(key); drafts.delete(key + ':raw'); }
                    return result;
                }, action === 'config' ? '配置已保存' : '任务已启动，可在任务与输出中查看或取消。');
            } catch (error) { message(error.message, true); }
        }
        else if (action === 'cancel-task') void perform(() => api.pluginsCancel(taskId, tabId), '已取消任务');
        else if (action === 'model') void perform(() => api.pluginsModel(id, modelId, tabId));
        else if (action === 'url') void perform(() => api.pluginsPreview({ kind: 'url', url: document.getElementById('pluginUrl').value.trim(), sha256: document.getElementById('pluginHash').value.trim() }, tabId));
        else if (action === 'install') void perform(() => api.pluginsInstall(preview.token, tabId), '安装完成。可在本标签启用插件。');
        else if (action === 'enable') void perform(() => api.pluginsEnable(id, enabled === 'true', tabId));
        else if (action === 'default') void perform(() => api.pluginsDefault(id, enabled === 'true', tabId));
        else if (action === 'uninstall') void perform(() => api.pluginsUninstall(id, tabId), '已卸载，所有标签中的此插件已停用。');
        else if (action === 'run') void perform(() => api.pluginsRun(id, actionId, tabId), '命令已发送到所属终端。关闭插件中心可查看输出。');
    });
    api?.onMenuPluginCenter?.(open);
    api?.onPluginsChanged?.(() => {
        if (detail.contains(document.activeElement) && document.activeElement?.closest('[data-form-key]')) { pendingRefresh = true; return; }
        if (valid() && !busy) refresh().catch(e => message(e.message, true));
    });
    detail.addEventListener('focusout', event => {
        if (pendingRefresh && !event.relatedTarget?.closest('[data-form-key]')) { pendingRefresh = false; if (valid() && !busy) refresh().catch(e => message(e.message, true)); }
    });
})();
