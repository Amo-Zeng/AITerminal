'use strict';
const Ajv = require('ajv');
const ajv = new Ajv({ strict: false, allErrors: false, ownProperties: true, validateFormats: false });
const cache = new WeakMap();
const { jsonValue } = require('./pluginJson');
function schema(value = { type: 'object', properties: {}, additionalProperties: false }, depth = 0) {
    if (depth > 8 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('插件 Schema 无效');
    const allowed = ['type', 'title', 'description', 'default', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'];
    for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Schema 不支持 ${key}`);
    if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(value.type)) throw new Error('Schema 必须声明 type');
    const result = jsonValue(value, 32768);
    if (result.type === 'object') {
        if (result.properties && (typeof result.properties !== 'object' || Array.isArray(result.properties))) throw new Error('Schema properties 无效');
        result.properties = Object.fromEntries(Object.entries(result.properties || {}).map(([key, item]) => [key, schema(item, depth + 1)]));
        result.additionalProperties = false;
    }
    if (result.type === 'array') { result.items = schema(result.items, depth + 1); result.maxItems = Math.min(result.maxItems ?? 100, 1000); }
    if (result.type === 'string') result.maxLength = Math.min(result.maxLength ?? 8000, 65536);
    try { ajv.compile(result); } catch { throw new Error('插件 Schema 定义无效'); }
    return result;
}
function validate(schemaValue, data) {
    const copy = jsonValue(data);
    let check = cache.get(schemaValue);
    if (!check) { check = ajv.compile(schemaValue); cache.set(schemaValue, check); }
    if (!check(copy)) throw new Error(`插件参数/配置无效：${ajv.errorsText(check.errors, { dataVar: '值' })}`);
    return copy;
}
function defaults(value) {
    if (value.default !== undefined) return jsonValue(value.default);
    if (value.type !== 'object') return undefined;
    return Object.fromEntries(Object.entries(value.properties || {}).map(([key, item]) => [key, defaults(item)]).filter(([, item]) => item !== undefined));
}
function merge(a, b) {
    const out = { ...a };
    for (const [key, value] of Object.entries(b || {})) out[key] = value && typeof value === 'object' && !Array.isArray(value) ? merge(out[key], value) : value;
    return out;
}
module.exports = { jsonValue, schema, validate, defaults, merge };
