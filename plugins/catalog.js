'use strict';
const fs = require('fs');
const path = require('path');
const bundled = ['docker-tools', 'task-notifier', 'model-policy', 'terminal-pet', 'ops-quest', 'git-time-machine'].map(name => {
    const directory = path.join(__dirname, name);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'plugin.json'), 'utf8'));
    return { ...manifest, files: { [manifest.entry]: fs.readFileSync(path.join(directory, manifest.entry), 'utf8') } };
});
module.exports = [...require('./catalog.json'), ...bundled];
