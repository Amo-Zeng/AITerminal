'use strict';
const http = require('http');
const https = require('https');
const { validateApiBaseUrl } = require('./apiSecurity');

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
function completionUrl(baseUrl) {
    const checked = validateApiBaseUrl(baseUrl);
    if (!checked.valid) throw new Error(checked.error);
    const url = new URL(checked.value);
    const pathname = url.pathname.replace(/\/+$/, '');
    if (!pathname.endsWith('/chat/completions')) {
        url.pathname = /^\/v\d+(?:beta\d*)?$/.test(pathname) || /\/v\d+(?:beta\d*)?$/.test(pathname)
            ? pathname + '/chat/completions' : pathname + '/v1/chat/completions';
    }
    url.hash = '';
    return url;
}

class ChatStream {
    constructor(onUpdate) { this.buffer = ''; this.content = ''; this.data = []; this.done = false; this.onUpdate = onUpdate; this.calls = new Map(); }
    event() {
        if (!this.data.length) return;
        const raw = this.data.join('\n'); this.data = [];
        if (raw.trim() === '[DONE]') { this.done = true; return; }
        if (this.done) return;
        let frame;
        try { frame = JSON.parse(raw); } catch { throw new Error('AI 流式响应包含无效 JSON'); }
        if (frame.error) throw new Error('AI 服务在流式响应中返回错误');
        const value = frame.choices?.[0]?.delta?.content;
        if (typeof value === 'string' && value) { this.content += value; this.onUpdate?.(this.content, false); }
        for (const item of frame.choices?.[0]?.delta?.tool_calls || []) {
            if (!Number.isInteger(item.index) || item.index < 0 || item.index >= 32) throw new Error('AI 工具调用索引无效');
            const call = this.calls.get(item.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (item.id) call.id = item.id;
            if (item.function?.name) call.function.name += item.function.name;
            if (item.function?.arguments) call.function.arguments += item.function.arguments;
            this.calls.set(item.index, call);
        }
    }
    line(line) {
        if (line === '') this.event();
        else if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
    }
    write(chunk) {
        this.buffer += chunk;
        let index;
        while ((index = this.buffer.indexOf('\n')) !== -1) {
            this.line(this.buffer.slice(0, index).replace(/\r$/, ''));
            this.buffer = this.buffer.slice(index + 1);
        }
    }
    finish(returnMessage = false) {
        if (this.buffer) this.line(this.buffer.replace(/\r$/, ''));
        this.buffer = ''; this.event();
        if (returnMessage && this.calls.size) return { content: this.content || null, tool_calls: [...this.calls].sort(([a], [b]) => a - b).map(([, call]) => call) };
        if (!this.content) throw new Error('AI 响应中未找到有效内容');
        this.onUpdate?.(this.content, true);
        return returnMessage ? { content: this.content, tool_calls: [] } : this.content;
    }
}

function abortError() { const error = new Error('AI 请求已取消'); error.code = 'AI_ABORTED'; return error; }
function wait(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(abortError());
        const abort = () => { clearTimeout(timer); reject(abortError()); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
        signal.addEventListener('abort', abort, { once: true });
    });
}
function requestOnce(url, payload, apiKey, signal, onUpdate, { timeoutMs, maxResponseBytes, returnMessage }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true; clearTimeout(deadline);
            error ? reject(error) : resolve(value);
        };
        const data = JSON.stringify(payload);
        const module = url.protocol === 'https:' ? https : http;
        const req = module.request(url, {
            method: 'POST', signal,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: `Bearer ${apiKey}`, 'User-Agent': 'AITerminal' }
        }, res => {
            let body = '', size = 0;
            const ok = res.statusCode >= 200 && res.statusCode < 300;
            const stream = ok && payload.stream && !String(res.headers['content-type']).includes('application/json') ? new ChatStream(onUpdate) : null;
            res.setEncoding('utf8');
            res.on('data', chunk => {
                if (settled) return;
                size += Buffer.byteLength(chunk);
                if (size > (ok ? maxResponseBytes : 65536)) {
                    const error = new Error('AI 响应超过大小限制'); finish(error); res.destroy(); return;
                }
                try { if (stream) stream.write(chunk); else body += chunk; }
                catch (error) { finish(error); res.destroy(); }
            });
            res.on('aborted', () => finish(signal.aborted ? abortError() : new Error('AI 响应中途断开，请重试')));
            res.on('error', () => finish(signal.aborted ? abortError() : new Error('AI 响应读取失败')));
            res.on('end', () => {
                if (settled) return;
                try {
                    if (!ok) {
                        const error = new Error(`AI API 请求失败：HTTP ${res.statusCode}`);
                        error.status = res.statusCode;
                        const seconds = Number(res.headers['retry-after']);
                        error.retryAfter = Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 60000) : null;
                        throw error;
                    }
                    if (stream) return finish(null, stream.finish(returnMessage));
                    let parsed;
                    try { parsed = JSON.parse(body); } catch { throw new Error('AI 响应不是有效 JSON'); }
                    const message = parsed.choices?.[0]?.message;
                    if (returnMessage && Array.isArray(message?.tool_calls) && message.tool_calls.length) return finish(null, { content: message.content || null, tool_calls: message.tool_calls });
                    const content = message?.content;
                    if (typeof content !== 'string' || !content) throw new Error('AI 响应中未找到有效内容');
                    if (payload.stream) onUpdate?.(content, true);
                    finish(null, returnMessage ? { content, tool_calls: [] } : content);
                } catch (error) { finish(error); }
            });
        });
        const deadline = setTimeout(() => { finish(new Error('AI 请求超时')); req.destroy(); }, timeoutMs);
        req.on('error', error => finish(signal.aborted ? abortError() : new Error(`AI 请求网络错误：${error.code || '连接失败'}`)));
        req.end(data);
    });
}

