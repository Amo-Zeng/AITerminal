'use strict';

function decodeTerminalInput(data, encoding) {
    if (typeof data !== 'string' || data.length > 200000) throw new Error('Invalid terminal input');
    if (encoding === undefined || encoding === 'utf8') return data;
    if (encoding !== 'binary' || /[^\x00-\xff]/.test(data)) throw new Error('Invalid terminal input encoding');
    return Buffer.from(data, 'latin1');
}

module.exports = { decodeTerminalInput };
