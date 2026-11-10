'use strict';

const { Arch } = require('builder-util');
const { prepareNativeDependencies } = require('./prepareNativeDependencies');

// afterExtract runs after native dependency rebuild and before app.asar is
// created. beforePack is too early: rebuild would remove the restored assets.
module.exports = context => {
    const files = prepareNativeDependencies(
        context.packager.info.appDir,
        context.electronPlatformName,
        Arch[context.arch],
    );
    if (files.length) console.log(`Prepared ${files.length} native runtime files after rebuild`);
};
