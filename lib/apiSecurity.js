'use strict';

function validateApiBaseUrl(rawUrl) {
    const value = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!value) return { valid: false, error: 'API基础URL不能为空' };

    let url;
    try {
        url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    } catch {
        return { valid: false, error: '无效的API基础URL' };
    }

    const localHttpHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHttpHosts.has(url.hostname))) {
        return { valid: false, error: 'API基础URL必须使用HTTPS；仅允许 localhost/127.0.0.1/::1 使用HTTP' };
    }
    if (url.username || url.password) {
        return { valid: false, error: 'API基础URL不允许包含用户名或密码' };
    }
    return { valid: true, url, value: url.toString().replace(/\/$/, '') };
}

function normalizeApiBaseUrl(rawUrl, fallback = 'https://api.openai.com') {
    const result = validateApiBaseUrl(rawUrl);
    if (result.valid) return result.value;
    return fallback;
}

function normalizeConfiguredApiBaseUrl(rawUrl, fallback = 'https://api.openai.com') {
    if (rawUrl === undefined || rawUrl === null) return fallback;
    const result = validateApiBaseUrl(rawUrl);
    return result.valid ? result.value : '';
}

module.exports = { normalizeApiBaseUrl, normalizeConfiguredApiBaseUrl, validateApiBaseUrl };
