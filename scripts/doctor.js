const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { getElectronPath, assertElectronBinaryCompatible } = require('./electronBinary');

function runCheck(file) {
  const res = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (res.status !== 0) {
    process.exit(res.status == null ? 1 : res.status);
  }
}

function checkHtmlEntry(file, rendererFile) {
  const html = fs.readFileSync(file, 'utf8');
	const renderer = fs.readFileSync(rendererFile, 'utf8');
	const securityFile = path.join(path.dirname(rendererFile), 'rendererSecurity.js');
	const rendererSecurity = fs.readFileSync(securityFile, 'utf8');
  const lastHtmlClose = html.toLowerCase().lastIndexOf('</html>');
  if (lastHtmlClose === -1) {
    throw new Error(`${file}: missing </html>`);
  }
	const trailing = html.slice(lastHtmlClose + '</html>'.length).trim();
	if (trailing) {
	  throw new Error(`${file}: unexpected content after </html>`);
	}

	if (/<(?:script|link)\b[^>]+(?:src|href)=["']https?:\/\//i.test(html)) {
	  throw new Error(`${file}: remote runtime scripts/styles are forbidden; use locked local packages`);
	}
	const domPurifyIndex = html.search(/<script\b[^>]*src=["'][^"']*dompurify\/dist\/purify\.min\.js["'][^>]*>/i);
	const rendererSecurityIndex = html.search(/<script\b[^>]*src=["']rendererSecurity\.js["'][^>]*>/i);
	const rendererIndex = html.search(/<script\b[^>]*src=["']renderer\.js["'][^>]*>/i);
	if (domPurifyIndex === -1 || rendererSecurityIndex === -1 || rendererIndex === -1 ||
	    domPurifyIndex > rendererSecurityIndex || rendererSecurityIndex > rendererIndex) {
	  throw new Error(`${file}: DOMPurify and rendererSecurity.js must load before renderer.js`);
	}
	if (!/purifier\.sanitize\(/.test(rendererSecurity) || !/sanitizeRenderedHtml\(html, window\.DOMPurify\)/.test(renderer)) {
	  throw new Error(`${securityFile}: DOMPurify must sanitize rendered AI HTML`);
	}
	if (!/ALLOW_DATA_ATTR:\s*false/.test(rendererSecurity) || !/FORBID_TAGS:[\s\S]*'button'/.test(rendererSecurity)) {
	  throw new Error(`${securityFile}: untrusted AI HTML must not create renderer controls`);
	}
	if (/localStorage\.setItem\([^\n;]*(?:password|passphrase|aiApiKey|apiKey)/i.test(renderer)) {
	  throw new Error(`${rendererFile}: secrets must not be written to localStorage`);
	}
	const clipboardRendererChecks = [
	  [/function ownsActiveTerminal\(/, 'active terminal ownership guard'],
	  [/function copyTerminalSelection\([\s\S]*clipboardWriteText[\s\S]*ownsActiveTerminal\(tabId, terminal\)/, 'async terminal copy ownership checks'],
	  [/function pasteTerminalClipboard\([\s\S]*clipboardReadText[\s\S]*ownsActiveTerminal\(tabId, terminal\)[\s\S]*terminal\.paste\(result\.text\)/, 'async terminal paste ownership checks'],
	  [/terminal\.attachCustomKeyEventHandler\(/, 'xterm custom keyboard handler'],
	  [/event\.shiftKey && event\.code === 'KeyC'[\s\S]*copyTerminalSelection\(tabId, terminal\)/, 'Ctrl/Cmd+Shift+C terminal copy shortcut'],
	  [/event\.shiftKey && event\.code === 'KeyV'[\s\S]*pasteTerminalClipboard\(tabId, terminal\)/, 'Ctrl/Cmd+Shift+V terminal paste shortcut'],
	  [/event\.key === 'Enter' && terminal\.hasSelection\?\.\(\)/, 'Enter selection detection'],
	  [/copyTerminalSelection\(tabId, terminal, true\)/, 'Enter copy selection clearing path']
	];
	for (const [pattern, label] of clipboardRendererChecks) {
	  if (!pattern.test(renderer)) throw new Error(`${rendererFile}: missing ${label}`);
	}
	if (!/function sanitizeConfigForStorage[\s\S]*delete config\.password;[\s\S]*delete config\.passphrase;[\s\S]*delete config\.aiApiKey;/.test(renderer)) {
	  throw new Error(`${rendererFile}: persisted configs must strip SSH and AI credentials`);
	}
	if (/aiTakeoverOwnerTabId|hasActiveSshSession/.test(renderer)) {
	  throw new Error(`${rendererFile}: legacy single-tab takeover state is forbidden`);
	}
	if (!/function ownsTerminalTab\(/.test(renderer) ||
	    !/function withTakeoverFlowState[\s\S]*if \(!terminalTabs\.has\(tabId\)\) return undefined;/.test(renderer)) {
	  throw new Error(`${rendererFile}: async renderer state must fail closed for closed or replaced tabs`);
	}
	if (/const targetTabId = terminalTabs\.has\(tabId\) \? tabId : activeTabId/.test(renderer)) {
	  throw new Error(`${rendererFile}: closed tab flow state must never fall back to the active tab`);
	}
	if (!/aiterminal-clipboard-smoke/.test(renderer) ||
	    !/smokeQuery\.get\(['"]aiterminal-clipboard-smoke['"]\) === ['"]1['"]/.test(renderer)) {
	  throw new Error(`${rendererFile}: Electron clipboard smoke bridge must remain query-gated`);
	}
	if (/<[A-Za-z][^>]*\son[a-z]+\s*=\s*["']/i.test(html)) {
	  throw new Error(`${file}: inline DOM event handlers are forbidden; use data-action delegation`);
	}
	const cspMeta = html.match(/<meta\b(?=[^>]*\bhttp-equiv\s*=\s*(["'])Content-Security-Policy\1)[^>]*>/i)?.[0] || '';
	const cspMatch = cspMeta.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
	const csp = cspMatch ? (cspMatch[1] ?? cspMatch[2] ?? '') : '';
	const scriptDirective = csp.split(';').map((directive) => directive.trim()).find((directive) => /^script-src\b/i.test(directive));
	if (scriptDirective !== "script-src 'self'") {
	  throw new Error(`${file}: script CSP must allow only local external scripts`);
	}
	for (const forbiddenLog of [
	  /Raw content sample:/,
	  /Processed content sample:/,
	  /console\.log\(['"]Global selection:['"]\s*,\s*selection/,
	  /console\.log\([^\n;]*(?:复制成功|粘贴成功)[^\n;]*,\s*(?:selection|text)\s*\)/
	]) {
	  if (forbiddenLog.test(renderer)) throw new Error(`${rendererFile}: renderer logs must not contain terminal, clipboard, or AI content`);
	}

	const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1])
    .filter((script) => script.trim());
	if (scripts.length) throw new Error(`${file}: inline scripts are forbidden; use renderer.js`);
  for (let i = 0; i < scripts.length; i += 1) {
    try {
      // eslint-disable-next-line no-new-func
      new Function(scripts[i]);
    } catch (err) {
      throw new Error(`${file}: inline script #${i + 1} parse failed: ${err.message}`);
    }
  }
}

function checkMainSecurity(file, preloadFile) {
	const source = fs.readFileSync(file, 'utf8');
	const preload = fs.readFileSync(preloadFile, 'utf8');
	for (const required of [
	  /sandbox:\s*true/,
	  /contextIsolation:\s*true/,
	  /nodeIntegration:\s*false/,
	  /setWindowOpenHandler/,
	  /will-navigate/,
	  /setPermissionRequestHandler/
	]) {
	  if (!required.test(source)) throw new Error(`${file}: missing Electron renderer security control ${required}`);
	}
	if (!/ipcMain\.handle\(['"]terminal-execute-audited['"]/.test(source)) {
	  throw new Error(`${file}: AI terminal commands must use the main-process audited execution IPC`);
	}
	if (!/ipcMain\.handle\(['"]tab-open['"]/.test(source) || !/const connectionInfo = openTabSession\(state, tabId\)/.test(source)) {
	  throw new Error(`${file}: tab sessions must be created explicitly and never by ordinary IPC lookup`);
	}
	if (!/routeTabEvent\(/.test(source)) {
	  throw new Error(`${file}: tab-scoped renderer events must use the central router`);
	}
	if (!/sshConnectAttempt:\s*null/.test(source) || !/beginBackendLease\(connectionInfo, 'sshConnectAttempt'/.test(source)) {
	  throw new Error(`${file}: SSH handshakes must use an exclusive per-tab backend lease`);
	}
	if (!/SSH shell startup timed out\./.test(source) || !/resizeSshTerminalStream\(connectionInfo, cols, rows\)/.test(source)) {
	  throw new Error(`${file}: SSH shell startup timeout or validated resize routing is missing`);
	}
	if (/security-audit-command|securityAuditApproved/.test(source + '\n' + preload)) {
	  throw new Error('renderer-controlled security approval is forbidden');
	}
	if (!/Command contains unsupported terminal control characters/.test(source)) {
	  throw new Error(`${file}: audited direct commands must reject terminal control characters`);
	}
	if (!/terminalExecuteAudited/.test(preload)) {
	  throw new Error(`${preloadFile}: audited terminal execution API is missing`);
	}
	if (!/onMenuDownloadFile:[^\n]*callback\(payload\)/.test(preload) ||
	    !/menu-upload-files', \{[\s\S]*tabId: info\.tabId/.test(source)) {
	  throw new Error('asynchronous file-menu actions must preserve their originating tab');
	}
	if (!/terminalLocalResize:[^\n]*resolveTabId\(tabId\)/.test(preload) ||
	    !/terminalLocalStop:[^\n]*resolveTabId\(tabId\)/.test(preload)) {
	  throw new Error(`${preloadFile}: local terminal IPC must preserve explicit tab ownership`);
	}
	if (!/clipboardWriteText:[\s\S]*ipcRenderer\.invoke\(['"]clipboard-write-text['"][\s\S]*resolveTabId\(tabId\)/.test(preload) ||
	    !/clipboardReadText:[\s\S]*ipcRenderer\.invoke\(['"]clipboard-read-text['"][\s\S]*resolveTabId\(tabId\)/.test(preload)) {
	 throw new Error(`${preloadFile}: terminal clipboard IPC must preserve explicit tab ownership`);
	}
	if (!/const\s*\{[^}]*clipboard[^}]*\}\s*=\s*require\(['"]electron['"]\)/.test(source) ||
	    !/ipcMain\.handle\(['"]clipboard-write-text['"]/.test(source) ||
	    !/ipcMain\.handle\(['"]clipboard-read-text['"]/.test(source) ||
	    !/getActiveClipboardTab\(event, tabId\)/.test(source) ||
	    !/2 \* 1024 \* 1024/.test(source)) {
	 throw new Error(`${file}: main-process clipboard IPC validation or size bound is missing`);
	}
	if (!/!app\.isPackaged\s*&&\s*process\.env\.AITERMINAL_CLIPBOARD_SMOKE === ['"]1['"]/.test(source)) {
	 throw new Error(`${file}: Electron clipboard smoke bridge must be disabled in packaged builds`);
	}
}

function checkRuntimeAssets(root) {
	const assets = [
	  'node_modules/@xterm/xterm/css/xterm.css',
	  'node_modules/@xterm/xterm/lib/xterm.js',
	  'node_modules/@xterm/addon-fit/lib/addon-fit.js',
	  'node_modules/@xterm/addon-web-links/lib/addon-web-links.js',
	  'node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js',
	  'node_modules/marked/lib/marked.umd.js',
	  'node_modules/dompurify/dist/purify.min.js',
	  'node_modules/katex/dist/katex.min.js',
	  'node_modules/katex/dist/katex.min.css',
	  'node_modules/@highlightjs/cdn-assets/highlight.min.js',
	  'node_modules/@highlightjs/cdn-assets/styles/github.min.css'
	];
	for (const relative of assets) {
	  const file = path.join(root, relative);
	  if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error(`missing runtime asset: ${relative}`);
	}
}

function checkPackagePolicy(root) {
	const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
	if (packageJson.main !== 'main.js') throw new Error('package.json: main must be main.js');
	if (packageJson.license !== 'Apache-2.0') throw new Error('package.json: license must be Apache-2.0');
	if (!packageJson.dependencies?.['node-pty']) throw new Error('package.json: node-pty must be a runtime dependency');
	if (packageJson.optionalDependencies?.['node-pty']) throw new Error('package.json: node-pty must not be optional');
	if (packageJson.dependencies?.bytenode || packageJson.devDependencies?.bytenode) throw new Error('package.json: bytenode is forbidden');
	if (packageJson.dependencies?.dompurify !== '3.4.17') throw new Error('package.json: DOMPurify must remain pinned to the audited version');
	if (lock.packages?.['node_modules/dompurify']?.version !== packageJson.dependencies.dompurify) {
	  throw new Error('package-lock.json: DOMPurify version is inconsistent with package.json');
	}
	if (!packageJson.build?.files?.includes('!**/node_modules/bytenode/**')) {
	  throw new Error('package.json: package files must explicitly exclude bytenode');
	}
	if (packageJson.version !== lock.version || packageJson.version !== lock.packages?.['']?.version) {
	  throw new Error('package and lockfile versions are inconsistent');
	}
	const fuses = packageJson.build?.electronFuses || {};
	const expectedFuses = {
	  runAsNode: false,
	  enableCookieEncryption: true,
	  enableNodeOptionsEnvironmentVariable: false,
	  enableNodeCliInspectArguments: false,
	  enableEmbeddedAsarIntegrityValidation: true,
	  onlyLoadAppFromAsar: true,
	  loadBrowserProcessSpecificV8Snapshot: false,
	  grantFileProtocolExtraPrivileges: true
	};
	for (const [key, expected] of Object.entries(expectedFuses)) {
	  if (fuses[key] !== expected) throw new Error(`package.json: Electron fuse ${key} must be ${expected}`);
	}
	for (const forbidden of ['compile.js']) {
	  if (fs.existsSync(path.join(root, forbidden))) throw new Error(`${forbidden}: obsolete build path must be removed`);
	}
}

function main() {
  const args = new Set(process.argv.slice(2));
  const syntaxOnly = args.has('--syntax-only');
  const root = path.join(__dirname, '..');
	const files = ['main.js', 'preload.js', 'rendererSecurity.js', 'rendererStorage.js', 'renderer.js', 'pluginCenter.js', 'index.js'].map((f) => path.join(root, f));
	for (const directory of ['lib', 'scripts']) {
	  for (const name of fs.readdirSync(path.join(root, directory))) if (name.endsWith('.js')) files.push(path.join(root, directory, name));
	}
	const pluginFiles = (directory) => {
	  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
	    const file = path.join(directory, entry.name);
	    if (entry.isDirectory()) pluginFiles(file);
	    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(file);
	  }
	};
	pluginFiles(path.join(root, 'plugins'));
	for (const f of files) runCheck(f);
	checkHtmlEntry(path.join(root, 'index.html'), path.join(root, 'renderer.js'));
	checkMainSecurity(path.join(root, 'main.js'), path.join(root, 'preload.js'));
	checkRuntimeAssets(root);
	checkPackagePolicy(root);

  if (syntaxOnly) {
    console.log('doctor: syntax ok');
    return;
  }

  try {
    const electronPath = getElectronPath();
    assertElectronBinaryCompatible(electronPath);
  } catch (err) {
    console.error(String(err && err.message ? err.message : err));
    process.exit(1);
  }

  console.log('doctor: ok');
}

main();
