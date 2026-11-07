(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.AITerminalStorage = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    function readObject(storage, key) {
        try {
            const raw = storage.getItem(key);
            if (!raw || raw.length > 2 * 1024 * 1024) return {};
            const value = JSON.parse(raw);
            if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
            for (const name of ['__proto__', 'constructor', 'prototype']) delete value[name];
            return value;
        } catch { return {}; }
    }
    function terminalConfig(input, defaults, themes) {
        const config = { ...defaults };
        if (Number.isFinite(input.fontSize) && input.fontSize >= 8 && input.fontSize <= 40) config.fontSize = input.fontSize;
        if (Number.isInteger(input.scrollback) && input.scrollback >= 0 && input.scrollback <= 100000) config.scrollback = input.scrollback;
        if (typeof input.fontFamily === 'string' && input.fontFamily.trim() && input.fontFamily.length <= 400) config.fontFamily = input.fontFamily;
        if (typeof input.theme === 'string' && Object.hasOwn(themes, input.theme)) config.theme = input.theme;
        if (['block', 'underline', 'bar'].includes(input.cursorStyle)) config.cursorStyle = input.cursorStyle;
        for (const key of ['cursorBlink', 'bellSound']) if (typeof input[key] === 'boolean') config[key] = input[key];
        return config;
    }
    return { readObject, terminalConfig };
});
