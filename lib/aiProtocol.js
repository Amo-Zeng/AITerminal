'use strict';
const { validateApiBaseUrl } = require('./apiSecurity');

const FORMATS = ['auto', 'chat-completions', 'responses', 'messages'];
const ENDPOINTS = { 'chat-completions': 'chat/completions', responses: 'responses', messages: 'messages' };
function normalizeApiFormat(value) {
    if (value == null || value === '') return 'auto';
    if (!FORMATS.includes(value)) throw new Error('不支持的 AI API 格式');
    return value;
}
function resolveApi(baseUrl, format = 'auto') {
    format = normalizeApiFormat(format);
    const checked = validateApiBaseUrl(baseUrl);
    if (!checked.valid) throw new Error(checked.error);
    const url = new URL(checked.value);
    let pathname = url.pathname.replace(/\/+$/, '');
    const matched = Object.entries(ENDPOINTS).find(([, suffix]) => pathname.endsWith('/' + suffix));
    if (format === 'auto') format = matched?.[0] || 'chat-completions';
    if (matched) pathname = pathname.slice(0, -(matched[1].length + 1));
    // Preserve proxy prefixes and query parameters, and never append two endpoints.
    if (!matched && !/\/v\d+(?:beta\d*)?$/.test(pathname)) pathname += '/v1';
    url.pathname = pathname + '/' + ENDPOINTS[format];
    url.hash = '';
    return { url, format };
}

class EventStream {
    constructor() { this.buffer = ''; this.data = []; }
    event() {
        if (!this.data.length) return;
        const raw = this.data.join('\n'); this.data = [];
        if (raw.trim() === '[DONE]') return;
        let frame;
        try { frame = JSON.parse(raw); } catch { throw new Error('AI 流式响应包含无效 JSON'); }
        if (frame.error || frame.type === 'error') throw new Error('AI 服务在流式响应中返回错误');
        this.frame(frame);
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
    flush() { if (this.buffer) this.line(this.buffer.replace(/\r$/, '')); this.buffer = ''; this.event(); }
}

function responsesMessage(response) {
    if (response?.error || response?.status !== 'completed' || !Array.isArray(response.output)) throw new Error('AI Responses 响应未完成，请重试或增加最大 Token 数');
    const content = response.output.filter(item => item.type === 'message').flatMap(item => item.content || [])
        .filter(part => part.type === 'output_text' || part.type === 'refusal').map(part => part.text || part.refusal || '').join('');
    const tool_calls = response.output.filter(item => item.type === 'function_call').map(item => ({
        id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments }
    }));
    return { content, tool_calls, continuation: response.output };
}
class ResponsesStream extends EventStream {
    constructor(onUpdate) { super(); this.onUpdate = onUpdate; this.content = ''; this.result = null; }
    frame(frame) {
        if (frame.type === 'response.failed' || frame.type === 'response.incomplete') throw new Error('AI Responses 响应未完成，请重试或增加最大 Token 数');
        if (this.result) return;
        if (frame.type === 'response.output_text.delta' || frame.type === 'response.refusal.delta') {
            if (typeof frame.delta === 'string') { this.content += frame.delta; this.onUpdate?.(this.content, false); }
        }
        // The final event contains complete output items, including reasoning and
        // function calls. Never dispatch a tool from an uncommitted delta.
        if (frame.type === 'response.completed') this.result = responsesMessage(frame.response);
    }
    finish() {
        this.flush();
        if (!this.result) throw new Error('AI Responses 流中途结束，缺少 response.completed');
        return this.result;
    }
}

function messagesMessage(response) {
    if (response?.error || !['end_turn', 'tool_use', 'stop_sequence'].includes(response?.stop_reason) || !Array.isArray(response.content)) throw new Error('AI Messages 响应未完成，请重试或增加最大 Token 数');
    const content = response.content.filter(part => part.type === 'text').map(part => part.text).join('');
    const tool_calls = response.content.filter(part => part.type === 'tool_use').map(part => ({
        id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input) }
    }));
    return { content, tool_calls, continuation: response.content };
}
class MessagesStream extends EventStream {
    constructor(onUpdate) { super(); this.onUpdate = onUpdate; this.content = ''; this.blocks = new Map(); this.closed = new Set(); this.started = false; this.done = false; this.stopReason = null; }
    frame(frame) {
        if (this.done) return;
        if (frame.type === 'message_start') { this.started = true; return; }
        if (frame.type.startsWith('content_block_')) {
            if (!this.started || !Number.isInteger(frame.index) || frame.index < 0 || frame.index > 255) throw new Error('AI Messages 内容索引无效');
            if (frame.type === 'content_block_start') {
                if (this.blocks.has(frame.index) || !frame.content_block) throw new Error('AI Messages 内容块无效');
                this.blocks.set(frame.index, { block: { ...frame.content_block }, json: '' });
                if (frame.content_block.type === 'text') { this.content += frame.content_block.text || ''; this.onUpdate?.(this.content, false); }
                return;
            }
            const entry = this.blocks.get(frame.index);
            if (!entry || this.closed.has(frame.index)) throw new Error('AI Messages 内容块顺序无效');
            if (frame.type === 'content_block_delta') {
                const delta = frame.delta || {};
                if (delta.type === 'text_delta' && entry.block.type === 'text') {
                    entry.block.text += delta.text; this.content += delta.text; this.onUpdate?.(this.content, false);
                } else if (delta.type === 'input_json_delta' && entry.block.type === 'tool_use') entry.json += delta.partial_json;
                else if (delta.type === 'thinking_delta' && entry.block.type === 'thinking') entry.block.thinking += delta.thinking;
                else if (delta.type === 'signature_delta') entry.block.signature = (entry.block.signature || '') + delta.signature;
            } else if (frame.type === 'content_block_stop') {
                if (entry.json) { try { entry.block.input = JSON.parse(entry.json); } catch { throw new Error('AI 工具参数不是有效 JSON'); } }
                this.closed.add(frame.index);
            }
        } else if (frame.type === 'message_delta') this.stopReason = frame.delta?.stop_reason;
        else if (frame.type === 'message_stop') {
            if (!this.started || this.closed.size !== this.blocks.size) throw new Error('AI Messages 内容块未完成');
            this.done = true;
        }
    }
    finish() {
        this.flush();
        if (!this.done) throw new Error('AI Messages 流中途结束，缺少 message_stop');
        return messagesMessage({ stop_reason: this.stopReason, content: [...this.blocks].sort(([a], [b]) => a - b).map(([, entry]) => entry.block) });
    }
}

