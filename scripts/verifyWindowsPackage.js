'use strict';

const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');
const { FuseV1Options, getCurrentFuseWire } = require('@electron/fuses');

const FUSE_DISABLED = 0x30;
const FUSE_ENABLED = 0x31;

function fail(message) {
    console.error(`package verification failed: ${message}`);
    process.exit(1);
}

function existsNonEmpty(filePath) {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
}

function normalizeAsarPath(filePath) {
    return `/${String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '')}`;
}

async function main() {
    const unpackedRoot = path.resolve(process.argv[2] || path.join('release', 'win-unpacked'));
    const exe = path.join(unpackedRoot, 'AITerminal.exe');
    const resources = path.join(unpackedRoot, 'resources');
    const appAsar = path.join(resources, 'app.asar');
    const appUnpacked = path.join(resources, 'app.asar.unpacked');

    if (!existsNonEmpty(exe)) fail(`missing executable: ${exe}`);
    if (!existsNonEmpty(appAsar)) fail(`missing app.asar: ${appAsar}`);
    if (!existsNonEmpty(path.join(resources, 'LICENSE-AITerminal.txt'))) fail('project license is missing from resources');
    if (!existsNonEmpty(path.join(resources, 'THIRD_PARTY_NOTICES.md'))) fail('third-party notices are missing from resources');

    // @electron/asar joins paths with the host platform separator, so Windows
    // returns entries such as "\\main.js" while POSIX returns "/main.js".
    const files = new Set(asar.listPackage(appAsar).map(normalizeAsarPath));
    for (const required of [
        '/main.js',
        '/preload.js',
        '/rendererSecurity.js',
        '/renderer.js',
        '/rendererStorage.js',
        '/pluginCenter.js',
        '/pluginCenter.css',
        '/plugins/catalog.json',
        '/plugins/catalog.js',
        '/plugins/docker-tools/index.js',
        '/lib/pluginRuntime.js',
        '/lib/pluginHost.js',
        '/lib/pluginMcpHost.js',
        '/lib/pluginServices.js',
        '/lib/terminalNotifications.js',
        '/lib/pluginPackage.js',
        '/lib/pluginSchema.js',
        '/lib/pluginManifestV2.js',
        '/lib/pluginDiagnostics.js',
        '/node_modules/cordis/lib/index.js',
        '/lib/pluginManifest.js',
        '/lib/pluginManager.js',
        '/lib/pluginIpc.js',
        '/lib/pluginDownload.js',
        '/lib/aiClient.js',
        '/lib/aiProtocol.js',
        '/lib/localEnvironment.js',
        '/lib/nodePty.js',
        '/lib/shellCommand.js',
        '/index.html',
        '/lib/backendLease.js',
        '/lib/tabEventRouter.js',
        '/lib/tabRegistry.js',
        '/lib/terminalSize.js',
        '/lib/terminalInput.js',
        '/node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js',
        '/package.json'
    ]) {
        if (!files.has(required)) fail(`app.asar missing ${required}`);
    }
    if (files.has('/main.jsc')) fail('stale main.jsc was packaged');
    if (files.has('/node_modules/bytenode') || files.has('/compile.js')) fail('obsolete bytenode build path was packaged');

    const packagedPackage = JSON.parse(asar.extractFile(appAsar, 'package.json').toString('utf8'));
    if (packagedPackage.main !== 'main.js') fail(`unexpected main entry: ${packagedPackage.main}`);
    if (packagedPackage.license !== 'Apache-2.0') fail(`unexpected package license: ${packagedPackage.license}`);
    if (!packagedPackage.dependencies?.['node-pty']) fail('node-pty is not a runtime dependency');
    if (packagedPackage.dependencies?.dompurify !== '3.4.17') fail('DOMPurify is not pinned to the audited version');

    const mainSource = asar.extractFile(appAsar, 'main.js').toString('utf8');
    const preloadSource = asar.extractFile(appAsar, 'preload.js').toString('utf8');
	const htmlSource = asar.extractFile(appAsar, 'index.html').toString('utf8');
	const rendererSecuritySource = asar.extractFile(appAsar, 'rendererSecurity.js').toString('utf8');
	if (/script-src[^;]*'unsafe-inline'/.test(htmlSource) || /<[A-Za-z][^>]*\son[a-z]+\s*=/i.test(htmlSource)) {
	    fail('strict renderer script CSP or delegated events are missing');
	}
	if (!htmlSource.includes('rendererSecurity.js') || !rendererSecuritySource.includes('ALLOW_DATA_ATTR: false')) {
	    fail('untrusted renderer content isolation is missing');
	}
    if (!mainSource.includes("ipcMain.handle('terminal-execute-audited'")) {
        fail('main-process audited terminal execution is missing');
    }
    if (!mainSource.includes("ipcMain.handle('tab-open'") || !mainSource.includes('routeTabEvent(')) {
        fail('strict tab lifecycle or event routing is missing');
    }
    if (!mainSource.includes("beginBackendLease(connectionInfo, 'sshConnectAttempt'") ||
        !mainSource.includes('SSH shell startup timed out.') ||
        !mainSource.includes('resizeSshTerminalStream(connectionInfo, cols, rows)')) {
        fail('per-tab SSH lease, shell timeout, or validated resize handling is missing');
    }
    if (/security-audit-command|securityAuditApproved/.test(mainSource + '\n' + preloadSource)) {
        fail('renderer-controlled security approval was packaged');
    }
    const environmentSource = asar.extractFile(appAsar, 'lib/localEnvironment.js').toString('utf8');
    if (!environmentSource.includes("env.AIT_TERMINAL_WSL_DISTRO || 'Ubuntu'")) {
        fail('Windows default WSL Ubuntu configuration is missing');
    }
    if (!environmentSource.includes("['-d', environment.wsl.distro, '--cd', environment.cwd") || !mainSource.includes('terminalLaunch(environment)')) {
        fail('Windows WSL terminal arguments are missing');
    }

    const ptyRoot = path.join(appUnpacked, 'node_modules', 'node-pty');
    const conptyDirs = ['build/Release', 'build/Debug', 'prebuilds/win32-x64']
        .map(directory => path.join(ptyRoot, directory))
        .filter(directory => existsNonEmpty(path.join(directory, 'conpty.node')));
    if (!conptyDirs.length) fail('Windows x64 ConPTY native module is missing from app.asar.unpacked');
    // The runtime selects bundled ConPTY. Validate both the library and its
    // console host next to the native module in the packaged application.
    for (const directory of conptyDirs)
        for (const file of ['conpty.dll', 'OpenConsole.exe'])
            if (!existsNonEmpty(path.join(directory, 'conpty', file))) fail(`bundled ConPTY runtime is missing: ${file}`);

    const fuseWire = await getCurrentFuseWire(exe);
    const expectedFuses = new Map([
        [FuseV1Options.RunAsNode, FUSE_DISABLED],
        [FuseV1Options.EnableCookieEncryption, FUSE_ENABLED],
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FUSE_DISABLED],
        [FuseV1Options.EnableNodeCliInspectArguments, FUSE_DISABLED],
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FUSE_ENABLED],
        [FuseV1Options.OnlyLoadAppFromAsar, FUSE_ENABLED],
        [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FUSE_DISABLED],
        [FuseV1Options.GrantFileProtocolExtraPrivileges, FUSE_ENABLED]
    ]);
    for (const [fuse, expected] of expectedFuses) {
        if (fuseWire[fuse] !== expected) {
            fail(`unexpected Electron fuse ${FuseV1Options[fuse]}: ${fuseWire[fuse]}`);
        }
    }

    console.log(`package verification ok: ${unpackedRoot}`);
}

module.exports = { normalizeAsarPath };

if (require.main === module) {
    main().catch((error) => fail(error.message));
}
