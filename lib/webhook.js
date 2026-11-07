'use strict';

const https = require('https');

const WEBHOOK_EVENTS = Object.freeze([
    'task_started',
    'security_confirmation',
    'task_completed',
    'task_error',
    'ssh_disconnected',
    'program_stopped',
    'output_matched'
]);

const DEFAULT_WEBHOOK_CONFIG = Object.freeze({
    enabled: false,
    url: '',
    events: Object.freeze(WEBHOOK_EVENTS.filter(event => event !== 'output_matched')),
    includeCommand: false,
    timeoutMs: 8000,
    outputRules: [],
    outputIgnoreCase: true,
    outputCooldownSeconds: 60,
    includeOutput: false
});

const SENSITIVE_KEY = /(api[-_]?key|authorization|cookie|password|passphrase|private[-_]?key|secret|token)/i;

function normalizeWebhookConfig(input = {}) {
    const requestedEvents = Array.isArray(input.events) ? input.events : DEFAULT_WEBHOOK_CONFIG.events;
    const events = WEBHOOK_EVENTS.filter((event) => requestedEvents.includes(event));
    const timeout = Number.parseInt(input.timeoutMs, 10);
    const rules = Array.isArray(input.outputRules) ? input.outputRules : [];
    const cooldown = Number(input.outputCooldownSeconds);
    return {
        enabled: input.enabled === true,
        url: typeof input.url === 'string' ? input.url.trim() : '',
        events,
        includeCommand: input.includeCommand === true,
        timeoutMs: Number.isFinite(timeout) ? Math.max(1000, Math.min(30000, timeout)) : 8000,
        outputRules: [...new Set(rules.filter(rule => typeof rule === 'string').map(rule => rule.trim()).filter(rule => rule && rule.length <= 200 && !/[\x00-\x1f\x7f]/.test(rule)))].slice(0, 20),
        outputIgnoreCase: input.outputIgnoreCase !== false,
        outputCooldownSeconds: Number.isFinite(cooldown) ? Math.max(1, Math.min(86400, Math.floor(cooldown))) : 60,
        includeOutput: input.includeOutput === true
    };
}

function validateOutputRules(input) {
    if (input.outputRules !== undefined && (!Array.isArray(input.outputRules) || input.outputRules.length > 20 || input.outputRules.some(rule => typeof rule !== 'string' || !rule.trim() || rule.trim().length > 200 || /[\x00-\x1f\x7f]/.test(rule)))) return '输出关键词最多 20 条，每条 1–200 字符，不能包含控制字符';
    if (input.enabled && Array.isArray(input.events) && input.events.includes('output_matched') && !input.outputRules?.length) return '请先填写至少一个输出匹配关键词';
    return '';
}

function appEventToWebhook(channel, payload = {}) {
    if (!payload || typeof payload !== 'object') return null;
    if (channel === 'ssh-disconnected') {
        return {
            event: 'ssh_disconnected',
            data: { status: 'disconnected', reason: String(payload.reason || '').slice(0, 500) }
        };
    }
    if (channel !== 'ai-takeover-update') return null;
    if (payload.type === 'start') return { event: 'task_started', data: { status: 'started' } };
    if (payload.type === 'complete') {
        return {
            event: 'task_completed',
            data: { status: 'completed', message: String(payload.message || '').slice(0, 1000) }
        };
    }
    if (payload.type === 'error') {
        return {
            event: 'task_error',
            data: { status: 'error', message: String(payload.message || 'AI task failed').slice(0, 1000) }
        };
    }
    return null;
}

function validateWebhookUrl(rawUrl) {
    let url;
    try {
        url = new URL(String(rawUrl || '').trim());
    } catch {
        return { valid: false, error: 'Webhook URL 无效' };
    }
    if (url.protocol !== 'https:') return { valid: false, error: 'Webhook 仅支持 HTTPS' };
    if (!url.hostname) return { valid: false, error: 'Webhook URL 缺少主机名' };
    if (url.username || url.password) return { valid: false, error: 'Webhook URL 不允许包含用户名或密码' };
    return { valid: true, url };
}

function redactString(value) {
    return String(value)
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
        .replace(/\b(sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{12,})\b/g, '[REDACTED]')
        .replace(/\b(api[_-]?key|password|passwd|secret|token)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1=[REDACTED]')
        .replace(/([?&](?:key|token|secret|signature|sig)=)[^&\s]+/gi, '$1[REDACTED]');
}

function redactSensitive(value, seen = new WeakSet()) {
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return redactString(value);
    if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
    if (Array.isArray(value)) return value.map((entry) => redactSensitive(entry, seen));
    if (typeof value !== 'object') return String(value);
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
        output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactSensitive(entry, seen);
    }
    seen.delete(value);
    return output;
}

function buildWebhookPayload(event, data = {}, config = {}) {
    const safeData = redactSensitive(data);
    if (!config.includeCommand) delete safeData.command;
    if (!config.includeOutput) delete safeData.output;
    return {
        event,
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        timestamp: new Date().toISOString(),
        source: 'AITerminal',
        ...safeData
    };
}

function sendWebhook(inputConfig, event, data = {}, requestImpl = https.request) {
    const config = normalizeWebhookConfig(inputConfig);
    const validation = validateWebhookUrl(config.url);
    if (!validation.valid) return Promise.reject(new Error(validation.error));
    if (!WEBHOOK_EVENTS.includes(event) && event !== 'test') return Promise.reject(new Error('Webhook 事件无效'));

    const body = JSON.stringify(buildWebhookPayload(event, data, config));
    return new Promise((resolve, reject) => {
        const req = requestImpl(validation.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'User-Agent': 'AITerminal-Webhook/1.0'
            }
        }, (res) => {
            let responseBody = '';
            res.setEncoding?.('utf8');
            res.on('data', (chunk) => {
                if (responseBody.length < 4096) responseBody += chunk;
            });
            res.on('end', () => {
                const statusCode = Number(res.statusCode || 0);
                if (statusCode >= 200 && statusCode < 300) resolve({ success: true, statusCode });
                else reject(new Error(`Webhook 返回 HTTP ${statusCode || 'unknown'}`));
            });
            res.on('aborted', () => reject(new Error('Webhook 响应中断')));
            res.on('error', reject);
        });
        req.setTimeout(config.timeoutMs, () => req.destroy(new Error('Webhook 请求超时')));
        const deadline = setTimeout(() => req.destroy(new Error('Webhook 请求超时')), config.timeoutMs);
        deadline.unref?.();
        req.once('close', () => clearTimeout(deadline));
        req.on('error', reject);
        req.end(body);
    });
}

module.exports = {
    DEFAULT_WEBHOOK_CONFIG,
    WEBHOOK_EVENTS,
    appEventToWebhook,
    buildWebhookPayload,
    normalizeWebhookConfig,
    redactSensitive,
    sendWebhook,
    validateWebhookUrl,
    validateOutputRules
};
