'use strict';

function quotePosix(value) {
    return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}
function wrapDirectCommand(command, beginToken, endToken) {
    const script = `printf '%s\\n' ${quotePosix(beginToken)}\n${command}\nstatus=$?\nprintf '%s:%s\\n' ${quotePosix(endToken)} "$status"`;
    return `bash -lc ${quotePosix(script)}`;
}
module.exports = { quotePosix, wrapDirectCommand };
