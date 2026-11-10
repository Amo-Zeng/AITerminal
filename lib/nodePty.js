'use strict';

const nodePty = require('node-pty');

// The system ConPTY shutdown path can block Electron's main thread when a
// terminal is closed during startup/output. Use the ConPTY implementation
// shipped with node-pty, which releases the pseudoconsole and closes input
// instead of forking a console-process-list helper during shutdown.
module.exports = process.platform === 'win32' ? {
    ...nodePty,
    spawn(file, args, options = {}) {
        return nodePty.spawn(file, args, { ...options, useConpty: true, useConptyDll: true });
    }
} : nodePty;
