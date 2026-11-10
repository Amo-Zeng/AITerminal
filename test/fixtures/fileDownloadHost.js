'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { dialog } = require('electron');
const profile = process.env.AITERMINAL_SMOKE_USER_DATA;
if (!profile || process.env.AITERMINAL_CLIPBOARD_SMOKE !== '1') throw new Error('Isolated test profile required');
const control = path.join(profile, 'download-control.json');
dialog.showSaveDialog = async (...args) => {
    const options = args.at(-1);
    fs.appendFileSync(path.join(profile, 'download-dialogs.jsonl'), JSON.stringify(options) + '\n');
    const deadline = Date.now() + 15000;
    while (JSON.parse(fs.readFileSync(control, 'utf8')).hold) {
        if (Date.now() > deadline) throw new Error('Test save dialog was not released');
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    return { canceled: false, filePath: JSON.parse(fs.readFileSync(control, 'utf8')).destination };
};
require('../../main');