function textContent(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content) && content.every(part => part.type === 'text' && typeof part.text === 'string')) return content.map(part => part.text).join('\n');
    throw new Error('当前 AI 请求仅支持文本消息');
}
function buildPayload(format, { config, messages, maxTokens, streaming, tools }) {
    const temperature = Number(config.temperature);
    const tokens = Math.max(1, Number.parseInt(maxTokens || config.maxTokens, 10) || 1000);
    const payload = { model: config.model, stream: streaming, temperature: Number.isFinite(temperature) && temperature >= 0 && temperature <= 2 ? temperature : 0.7 };
    if (format === 'responses') {
        Object.assign(payload, { max_output_tokens: tokens, store: false, include: ['reasoning.encrypted_content'], input: [] });
        for (const message of messages) {
            if (message.role === 'tool') payload.input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: textContent(message.content) });
            else {
                const content = textContent(message.content);
                if (content) payload.input.push({ role: message.role, content });
                for (const call of message.tool_calls || []) payload.input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
            }
        }
        if (tools) payload.tools = tools.map(({ function: fn }) => ({ type: 'function', name: fn.name, description: fn.description, parameters: fn.parameters, strict: fn.strict ?? false }));
    } else if (format === 'messages') {
        Object.assign(payload, { max_tokens: tokens, temperature: Math.min(1, payload.temperature), messages: [] });
        const system = [];
        for (const message of messages) {
            if (message.role === 'system' || message.role === 'developer') { system.push(textContent(message.content)); continue; }
            const role = message.role === 'assistant' ? 'assistant' : 'user';
            const content = [];
            if (message.role === 'tool') content.push({ type: 'tool_result', tool_use_id: message.tool_call_id, content: textContent(message.content) });
            else {
                const text = textContent(message.content);
                if (text) content.push({ type: 'text', text });
                for (const call of message.tool_calls || []) content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) });
            }
            if (!content.length) continue;
            if (payload.messages.at(-1)?.role === role) payload.messages.at(-1).content.push(...content);
            else payload.messages.push({ role, content });
        }
        if (system.length) payload.system = system.join('\n\n');
        if (!payload.messages.length) payload.messages.push({ role: 'user', content: [{ type: 'text', text: '请根据上述指令回复。' }] });
        if (tools) payload.tools = tools.map(({ function: fn }) => ({ name: fn.name, description: fn.description, input_schema: fn.parameters }));
    } else {
        Object.assign(payload, { max_tokens: tokens, messages: [...messages] });
        if (tools) payload.tools = tools;
    }
    return payload;
}
function appendToolResults(format, payload, response, results) {
    if (format === 'responses') payload.input.push(...response.continuation, ...results.map(({ id, content }) => ({ type: 'function_call_output', call_id: id, output: content })));
    else if (format === 'messages') payload.messages.push({ role: 'assistant', content: response.continuation }, { role: 'user', content: results.map(({ id, content }) => ({ type: 'tool_result', tool_use_id: id, content })) });
    else payload.messages.push({ role: 'assistant', content: response.content, tool_calls: response.tool_calls }, ...results.map(({ id, content }) => ({ role: 'tool', tool_call_id: id, content })));
}
function parseMessage(format, parsed) {
    if (format === 'responses') return responsesMessage(parsed);
    if (format === 'messages') return messagesMessage(parsed);
    if (parsed.error) throw new Error('AI 服务返回错误');
    const message = parsed.choices?.[0]?.message;
    return { content: message?.content || '', tool_calls: message?.tool_calls || [] };
}
module.exports = { normalizeApiFormat, resolveApi, buildPayload, appendToolResults, parseMessage, ResponsesStream, MessagesStream };