async function requestChat({ config, messages, maxTokens, streaming = false, onUpdate, owner, signal, tools, onToolCall, retries = 2, retryDelayMs = 30000, timeoutMs = 60000, maxResponseBytes = MAX_RESPONSE_BYTES }) {
    if (!config.apiKey) throw new Error('AI API Key 未设置，请在连接配置中设置');
    const url = completionUrl(config.baseUrl);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const handle = { destroy: () => controller.abort() };
    if (owner) {
        owner.aiRequests ||= new Set(); owner.aiRequests.add(handle); owner.currentAiReq = handle;
    }
    const temperature = Number(config.temperature);
    const payload = {
        model: config.model, messages, stream: streaming,
        max_tokens: Math.max(1, Number.parseInt(maxTokens || config.maxTokens, 10) || 1000),
        temperature: Number.isFinite(temperature) && temperature >= 0 && temperature <= 2 ? temperature : 0.7
    };
    const nativeTools = Array.isArray(tools) && tools.length > 0 && typeof onToolCall === 'function';
    if (nativeTools) { payload.tools = tools; payload.messages = [...messages]; }
    try {
        let rounds = 0;
        for (let attempt = 0; ; attempt++) {
            if (controller.signal.aborted) throw abortError();
            try {
                const response = await requestOnce(url, payload, config.apiKey, controller.signal, onUpdate, { timeoutMs, maxResponseBytes, returnMessage: nativeTools });
                if (!nativeTools) return response;
                if (!response.tool_calls.length) return response.content;
                if (++rounds > 8 || response.tool_calls.length > 16) throw new Error('AI 工具调用超过单次请求上限');
                const names = new Set(payload.tools.map(t => t.function.name)), ids = new Set();
                for (const call of response.tool_calls) {
                    if (typeof call.id !== 'string' || !call.id || call.id.length > 200 || ids.has(call.id) || !names.has(call.function?.name) || typeof call.function.arguments !== 'string' || call.function.arguments.length > 65536) throw new Error('AI 返回无效工具调用');
                    ids.add(call.id);
                }
                payload.messages.push({ role: 'assistant', ...response });
                for (const call of response.tool_calls) {
                    if (controller.signal.aborted) throw abortError();
                    let result;
                    try { result = await onToolCall(call.function.name, JSON.parse(call.function.arguments), controller.signal); }
                    catch (error) { result = { error: error.message }; }
                    payload.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result ?? null).slice(0, 65536) });
                }
                attempt = -1;
            }
            catch (error) {
                if (nativeTools && rounds === 0 && payload.tools && [400, 422].includes(error.status)) {
                    // Some compatible providers only accept text tools. The prompt
                    // still advertises the same validated plugin_tool protocol.
                    delete payload.tools;
                    return await requestOnce(url, payload, config.apiKey, controller.signal, onUpdate, { timeoutMs, maxResponseBytes });
                }
                if (error.status !== 429 || attempt >= retries || controller.signal.aborted) throw error;
                await wait(error.retryAfter ?? retryDelayMs * (attempt + 1), controller.signal);
            }
        }
    } finally {
        signal?.removeEventListener('abort', abort);
        if (owner) { owner.aiRequests.delete(handle); if (owner.currentAiReq === handle) owner.currentAiReq = null; }
    }
}
function cancelAiRequests(owner) {
    for (const request of owner?.aiRequests || []) request.destroy();
    owner?.currentAiReq?.destroy?.();
}
module.exports = { ChatStream, completionUrl, requestChat, cancelAiRequests };
