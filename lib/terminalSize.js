'use strict';

function clampTerminalDimension(value, fallback, minimum, maximum) {
    if (value === null || value === undefined) return fallback;
    const text = typeof value === 'string' ? value.trim() : String(value);
    if (!text) return fallback;
    const number = typeof value === 'number' ? value : Number(text);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function sanitizeTerminalSize(cols, rows) {
    return {
        cols: clampTerminalDimension(cols, 80, 2, 1000),
        rows: clampTerminalDimension(rows, 24, 2, 500)
    };
}

module.exports = {
    sanitizeTerminalSize
};
