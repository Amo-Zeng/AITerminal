'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { dialog, shell } = require('electron');
const profile = process.env.AITERMINAL_SMOKE_USER_DATA;
if (!profile || process.env.AITERMINAL_CLIPBOARD_SMOKE !== '1') throw new Error('Isolated test profile required');
const control = path.join(profile, 'open-control.json');
dialog.showSaveDialog = async (...args) => {
    fs.appendFileSync(path.join(profile, 'save-dialogs.jsonl'), JSON.stringify(args.at(-1)) + '\n');
    return { canceled: true };
};
dialog.showMessageBox = async (...args) => {
    fs.appendFileSync(path.join(profile, 'warning-dialogs.jsonl'), JSON.stringify(args.at(-1)) + '\n');
    return { response: 0 };
};
// Intercept only the OS viewer launch. The production IPC downloads real SFTP
// bytes to its own temporary file before reaching shell.openPath.
shell.openPath = async file => {
    if (path.dirname(file) !== os.tmpdir() || !path.basename(file).startsWith('AITerminal-'))
        throw new Error('Unexpected viewer path');
    const bytes = fs.readFileSync(file).toString('base64');
    fs.appendFileSync(path.join(profile, 'opened-files.jsonl'), JSON.stringify({ file, bytes }) + '\n');
    fs.unlinkSync(file);
    return JSON.parse(fs.readFileSync(control, 'utf8')).openError || '';
};
require('../../main');
