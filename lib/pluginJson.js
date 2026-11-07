'use strict';
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
function jsonValue(value, max = 1024 * 1024) {
    const raw = JSON.stringify(value);
    if (raw === undefined || Buffer.byteLength(raw) > max) throw new Error('插件数据无效或超过大小限制');
    return JSON.parse(raw, (key, item) => {
        if (forbidden.has(key)) throw new Error('插件数据包含保留字段');
        return item;
    });
}
module.exports = { jsonValue };
