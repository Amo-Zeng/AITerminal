        // --- State and Variables ---
        let isSSHConnected = false;
        let mylsLinkProvider = null;
        let currentMylsData = null;
        let term, fitAddon, webLinksAddon;
        
        // AI接管模式状态
        let isTakeoverMode = false;
        
        // 全局状态：AI是否在等待用户输入
        window.aiWaitingForUserInput = false;

        // 终端标签页管理
	        let terminalTabs = new Map(); // 存储所有终端实例
	        let activeTabId = 'tab-1';
        let tabCounter = 1;
        let workspace = null;

        function readStoredObject(key) {
            return window.AITerminalStorage.readObject(localStorage, key);
        }

        // --- DOM Elements ---
        //const terminalContainer = document.getElementById('terminalContainer');
  function getActiveTabInfo() {
    return terminalTabs.get(activeTabId);
  }

  function ownsTerminalTab(tabId, tabInfo) {
    return !!tabInfo && terminalTabs.get(tabId) === tabInfo && !tabInfo.isClosing;
  }

	  function getTabTerminal(tabId = activeTabId) {
	    return terminalTabs.get(tabId)?.terminal || null;
  }

  function writeToTerminalTab(tabId, data) {
    const targetTerm = getTabTerminal(tabId);
    if (targetTerm) targetTerm.write(data);
  }
	  function getActiveTerminalContainer() {
	    const idx = activeTabId.split('-')[1];
	    return document.getElementById(`terminalContainer-${idx}`);
	  }

	  function getTabButton(tabId) {
	    return document.querySelector(`.terminal-tab[data-tab-id="${tabId}"]`);
	  }

		  function getTabContent(tabId) {
		    return document.querySelector(`.terminal-tab-content[data-tab-id="${tabId}"]`);
		  }

			  function syncTabAiConfig(tabId = activeTabId) {
			    try {
			      const info = terminalTabs.get(tabId);
                  const savedConfig = info?.aiConfigSnapshot || readStoredObject('sshConfig');
                  if (info) info.aiConfigSnapshot = sanitizeConfigForStorage(savedConfig);
			      window.electronAPI?.aiConfigure?.(savedConfig, tabId).catch?.(() => {});
			    } catch (error) {
			      console.warn('sync tab AI config failed:', error);
			    }
			  }

			  function sanitizeConfigForStorage(input = {}) {
			    const config = input && typeof input === 'object' ? { ...input } : {};
			    delete config.password;
			    delete config.passphrase;
			    delete config.aiApiKey;
			    delete config.apiKey;
			    if (config.webhookConfig && typeof config.webhookConfig === 'object') {
			      config.webhookConfig = { ...config.webhookConfig, url: '' };
			    }
			    return config;
			  }

			  async function migrateLegacySecrets() {
			    const readObject = readStoredObject;
			    const sshConfig = readObject('sshConfig');
			    const legacyAi = readObject('aiConfig');
			    const webhookConfig = readObject('webhookConfig');
			    const profiles = readObject('configProfiles');
			    const configs = [
			      sshConfig,
			      {
			        aiApiKey: legacyAi.apiKey,
			        aiBaseUrl: legacyAi.baseUrl || sshConfig.aiBaseUrl,
			        webhookConfig
			      },
			      ...Object.values(profiles).filter((profile) => profile && typeof profile === 'object')
			    ];
			    try {
			      const result = await window.electronAPI?.secureMigrateConfigs?.(configs);
			      if (result?.success && result.persisted === false) {
			        console.warn('系统安全存储不可用；旧凭据已从浏览器存储清除，并仅保留在本次运行的主进程内存中');
			      } else if (result && !result.success) {
			        console.warn('旧凭据迁移失败，明文仍会从浏览器存储清除:', result.error);
			      }
			    } catch (error) {
			      console.warn('迁移旧凭据失败，旧明文凭据已从浏览器存储清除:', error);
			    }
			    localStorage.setItem('sshConfig', JSON.stringify(sanitizeConfigForStorage(sshConfig)));
			    const sanitizedProfiles = {};
			    for (const [name, profile] of Object.entries(profiles)) {
			      sanitizedProfiles[name] = sanitizeConfigForStorage(profile);
			    }
			    localStorage.setItem('configProfiles', JSON.stringify(sanitizedProfiles));
			    localStorage.setItem('webhookConfig', JSON.stringify({ ...webhookConfig, url: '' }));
			    localStorage.removeItem('aiConfig');
			  }

	  function isTabVisible(tabId) {
	    const content = getTabContent(tabId);
	    if (!content || !(workspace ? workspace.visible(tabId) && content.classList.contains('pane-visible') : content.classList.contains('active'))) return false;
	    const info = terminalTabs.get(tabId);
	    if (!info || !info.container) return false;
	    const rect = info.container.getBoundingClientRect();
	    return rect.width > 0 && rect.height > 0;
	  }

		  function refreshActiveConnectionState() {
		    const info = terminalTabs.get(activeTabId);
		    isSSHConnected = !!(info && info.isConnected);
		    return isSSHConnected;
		  }

		  function canSendToSsh(tabId = activeTabId) {
		    const info = terminalTabs.get(tabId);
		    return !!(info && info.isConnected);
	  }

	  function syncSshResizeForTab(tabId) {
	    const info = terminalTabs.get(tabId);
	    if (!info || !info.terminal || !window.electronAPI?.sshResize) return;
	    if (!canSendToSsh(tabId)) return;
	    const cols = info.terminal.cols;
	    const rows = info.terminal.rows;
		    if (cols > 0 && rows > 0) {
		      window.electronAPI.sshResize(cols, rows, tabId);
	    }
	  }

	  function getTabDisplayStatus(tabId, fallback = 'disconnected') {
	    const info = terminalTabs.get(tabId);
	    if (!info) return fallback;
	    if (canSendToSsh(tabId)) return 'connected';
	    if (info.sshConnecting) return 'connecting';
	    if (info.localTerminalStarting) return 'connecting';
	    if (info.localTerminalActive) return 'local';
	    return fallback;
	  }

	  function applyTabStatusClass(tabId, status) {
	    const statusElement = getTabButton(tabId)?.querySelector('.terminal-tab-status');
	    if (statusElement) statusElement.className = `terminal-tab-status ${status}`;
        workspace?.updatePane(tabId);
	  }

	  function syncLocalResizeForTab(tabId) {
	    const info = terminalTabs.get(tabId);
	    if (!info || !info.terminal || !window.electronAPI?.terminalLocalResize) return;
	    if (!info.localTerminalActive && !info.localTerminalStarting) return;
	    const cols = info.terminal.cols;
	    const rows = info.terminal.rows;
	    if (cols > 0 && rows > 0) {
	      window.electronAPI.terminalLocalResize(tabId, cols, rows).catch?.(() => {});
	    }
	  }

	  function flushLocalInputQueue(tabId) {
	    const info = terminalTabs.get(tabId);
	    if (!info || !info.localTerminalActive || !window.electronAPI?.terminalLocalSend) return;
	    const queue = info.pendingLocalInput || [];
	    info.pendingLocalInput = [];
	    for (const { data, encoding } of queue) {
	      window.electronAPI.terminalLocalSend(tabId, data, encoding).catch?.(() => {});
	    }
	  }

	  async function startLocalTerminalForTab(tabId, options = {}) {
	    const info = terminalTabs.get(tabId);
	    if (!info || !info.terminal || !window.electronAPI?.terminalLocalStart) return false;
	    if (info.isClosing || info.sshConnecting || info.pendingRemote) return false;
	    if (canSendToSsh(tabId) && !options.force) return false;
	    if (info.localTerminalActive || info.localTerminalStarting) {
	      syncLocalResizeForTab(tabId);
	      return true;
	    }

	    info.suppressNextLocalExit = false;
	    info.localTerminalStarting = true;
	    updateTabStatus(tabId, 'connecting');
	    if (tabId === activeTabId) updateStatusIndicator();

	    const cols = info.terminal.cols || 80;
	    const rows = info.terminal.rows || 24;
	    try {
	      const result = await window.electronAPI.terminalLocalStart({ tabId, cols, rows, cwd: options.cwd });
	      const latest = terminalTabs.get(tabId);
	      if (!ownsTerminalTab(tabId, info) || latest !== info || latest.sshConnecting) {
	        if (result?.success && window.electronAPI?.terminalLocalStop) {
	          window.electronAPI.terminalLocalStop(tabId).catch?.(() => {});
	        }
	        return false;
	      }

	      latest.localTerminalStarting = false;
	      latest.localTerminalActive = !!result?.success;
	      latest.localTerminalUsingPty = !!result?.usingPty;
	      latest.localTerminalShell = result?.shell || '';
	      latest.localTerminalCwd = result?.cwd || '';

	      if (result?.success) {
	        updateTabStatus(tabId, 'disconnected');
	        syncLocalResizeForTab(tabId);
	        flushLocalInputQueue(tabId);
	        return true;
	      }

	      latest.pendingLocalInput = [];
	      updateTabStatus(tabId, 'disconnected');
	      if (!canSendToSsh(tabId)) {
	        latest.terminal.write(`\r\n\x1b[31m[本地终端启动失败: ${result?.message || 'unknown error'}]\x1b[0m\r\n`);
	      }
	      return false;
    } catch (err) {
      const latest = terminalTabs.get(tabId);
      if (latest === info) {
	        latest.localTerminalStarting = false;
	        latest.localTerminalActive = false;
	        latest.pendingLocalInput = [];
	        updateTabStatus(tabId, 'disconnected');
	        if (!canSendToSsh(tabId)) {
	          latest.terminal.write(`\r\n\x1b[31m[本地终端启动失败: ${err.message}]\x1b[0m\r\n`);
	        }
	      }
	      return false;
	    } finally {
	      if (tabId === activeTabId) updateStatusIndicator();
	    }
	  }

	  function stopLocalTerminalForTab(tabId, options = {}) {
	    const info = terminalTabs.get(tabId);
	    if (!info) return;
	    if (options.suppressExit !== false) info.suppressNextLocalExit = true;
	    info.localTerminalActive = false;
	    info.localTerminalStarting = false;
	    info.pendingLocalInput = [];
	    updateTabStatus(tabId, 'disconnected');
	    if (window.electronAPI?.terminalLocalStop) {
	      window.electronAPI.terminalLocalStop(tabId).catch?.(() => {});
	    }
	  }

  function sendTerminalInput(tabId, data, options = {}) {
    if (!options.allowBackground && tabId !== activeTabId) return false;
    const info = terminalTabs.get(tabId);
    if (info?.pendingRemote) { workspace?.message('此窗格等待 SSH 连接；点击“连接 SSH”选择目标。'); return false; }
    if (!info || info.isClosing || info.sshConnecting) return false;
	    if (canSendToSsh(tabId)) {
	      window.electronAPI?.sshSendRaw?.(data, tabId, options.encoding);
      return true;
    }

    if (!window.electronAPI?.terminalLocalSend) return false;
    if (!info.localTerminalActive) {
      info.pendingLocalInput = info.pendingLocalInput || [];
      info.pendingLocalInput.push({ data, encoding: options.encoding });
      if (!info.localTerminalStarting) startLocalTerminalForTab(tabId);
      return true;
	    }

	    window.electronAPI.terminalLocalSend(tabId, data, options.encoding).then((result) => {
	      if (!result?.success && result?.code === 'NO_SESSION') {
	        const latest = terminalTabs.get(tabId);
	        if (!ownsTerminalTab(tabId, info) || latest !== info || canSendToSsh(tabId)) return;
	        latest.localTerminalActive = false;
	        latest.pendingLocalInput = latest.pendingLocalInput || [];
	        latest.pendingLocalInput.unshift({ data, encoding: options.encoding });
	        startLocalTerminalForTab(tabId);
	      }
    }).catch((err) => {
      console.warn('local terminal send failed:', err);
    });
	    return true;
	  }

  function ownsActiveTerminal(tabId, terminal) {
    const info = terminalTabs.get(tabId);
    return tabId === activeTabId && ownsTerminalTab(tabId, info) && info.terminal === terminal;
  }

  async function copyTerminalSelection(tabId, terminal, clearSelection = false) {
    if (!ownsActiveTerminal(tabId, terminal) || !terminal?.hasSelection?.()) return false;
    const selection = terminal.getSelection?.() || '';
    if (!selection) return false;
    try {
      const result = await window.electronAPI?.clipboardWriteText?.(selection, tabId);
      if (!result?.success || !ownsActiveTerminal(tabId, terminal)) return false;
      if (clearSelection) terminal.clearSelection?.();
      return true;
    } catch (error) {
      console.warn('终端复制失败:', error?.message || String(error));
      return false;
    }
  }

  async function pasteTerminalClipboard(tabId, terminal) {
    if (!ownsActiveTerminal(tabId, terminal)) return false;
    try {
      const result = await window.electronAPI?.clipboardReadText?.(tabId);
      if (!result?.success || typeof result.text !== 'string' || !ownsActiveTerminal(tabId, terminal)) return false;
      if (!result.text) return true;
      terminal.paste(result.text);
      return true;
    } catch (error) {
      console.warn('终端粘贴失败:', error?.message || String(error));
      return false;
    }
  }

	  function fitTerminalTab(tabId, options = {}) {
	    const { focus = false, syncSsh = false } = options;
	    const info = terminalTabs.get(tabId);
	    if (!info || !info.terminal || !info.fitAddon || !info.container) return false;
	    if (!isTabVisible(tabId)) return false;

	    try {
	      info.fitAddon.fit();
	      const rows = Math.max(0, (info.terminal.rows || 1) - 1);
	      info.terminal.refresh(0, rows);
	      if (focus && tabId === activeTabId) info.terminal.focus();
	      if (syncSsh) {
	        syncSshResizeForTab(tabId);
	        syncLocalResizeForTab(tabId);
	      }
	      return true;
	    } catch (err) {
	      console.warn(`fit terminal failed (${tabId}):`, err);
	      return false;
	    }
	  }

  function scheduleFitTerminalTab(tabId, options = {}) {
    const info = terminalTabs.get(tabId);
    if (!info || info.isClosing) return;
    const pending = info.pendingFitOptions || {};
    info.pendingFitOptions = {
      focus: pending.focus || options.focus,
      syncSsh: pending.syncSsh || options.syncSsh
    };
    if (info.fitFrame) return;
    info.fitFrame = requestAnimationFrame(() => {
      info.fitFrame = null;
      const fitOptions = info.pendingFitOptions;
      info.pendingFitOptions = null;
      if (ownsTerminalTab(tabId, info)) fitTerminalTab(tabId, fitOptions);
    });
  }

			  function setSshOwnerTab(tabId, connected) {
			    const info = terminalTabs.get(tabId);
			    if (info) info.isConnected = !!connected;
			    applyTabStatusClass(tabId, getTabDisplayStatus(tabId));
		    refreshActiveConnectionState();
	    updateSSHButton();
		    updateStatusIndicator();
		  }  

				  function disconnectCurrentSshSession(tabId = activeTabId) {
				    return window.electronAPI.sshDisconnect(tabId);
			  }  
        const sshButton = document.getElementById('sshButton');
        const sshModal = document.getElementById('sshModal');
        const statusIndicator = document.getElementById('statusIndicator');
        const commandInput = document.getElementById('commandInput');

        // --- Terminal Configuration ---
	        let terminalConfig = {
	            fontSize: 14,
	            fontFamily: "Consolas, 'Courier New', monospace",
	            theme: 'dark',
	            cursorStyle: 'block',
	            cursorBlink: true,
	            scrollback: 1000,
	            bellSound: false
	        };

        function getSafeTerminalFontFamily(fontFamily) {
            const raw = (fontFamily || '').trim();
            const isWindows = /Win/i.test(navigator.platform || navigator.userAgent || '');
            if (!raw || (!isWindows && /consolas/i.test(raw))) {
                // Linux/Chrome often lacks Consolas; when it falls back after xterm opens,
                // cached character metrics can be stale and fit() may stay at 80x24.
                // Prefer a real local monospace face before falling back to CSS monospace.
                return "Menlo, Monaco, 'DejaVu Sans Mono', 'Liberation Mono', 'Courier New', monospace";
            }
            return raw;
        }

        const terminalThemes = {
            dark: { background: '#11151c', foreground: '#dce3ee', cursor: '#87b9ff', selectionBackground: '#304765', black: '#242b38', red: '#f07882', green: '#8bcba4', yellow: '#e3c783', blue: '#82afff', magenta: '#baa5e8', cyan: '#7cc9d5', white: '#dce3ee' },
            light: { background: '#ffffff', foreground: '#233047', cursor: '#3979d7', selectionBackground: '#d8e7fb', black: '#233047', red: '#b43b46', green: '#287044', yellow: '#855c0b', blue: '#245da8', magenta: '#7c4b9b', cyan: '#1e727d', white: '#68778c', brightBlack: '#69768a', brightRed: '#bd3848', brightGreen: '#247642', brightYellow: '#8e650a', brightBlue: '#286bcc', brightMagenta: '#8755af', brightCyan: '#217b89', brightWhite: '#33415a' },
            'solarized-dark': { background: '#002b36', foreground: '#839496', cursor: '#93a1a1', selectionBackground: 'rgba(147, 161, 161, 0.4)' },
            'solarized-light': { background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', selectionBackground: 'rgba(88, 110, 117, 0.4)' },
            monokai: { background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', selectionBackground: 'rgba(248, 248, 240, 0.3)' },
            dracula: { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: 'rgba(248, 248, 242, 0.3)' },
            nord: { background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', selectionBackground: 'rgba(136, 192, 208, 0.4)' },
            'one-dark': { background: '#282c34', foreground: '#abb2bf', cursor: '#abb2bf', selectionBackground: 'rgba(171, 178, 191, 0.3)' }
        };

        // --- Markdown and AI Content ---
        let markdownRenderer = null;
        let librariesLoaded = { marked: false, katex: false, hljs: false };

        // --- Initialization ---
        document.addEventListener('DOMContentLoaded', () => {
             waitForLibraries(initializeApp);
        });

        // A small event delegation layer keeps newly rendered AI controls and
        // dynamically created tabs bound without embedding command handlers in
        // their HTML strings.
        document.addEventListener('click', (event) => {
            const actionElement = event.target.closest?.('[data-action]');
            if (!actionElement) return;
            const action = actionElement.dataset.action;
            const tabId = actionElement.dataset.tabId || actionElement.closest('[data-tab-id]')?.dataset.tabId;
            if (action === 'switch-terminal-tab') {
                switchToTab(tabId);
            } else if (action === 'close-terminal-tab') {
                event.stopPropagation();
                closeTerminalTab(tabId);
            } else if (action === 'create-terminal-tab') {
                createNewTerminalTab();
            } else if (action === 'execute-special-command') {
                executeSpecialCommand();
            } else if (action === 'run-notified-command') {
                runNotifiedCommand();
            } else if (action === 'close-ai-result') {
                closeAiResult(true, tabId);
	            } else if (action === 'copy-ai-response') {
	                copyCurrentAiResponse(tabId);
	            } else if (action === 'execute-ai-suggested-command') {
	                executeAiSuggestedCommand(tabId);
            } else if (action === 'close-custom-dialog') {
                const result = actionElement.dataset.result;
                closeCustomDialog(actionElement, result === undefined ? undefined : result === 'input' ? 'input' : result === 'true');
            } else if (action === 'save-config-profile') {
                saveCurrentConfigProfile();
            } else if (action === 'delete-config-profile') {
                deleteConfigProfile();
            } else if (action === 'switch-config-tab') {
                switchTab(actionElement.dataset.target);
            } else if (action === 'previous-config-tab') {
                switchToPrevTab();
            } else if (action === 'next-config-tab') {
                switchToNextTab();
            } else if (action === 'select-private-key-file') {
                selectPrivateKeyFile();
            } else if (action === 'toggle-model-input') {
                toggleModelInput();
            } else if (action === 'test-ai-connection') {
                testAIConnection();
            } else if (action === 'test-webhook') {
                testWebhook();
            } else if (action === 'save-webhook-settings') {
                saveWebhookSettings();
            } else if (action === 'clear-webhook-url') {
                clearWebhookUrl();
            } else if (action === 'close-ssh-modal') {
                closeSSHModal();
            } else if (action === 'connect-ssh') {
                connectSSH();
            }
        });
        document.addEventListener('change', (event) => {
            const actionElement = event.target.closest?.('[data-action]');
            if (actionElement?.dataset.action === 'load-config-profile') loadConfigProfile();
        });

        function initializeApp() {
            console.log('Initializing app...');
            loadTerminalConfigEarly();
            initializeTerminal();
            workspace = new window.AITerminalWorkspace();
            setupEventListeners();
            setupMenuEventListeners();
            setupModalKeyboardShortcuts();
            
            // 确保初始状态下终端使用全宽
            const mainContent = document.querySelector('.main-content');
            if (mainContent) {
                mainContent.classList.remove('ai-active');
                console.log('Removed ai-active class to ensure full terminal width');
            }
            const startupTabId = activeTabId;
            const startupTabInfo = terminalTabs.get(startupTabId);
            migrateLegacySecrets().finally(() => {
		            const webhookConfig = readStoredObject('webhookConfig');
		            window.electronAPI?.webhookConfigure?.(webhookConfig).catch?.((error) => console.warn('Webhook 配置同步失败:', error));
                const sshConfig = readStoredObject('sshConfig');
			        if (sshConfig.host && sshConfig.username && sshConfig.rememberPassword && ownsTerminalTab(startupTabId, startupTabInfo)) {
                    scheduleAutoConnectSSH(sshConfig, startupTabId, 2000);
                }
            });
            console.log('App initialization complete');
        }

        function waitForLibraries(callback, maxAttempts = 10, attempt = 0) {
            if (attempt >= maxAttempts) {
                console.warn('Libraries failed to load after', maxAttempts, 'attempts');
                console.log('Library status:', librariesLoaded);
                callback();
                return;
            }
            checkLibrariesLoaded();
            if (librariesLoaded.marked) {
                console.log('Libraries loaded successfully:', librariesLoaded);
                initializeMarkdownRenderer();
                
                // 测试数学公式渲染
                if (librariesLoaded.katex) {
                    console.log('Testing KaTeX with sample formula...');
                    const testResult = renderMathFormula('E = mc^2', true);
                    console.log('KaTeX test result:', testResult.includes('katex') ? 'Success' : 'Failed');
                }
                
                callback();
            } else {
                console.log(`Waiting for libraries... attempt ${attempt + 1}/${maxAttempts}`, librariesLoaded);
                setTimeout(() => waitForLibraries(callback, maxAttempts, attempt + 1), 500);
            }
        }

        function loadTerminalConfigEarly() {
            const savedConfig = localStorage.getItem('terminalConfig');
            if (savedConfig) {
                try {
                    terminalConfig = window.AITerminalStorage.terminalConfig(readStoredObject('terminalConfig'), terminalConfig, terminalThemes);
                    console.log('Loaded early terminal config:', terminalConfig);
                    // 立即应用全局主题
                    updateGlobalTheme(terminalConfig.theme);
                } catch (e) {
                    console.error('Failed to load early terminal config:', e);
                }
            } else {
                // 如果没有保存的配置，应用默认主题
                updateGlobalTheme(terminalConfig.theme);
            }
        }

        function initializeTerminal() {
            // 初始化第一个标签页
            const terminalContainer = document.getElementById('terminalContainer-1');
            if (terminalContainer) {
                createTerminalTab('tab-1', '终端 1', true);
            } else {
                console.error('Terminal container not found');
            }
        }

        // 创建新的终端标签页
        function createTerminalTab(tabId, title, isActive = false, options = {}) {
            const tabNumber = tabId.split('-')[1];
            const terminalContainer = document.getElementById(`terminalContainer-${tabNumber}`);
            
            if (!terminalContainer) {
                console.error(`Terminal container not found for tab ${tabId}`);
                return;
            }

	            const newTerm = new Terminal({
	                cursorBlink: terminalConfig.cursorBlink,
	                cursorStyle: terminalConfig.cursorStyle,
	                // PTY/SSH output already carries terminal control sequences.
	                // LF must preserve the column for tmux's partial pane redraws.
	                convertEol: false,
                    allowProposedApi: true,
	                fontFamily: getSafeTerminalFontFamily(terminalConfig.fontFamily),
                fontSize: terminalConfig.fontSize,
                scrollback: terminalConfig.scrollback,
                bellSound: terminalConfig.bellSound,
                theme: terminalThemes[terminalConfig.theme] || terminalThemes.dark
            });
            
            const newFitAddon = new FitAddon.FitAddon();
            const newWebLinksAddon = new WebLinksAddon.WebLinksAddon();
            
            newTerm.loadAddon(newFitAddon);
            newTerm.loadAddon(newWebLinksAddon);
            newTerm.loadAddon(new Unicode11Addon.Unicode11Addon());
            newTerm.unicode.activeVersion = '11';
            newTerm.open(terminalContainer);

            // 添加ResizeObserver监听容器尺寸变化
            const resizeObserver = new ResizeObserver((entries) => {
                for (let entry of entries) {
                    const rect = entry.contentRect;
                    if (!rect || rect.width <= 0 || rect.height <= 0) continue;
                    scheduleFitTerminalTab(tabId, { syncSsh: true });
                }
            });
            resizeObserver.observe(terminalContainer);

            // 存储终端实例信息
            terminalTabs.set(tabId, {
                terminal: newTerm,
                fitAddon: newFitAddon,
                webLinksAddon: newWebLinksAddon,
		                isConnected: false,
		                sshConnecting: false,
		                sshConnectToken: null,
                title: title,
                connectionConfig: options.connection || null,
                pendingRemote: options.deferStart === true,
                aiConfigSnapshot: sanitizeConfigForStorage(readStoredObject('sshConfig')),
                aiControlMode: 'terminal',
                container: terminalContainer,
                resizeObserver: resizeObserver,
                sshConnection: null, // 为每个标签页独立的SSH连接做准备
                localTerminalActive: false,
                localTerminalStarting: false,
                localTerminalUsingPty: false,
                localTerminalShell: '',
                localTerminalCwd: '',
                pendingLocalInput: [],
                suppressNextLocalExit: false,
                // AI接管模式状态 - 每个标签页独立
                aiTakeoverMode: false,
                aiTakeoverHistory: [],
                aiTakeoverTask: '',
		                aiTakeoverInterrupted: false,
		                aiTakeoverStarting: false,
		                aiWaitingForUserInput: false,
		                aiStreaming: false,
		                aiStreamContent: '',
		                aiStreamListener: null,
		                aiResult: null,
		                aiResultComplete: true,
		                aiRenderingTimeout: null,
		                aiTakeoverStreamStarted: false,
		                aiTakeoverLastStreamContent: '',
		                takeoverFlowState: null,
                mylsData: null,
                mylsLinkProvider: null
            });

            // 如果是活动标签页，设置全局引用
		            if (isActive) {
                term = newTerm;
                fitAddon = newFitAddon;
                webLinksAddon = newWebLinksAddon;
		                activeTabId = tabId;
		                window.electronAPI?.setActiveTab?.(tabId);
		            }

            // 设置终端事件监听器
            setupTerminalEventListeners(tabId, newTerm);
            // Establish the real size before spawning the PTY, and coalesce
            // later layout changes into one fit per frame for this tab.
            fitTerminalTab(tabId);
            scheduleFitTerminalTab(tabId, { focus: isActive, syncSsh: true });
            const owner = terminalTabs.get(tabId);
            document.fonts.ready.then(() => {
                if (ownsTerminalTab(tabId, owner)) scheduleFitTerminalTab(tabId, { syncSsh: true });
            });

            if (options.deferStart) {
                newTerm.write('\r\n\x1b[90m已恢复 SSH 连接信息，等待连接。\x1b[0m\r\n');
                const connect = document.createElement('button'); connect.className = 'pending-connection btn btn-primary'; connect.textContent = '连接 SSH'; connect.dataset.workspaceAction = 'reconnect'; terminalContainer.parentElement.append(connect);
            } else startLocalTerminalForTab(tabId);
		            if (isActive) syncTabAiConfig(tabId);
        }

        // 为终端设置事件监听器
        function setupTerminalEventListeners(tabId, terminal) {
            // 终端输入路由：SSH拥有者标签走远程；其他情况走本地PTY终端。
            terminal.onData(data => {
                sendTerminalInput(tabId, data);
            });
            // Legacy X10/VT200 mouse reports contain bytes above 0x7f.
            // Passing these as UTF-8 changes coordinates or drops reports.
            terminal.onBinary(data => {
                sendTerminalInput(tabId, data, { encoding: 'binary' });
            });
            terminal.onResize(() => {
                syncSshResizeForTab(tabId);
                syncLocalResizeForTab(tabId);
            });

            const localMouse = (event) => event.shiftKey || terminal.modes.mouseTrackingMode === 'none';
            terminal.element.addEventListener('mousedown', (event) => {
                if (workspace && isTabVisible(tabId) && tabId !== activeTabId) switchToTab(tabId, { focus: false });
                if (event.button === 2 && localMouse(event)) {
                    // Preserve the selection instead of letting xterm move its
                    // hidden textarea under the pointer before copying.
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    terminal.focus();
                }
            }, true);
            terminal.element.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (!ownsActiveTerminal(tabId, terminal) || !localMouse(event)) return;
                if (terminal.hasSelection()) void copyTerminalSelection(tabId, terminal, true);
                else void pasteTerminalClipboard(tabId, terminal);
            }, true);
            let wheelRemainder = 0;
            terminal.attachCustomWheelEventHandler((event) => {
                if (workspace && isTabVisible(tabId) && tabId !== activeTabId) switchToTab(tabId, { focus: false });
                if (!ownsActiveTerminal(tabId, terminal)) {
                    event.preventDefault();
                    return false;
                }
                if (event.shiftKey && terminal.buffer.active.type === 'normal') {
                    const rowHeight = terminal.element.querySelector('.xterm-screen').getBoundingClientRect().height / terminal.rows;
                    const lines = event.deltaMode === 1 ? event.deltaY
                        : event.deltaMode === 2 ? event.deltaY * terminal.rows : event.deltaY / rowHeight;
                    wheelRemainder += Number.isFinite(lines) ? lines : 0;
                    const wholeLines = Math.trunc(wheelRemainder);
                    wheelRemainder -= wholeLines;
                    if (wholeLines) terminal.scrollLines(wholeLines);
                    event.preventDefault();
                    event.stopPropagation();
                    return false;
                }
                // Without mouse reporting, synthesizing arrow keys in tmux's
                // alternate screen changes shell history instead of scrolling.
                // Applications that enable mouse mode receive xterm's reports.
                if (event.shiftKey || (terminal.buffer.active.type === 'alternate' && terminal.modes.mouseTrackingMode === 'none')) {
                    event.preventDefault();
                    event.stopPropagation();
                    return false;
                }
                return true;
            });

            // Handle terminal clipboard shortcuts before xterm turns them into
            // shell input. The captured tab/terminal pair prevents late async
            // clipboard work from crossing into a newly selected tab.
            terminal.attachCustomKeyEventHandler((event) => {
                if (event.type !== 'keydown') return true;
                const copyOrPasteModifier = event.ctrlKey || event.metaKey;
                if (copyOrPasteModifier && event.shiftKey && event.code === 'KeyC') {
                    event.preventDefault();
                    event.stopPropagation();
                    void copyTerminalSelection(tabId, terminal);
                    return false;
                }
                if (copyOrPasteModifier && event.shiftKey && event.code === 'KeyV') {
                    event.preventDefault();
                    event.stopPropagation();
                    void pasteTerminalClipboard(tabId, terminal);
                    return false;
                }
                if (event.key === 'Enter' && terminal.hasSelection?.()) {
                    event.preventDefault();
                    event.stopPropagation();
                    void copyTerminalSelection(tabId, terminal, true);
                    return false;
                }
                return true;
            });
        }


        // 创建新的终端标签页
        async function createNewTerminalTab(options = {}) {
            tabCounter++;
            const tabNumber = tabCounter;
            const newTabId = `tab-${tabNumber}`;
            const newTitle = options.title || `终端 ${tabNumber}`;
	        const opened = await window.electronAPI.openTabSession(newTabId);
	        if (!opened?.success) {
	            showCustomAlert('新建标签失败', opened?.error || '主进程未能创建标签会话');
	            return;
	        }

            // 创建标签页HTML
            const tabsContainer = document.getElementById('terminalTabs');
            const newTabButton = tabsContainer.querySelector('.terminal-tab-new');
            
            const newTab = document.createElement('div');
            newTab.className = 'terminal-tab';
            newTab.setAttribute('data-tab-id', newTabId);
	        newTab.setAttribute('data-action', 'switch-terminal-tab');
            newTab.innerHTML = `
                <span class="terminal-tab-title">${escapeHtml(newTitle)}</span>
                <span class="terminal-tab-status disconnected"></span>
                <button class="terminal-tab-close" data-action="close-terminal-tab" data-tab-id="${newTabId}" title="关闭标签页">×</button>
            `;
            
            tabsContainer.insertBefore(newTab, newTabButton);

            // 创建标签页内容
            const contentArea = document.querySelector('.terminal-content-area');
            const newContent = document.createElement('div');
            newContent.className = 'terminal-tab-content';
            newContent.id = `tab-content-${tabNumber}`;
            newContent.setAttribute('data-tab-id', newTabId);
            newContent.innerHTML = `
                <div class="terminal-container" id="terminalContainer-${tabNumber}">
                    <!-- Terminal will be initialized here -->
                </div>
                <div class="upload-hint">📁 拖拽文件到此处上传</div>
            `;
            
            contentArea.appendChild(newContent);

            // 创建终端实例
            createTerminalTab(newTabId, newTitle, false, options);
            workspace?.created(newTabId, options);
            setupTerminalDragDrop();

            // 切换到新标签页
            if (!options.background) switchToTab(newTabId);
            
            // 初始化AI接管按钮状态
            if (aiTakeoverManager && typeof aiTakeoverManager.updateTakeoverButtons === 'function') {
                aiTakeoverManager.updateTakeoverButtons();
            }
            return newTabId;
        }

        // 切换到指定标签页
        function switchToTab(tabId, options = {}) {
            const previousTabId = activeTabId;
            if (!terminalTabs.has(tabId)) return;
            if (previousTabId !== tabId) {
                const previous = terminalTabs.get(previousTabId);
                if (previous) previous.commandDraft = commandInput.value;
                commandInput.value = terminalTabs.get(tabId).commandDraft || '';
            }
            // 更新标签页状态
            document.querySelectorAll('.terminal-tab').forEach(tab => {
                tab.classList.remove('active');
            });
            document.querySelectorAll('.terminal-tab-content').forEach(content => {
                content.classList.remove('active');
            });

            // 激活选中的标签页
            const selectedTab = getTabButton(tabId);
            const selectedContent = getTabContent(tabId);
            
            if (selectedTab && selectedContent) {
                selectedTab.classList.add('active');
                selectedContent.classList.add('active');
                
                // 更新全局终端引用
                const tabInfo = terminalTabs.get(tabId);
                if (tabInfo) {
	                    term = tabInfo.terminal;
	                    fitAddon = tabInfo.fitAddon;
	                    webLinksAddon = tabInfo.webLinksAddon;
	                    currentMylsData = tabInfo.mylsData || null;
	                    mylsLinkProvider = tabInfo.mylsLinkProvider || null;
			                    activeTabId = tabId;
		                    window.electronAPI?.setActiveTab?.(tabId);
			                    syncTabAiConfig(tabId);
                    refreshActiveConnectionState();
                    updateSSHButton();
                    updateStatusIndicator();
                    
                    // 更新AI接管模式状态
		                    isTakeoverMode = tabInfo.aiTakeoverMode;
		                    window.aiWaitingForUserInput = !!tabInfo.aiWaitingForUserInput;
		                    if (aiTakeoverManager && typeof aiTakeoverManager.updateTakeoverButtons === 'function') {
		                        aiTakeoverManager.updateTakeoverButtons();
		                    }
		                    if (aiTakeoverManager && typeof aiTakeoverManager.switchTab === 'function') {
		                        aiTakeoverManager.switchTab(tabId);
		                    }
		                    syncAiResultPanelForTab(tabId);
                    
                    // 先让其他终端失焦，避免输入落到隐藏终端
                    terminalTabs.forEach((info, id) => {
                        if (id !== tabId && info && info.terminal && typeof info.terminal.blur === 'function') {
                            try { info.terminal.blur(); } catch {}
                        }
                    });

                        workspace?.selected(tabId, previousTabId);
	                    scheduleFitTerminalTab(tabId, { focus: options.focus !== false, syncSsh: true });
	            }
	        }
	    }

        // 关闭终端标签页
        function closeTerminalTab(tabId) {
            const tabInfo = terminalTabs.get(tabId);
            if (!tabInfo) return;

            // 如果只有一个标签页，不允许关闭
            if (terminalTabs.size <= 1) {
                showCustomAlert('提示', '至少需要保留一个标签页！');
                return;
            }

            // 如果有SSH连接，询问是否确认关闭
            if (tabInfo.isConnected) {
                showCustomConfirm('确认关闭', '该标签页有活动的SSH连接，确定要关闭吗？', (confirmed) => {
                    if (confirmed) {
                        doCloseTab(tabId);
                    }
                });
            } else {
                doCloseTab(tabId);
            }
        }

        // 执行关闭标签页操作
	        function doCloseTab(tabId) {
	            const tabInfo = terminalTabs.get(tabId);
                if (!tabInfo) return;
                const neighbor = workspace?.closed(tabId);
	            if (tabInfo) {
	                tabInfo.isClosing = true;
	                tabInfo.sshConnectToken = null;
	                tabInfo.sshConnecting = false;
	            }
	            if (tabInfo?.aiStreamListener) {
	                try { window.electronAPI.removeAiStreamListener(tabInfo.aiStreamListener); } catch {}
	                tabInfo.aiStreamListener = null;
	            }
	            if (tabInfo?.aiRenderingTimeout) clearTimeout(tabInfo.aiRenderingTimeout);
                if (tabInfo?.fitFrame) cancelAnimationFrame(tabInfo.fitFrame);
            
			            try { stopLocalTerminalForTab(tabId); } catch {}
			            try { window.electronAPI.closeTabSession(tabId); } catch {}

            // 销毁终端实例和ResizeObserver，避免关闭标签后仍触发隐藏终端fit/resize
	            if (tabInfo.resizeObserver) {
	                try { tabInfo.resizeObserver.disconnect(); } catch {}
	            }
	            if (tabInfo.mylsLinkProvider) {
	                try { tabInfo.mylsLinkProvider.dispose(); } catch {}
	            }
	            if (tabInfo.terminal) {
                tabInfo.terminal.dispose();
            }

            // 移除DOM元素
            const tabElement = getTabButton(tabId);
            const contentElement = getTabContent(tabId);
            
            if (tabElement) tabElement.remove();
            if (contentElement) contentElement.remove();

            // 从Map中移除
            terminalTabs.delete(tabId);

            // 如果关闭的是当前活动标签页，切换到第一个可用标签页
            if (activeTabId === tabId) {
                const firstTabId = neighbor || terminalTabs.keys().next().value;
                if (firstTabId) {
                    switchToTab(firstTabId);
                }
            } else {
                refreshActiveConnectionState();
                updateSSHButton();
                updateStatusIndicator();
            }
            workspace?.render();
        }

        // 更新标签页状态
	        function updateTabStatus(tabId, status) {
		            // 每个标签拥有独立的 SSH/AI 后端状态。
		            const tabInfo = terminalTabs.get(tabId);
		            if (tabInfo) {
		                if (status === 'connected') tabInfo.isConnected = true;
		                if (status === 'disconnected') tabInfo.isConnected = false;
                applyTabStatusClass(tabId, getTabDisplayStatus(tabId, status));
                
                // 如果是当前活动标签页，更新全局状态
                if (tabId === activeTabId) {
                    refreshActiveConnectionState();
                    updateSSHButton();
                    updateStatusIndicator();
                }
            }
	        }

        // 更新标签页标题
        function updateTabTitle(tabId, title) {
	            const tab = getTabButton(tabId);
            if (tab) {
                const titleElement = tab.querySelector('.terminal-tab-title');
                titleElement.textContent = title;
            }

            // 更新内部状态
            const tabInfo = terminalTabs.get(tabId);
            if (tabInfo) {
                tabInfo.title = title;
            }
            workspace?.updatePane(tabId);
            workspace?.renderSessions();
        }

        function setupEventListeners() {
            document.getElementById('aiControlMode')?.addEventListener('change',event=>{
                const info=getActiveTabInfo();
                if(info)info.aiControlMode=event.target.value;
                aiTakeoverManager?.updateTakeoverButtons();
            });
            window.electronAPI?.onTerminalScreenRequest?.(({requestId,tabId}) => {
                const owner = terminalTabs.get(tabId);
                const reply = (screen, error) => window.electronAPI.terminalScreenReply({requestId,tabId,screen,error});
                if (!owner || owner.isClosing) {reply(null,'终端已关闭');return;}
                owner.terminal.write('', () => {
                    if (!ownsTerminalTab(tabId,owner)) {reply(null,'终端已变化');return;}
                    const t=owner.terminal, b=t.buffer.active;
                    const read = start => Array.from({length:Math.min(t.rows,500)},(_,i)=>b.getLine(start+i)?.translateToString(true)||'').join('\n');
                    const screen=read(b.baseY), viewport=read(b.viewportY);
                    reply({title:owner.title,cols:t.cols,rows:t.rows,buffer:b.type,cursor:{x:b.cursorX,y:b.cursorY},
                        applicationCursor:t.modes.applicationCursorKeysMode,bracketedPaste:t.modes.bracketedPasteMode,
                        screen:screen.slice(0,24000),viewport:viewport.slice(0,24000),scrolled:b.viewportY!==b.baseY,truncated:screen.length>24000||viewport.length>24000});
                });
            });
	            document.addEventListener('click', (event) => {
	                const copyButton = event.target.closest('[data-renderer-control="copy-code"]');
	                if (copyButton) copyCodeBlock(copyButton);
	            });
	            // Main App Listeners - 改进的resize处理
	            window.addEventListener('resize', () => {
                    if (workspace) workspace.fit(); else scheduleFitTerminalTab(activeTabId, { syncSsh: true });
	            });
            sshButton.addEventListener('click', toggleSSH);
            commandInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') executeSpecialCommand();
            });
            // The delegated data-action handler owns the Execute button.

            // Modal Listeners
            sshModal.addEventListener('click', (e) => {
                if (e.target === sshModal) closeSSHModal();
            });

	            // Main process events carry the immutable originating tabId.
		            if (window.electronAPI?.onSshOutput) window.electronAPI.onSshOutput(payload => {
		                const targetTabId = payload?.tabId;
		                const tabInfo = terminalTabs.get(targetTabId);
		                if (tabInfo && tabInfo.terminal) {
		                    tabInfo.terminal.write(payload?.data || '');
		                }
		            });
		            
		            if (window.electronAPI?.onSshDisconnected) window.electronAPI.onSshDisconnected((payload) => {
		                const targetTabId = payload?.tabId;
		                const reason = payload?.reason || '';
		                const tabInfo = terminalTabs.get(targetTabId);
	                if (tabInfo) {
	                    tabInfo.isConnected = false;
	                    updateTabStatus(targetTabId, 'disconnected');
	                    if (tabInfo.terminal) {
	                        tabInfo.terminal.write(`\r\n\x1b[31m[SSH连接已断开: ${reason || ''}]\x1b[0m\r\n`);
	                    }
	                }
		                refreshActiveConnectionState();
	                updateSSHButton();
	                updateStatusIndicator();
	                
	                // 更新AI接管按钮状态
	                if (aiTakeoverManager) {
	                    aiTakeoverManager.updateTakeoverButtons();
	                }
	                if (tabInfo && !tabInfo.isClosing) {
                        workspace?.backendChanged(targetTabId);
	                    if (!workspace?.pendingRemote(targetTabId)) startLocalTerminalForTab(targetTabId);
	                }
	            });

	            if (window.electronAPI?.onTerminalLocalOutput) {
	                window.electronAPI.onTerminalLocalOutput((payload) => {
	                    const tabId = payload?.tabId;
	                    const data = payload?.data || '';
	                    const tabInfo = terminalTabs.get(tabId);
	                    if (!tabInfo || !tabInfo.terminal || !data || tabInfo.sshConnecting) return;
	                    // 同一 xterm 不能同时显示本地和 SSH；SSH 激活时丢弃本地后台输出，避免内容串屏。
	                    if (canSendToSsh(tabId)) return;
	                    tabInfo.terminal.write(data);
	                });
	            }

	            if (window.electronAPI?.onTerminalLocalExit) {
	                window.electronAPI.onTerminalLocalExit((payload) => {
	                    const tabId = payload?.tabId;
	                    const tabInfo = terminalTabs.get(tabId);
	                    if (!tabInfo) return;
	                    const suppress = !!tabInfo.suppressNextLocalExit;
	                    tabInfo.suppressNextLocalExit = false;
	                    tabInfo.localTerminalActive = false;
	                    tabInfo.localTerminalStarting = false;
	                    updateTabStatus(tabId, 'disconnected');
	                    if (tabId === activeTabId) updateStatusIndicator();
	                    if (!suppress && !canSendToSsh(tabId) && tabInfo.terminal) {
	                        const codePart = payload?.code === null || payload?.code === undefined ? '' : ` exit=${payload.code}`;
	                        const signalPart = payload?.signal ? ` signal=${payload.signal}` : '';
	                        tabInfo.terminal.write(`\r\n\x1b[33m[本地终端已退出${codePart}${signalPart}，按任意键会重新启动]\x1b[0m\r\n`);
	                    }
	                });
	            }

	            // Drag and Drop
	            setupDragAndDrop();

            // Cleanup listeners
            window.addEventListener('beforeunload', () => {
                if (window.electronAPI && window.electronAPI.removeAiStreamListener) {
                    window.electronAPI.removeAiStreamListener();
                }
                if (window.electronAPI && window.electronAPI.removeTerminalLocalListeners) {
                    window.electronAPI.removeTerminalLocalListeners();
                }
            });

            // 初始化常用命令功能
            setupCommonCommands();
        }

        function setupDragAndDrop() {
            const commandInput = document.getElementById('commandInput');

            // 为命令输入框设置拖拽
            if (commandInput) {
                ['dragover', 'dragleave', 'drop'].forEach(eventName => {
                    commandInput.addEventListener(eventName, (e) => e.preventDefault());
                });

	                const handleDragOver = (e, element) => {
	                    e.stopPropagation();
	                    if (canSendToSsh(activeTabId)) element.classList.add('drag-over');
	                };
                const handleDragLeave = (e, element) => {
                    e.stopPropagation();
                    element.classList.remove('drag-over');
                };
                const handleDrop = async (e, element) => {
                    e.stopPropagation();
                    element.classList.remove('drag-over');
		                    const targetTabId = activeTabId;
		                    const targetTabInfo = terminalTabs.get(targetTabId);
		                    if (!canSendToSsh(targetTabId)) return;

                    const files = e.dataTransfer.files;
                    if (files.length > 0) {
                        const localPaths = getDroppedFilePaths(files, targetTabId);
                        if (!localPaths.length) return;
		                        writeToTerminalTab(targetTabId, `\r\n\r\n\x1b[36m[正在上传 ${files.length} 个文件...]\x1b[0m\r\n`);
		                        const result = await window.electronAPI.sshDragUpload(localPaths, targetTabId);
		                        if (!ownsTerminalTab(targetTabId, targetTabInfo)) return;
		                        writeToTerminalTab(targetTabId, `\r\n${result.success ? '\x1b[32m[✅ 上传成功]' : '\x1b[31m[❌ 上传失败]'}\x1b[0m ${result.message}\r\n`);
                    }
                };

                commandInput.addEventListener('dragover', (e) => handleDragOver(e, commandInput));
                commandInput.addEventListener('dragleave', (e) => handleDragLeave(e, commandInput));
                commandInput.addEventListener('drop', (e) => handleDrop(e, commandInput));
            }

            // 为每个终端容器设置拖拽，处理函数按事件发生时的活动标签判断连接归属
            setupTerminalDragDrop();
        }

        // 为终端容器设置拖拽功能
        function setupTerminalDragDrop() {
            const terminalContainers = document.querySelectorAll('.terminal-tab-content .terminal-container');
            terminalContainers.forEach((container) => {
                if (container.dataset.dragDropReady === '1') return;
                container.dataset.dragDropReady = '1';

                ['dragover', 'dragleave', 'drop'].forEach(eventName => {
                    container.addEventListener(eventName, (e) => e.preventDefault());
                });

		                const handleDragOver = (e, element) => {
                            if (workspace?.dragged) return;
		                    e.stopPropagation();
		                    if (canSendToSsh(element.closest('[data-tab-id]')?.dataset.tabId)) element.classList.add('drag-over');
	                };
                const handleDragLeave = (e, element) => {
                    e.stopPropagation();
                    element.classList.remove('drag-over');
                };
                const handleDrop = async (e, element) => {
                    if (workspace?.dragged) return;
                    e.stopPropagation();
                    element.classList.remove('drag-over');
		                    const targetTabId = element.closest('.terminal-tab-content')?.dataset?.tabId || activeTabId;
		                    const targetTabInfo = terminalTabs.get(targetTabId);
		                    if (!canSendToSsh(targetTabId)) return;

                    const files = e.dataTransfer.files;
                    if (files.length > 0) {
                        const localPaths = getDroppedFilePaths(files, targetTabId);
                        if (!localPaths.length) return;
		                        writeToTerminalTab(targetTabId, `\r\n\r\n\x1b[36m[正在上传 ${files.length} 个文件...]\x1b[0m\r\n`);
		                        const result = await window.electronAPI.sshDragUpload(localPaths, targetTabId);
		                        if (!ownsTerminalTab(targetTabId, targetTabInfo)) return;
		                        writeToTerminalTab(targetTabId, `\r\n${result.success ? '\x1b[32m[✅ 上传成功]' : '\x1b[31m[❌ 上传失败]'}\x1b[0m ${result.message}\r\n`);
                    }
                };

                container.addEventListener('dragover', (e) => handleDragOver(e, container));
                container.addEventListener('dragleave', (e) => handleDragLeave(e, container));
                container.addEventListener('drop', (e) => handleDrop(e, container));
            });
        }

        function getDroppedFilePaths(files, tabId) {
            try {
                const paths = Array.from(files, file => window.electronAPI.getPathForFile(file));
                if (!paths.length || paths.some(path => !path)) throw new Error('请从文件管理器拖入本地文件');
                return paths;
            } catch (error) {
                writeToTerminalTab(tabId, `\r\n[无法读取拖入文件: ${error.message}]\r\n`);
                return [];
            }
        }

        // --- Special Command Handling ---
        async function executeSpecialCommand() {
            const commandTabId = activeTabId;
            const commandStr = commandInput.value.trim();
            if (!commandStr) return;
            commandInput.value = '';

            const args = [];
            const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
            let match;
            let command = null;
            while ((match = regex.exec(commandStr)) !== null) {
                const arg = match[1] || match[2] || match[0];
                if (command === null) { command = arg; } else { args.push(arg); }
            }

            if (command === 'help') {
                showHelpGuide();
                return;
            }

            // Preserve the shell payload, including quotes, spaces and pipes.
            // Dispatch before the fallback to chat and use the normal audit path.
            if (/^send(?:\s|$)/.test(commandStr)) {
                const commandToSend = commandStr.slice(4).trim();
                if (!commandToSend) {
                    writeToTerminalTab(commandTabId, '\r\n[用法: send <Shell 命令>]\r\n');
                    return;
                }
                const owner = terminalTabs.get(commandTabId);
                if (commandTabId === activeTabId) showTerminal();
                try {
                    const result = await window.electronAPI.terminalExecuteAudited(commandToSend, commandTabId);
                    if (ownsTerminalTab(commandTabId, owner) && !result?.success) {
                        writeToTerminalTab(commandTabId, `\r\n[命令未执行: ${result?.error || '未知错误'}]\r\n`);
                    }
                } catch (error) {
                    if (ownsTerminalTab(commandTabId, owner)) writeToTerminalTab(commandTabId, `\r\n[命令发送失败: ${error.message}]\r\n`);
                }
                return;
            }

            const isAiCommand = ['ai', 'ask', 'fix', 'analyze', 'cmd'].includes(command);
            const isSSHRequiredCommand = ['rfe', 'myls'].includes(command);

		    if (isSSHRequiredCommand && !canSendToSsh(commandTabId)) {
		                writeToTerminalTab(commandTabId, `\r\n\x1b[31m[错误: ${command} 命令需要SSH连接。]\x1b[0m\r\n`);
		                return;
		            }

            // 历史搜索命令
            if (command === 'search') {
	                const q = args.join(' ');
	                if (!q) {
	                    writeToTerminalTab(commandTabId, `\r\n\x1b[33m[用法] search 关键字\x1b[0m\r\n`);
	                } else {
	                    const res = await window.electronAPI.aiContextSearch(q, 30, commandTabId);
	                    if (res.success) {
	                        writeToTerminalTab(commandTabId, `\r\n\x1b[36m[搜索结果 共${res.results.length}条]\x1b[0m\r\n`);
	                        res.results.forEach((r, i) => {
	                            writeToTerminalTab(commandTabId, `${i+1}. [${r.role}] #${r.index}: ${r.snippet}\r\n`);
	                        });
	                    } else {
	                        writeToTerminalTab(commandTabId, `\r\n\x1b[31m[搜索出错: ${res.error}]\x1b[0m\r\n`);
	                    }
	                }
                return;
            }

            if (!isAiCommand && !isSSHRequiredCommand ) {
                const fullInput = [command, ...args].join(' ');
	                handleAiChat(fullInput, true, null, commandTabId); // Default to AI chat if not connected and not a special command
                return;
            }

            if (isAiCommand) {
                const useStreaming = !args.includes('--no-stream');
                const fullInput = [command, ...args.filter(a => a !== '--no-stream')].join(' ');
	                handleAiChat(fullInput, useStreaming, command, commandTabId);
                return;
            }

	            // Handle rfe/myls path
	            if ((command === 'rfe' || command === 'myls') && args.length === 0) {
	                writeToTerminalTab(commandTabId, `\r\n\x1b[36m[正在获取当前目录...]\x1b[0m\r\n`);
	                const pathResult = await window.electronAPI.sshGetCurrentPath(commandTabId);
	                if (pathResult.success) {
	                    args.push(pathResult.path);
	                    writeToTerminalTab(commandTabId, `\r\n\x1b[32m[当前目录: ${pathResult.path}]\x1b[0m\r\n`);
	                } else {
	                    args.push('/');
	                    writeToTerminalTab(commandTabId, `\r\n\x1b[31m[获取目录失败: ${pathResult.error}，使用根目录]\x1b[0m\r\n`);
	                }
	            }

	            const result = await window.electronAPI.sshExecuteSpecial(command, args, commandTabId);
	            if (!result.success) {
	                writeToTerminalTab(commandTabId, `\r\n\x1b[31m[错误: ${result.error}]\x1b[0m\r\n`);
	                return;
	            }

	            if (result.isRfeResult) renderRfeResult(result.files, result.path, commandTabId);
	            else if (result.isMylsResult) renderMylsResult(result, commandTabId);
        }

	        async function handleAiChat(fullInput, useStreaming, cmd = null, targetTabId = null) {
	            const chatTabId = targetTabId || activeTabId;
	            const chatTabInfo = terminalTabs.get(chatTabId);
	            if (!chatTabInfo) return;
	            const ownsChatTab = () => ownsTerminalTab(chatTabId, chatTabInfo);
	            if (chatTabInfo.aiStreaming) {
                writeToTerminalTab(chatTabId, '\r\n\x1b[33m[AI正在回复中，请稍候...]\x1b[0m\r\n');
                return;
            }

            const savedConfig = chatTabInfo.aiConfigSnapshot || readStoredObject('sshConfig');
            const isTerminalMode = savedConfig.aiDisplayMode === 'terminal';

            const resultHandler = (result) => { // Handles non-streaming responses and errors
	                if (!ownsChatTab()) return;
                if (result.success && result.isAiResult) {
	                    renderAiResult(result, true, chatTabId);
                } else {
                    const errorMessage = `\r\n\x1b[31m[AI错误: ${result.error || '未知错误'}]\x1b[0m\r\n`;
		                    if (isTerminalMode) writeToTerminalTab(chatTabId, errorMessage);
		                    else renderAiResult({ command: fullInput, response: result.error || '未知错误', isAiResult: true }, true, chatTabId);
                }
            };

            if (useStreaming) {
	                chatTabInfo.aiStreaming = true;
	                chatTabInfo.aiStreamContent = '';
	                if (chatTabInfo.aiStreamListener) window.electronAPI.removeAiStreamListener(chatTabInfo.aiStreamListener);
	                const streamListener = (data) => {
	                    if (data?.tabId !== chatTabId) return;
	                    if (!ownsChatTab()) {
	                        window.electronAPI.removeAiStreamListener(streamListener);
	                        return;
	                    }
	                    updateStreamingContent(data.content || '', data.isComplete, chatTabId);
	                    if (data.isComplete) {
	                        chatTabInfo.aiStreaming = false;
	                        window.electronAPI.removeAiStreamListener(streamListener);
	                        if (chatTabInfo.aiStreamListener === streamListener) chatTabInfo.aiStreamListener = null;
	                    }
	                };
	                chatTabInfo.aiStreamListener = streamListener;
	                window.electronAPI.onAiStreamUpdate(streamListener);

                // Setup UI based on display mode
	                if (isTerminalMode) {
		                    if (chatTabId === activeTabId) showTerminal();
		                    writeToTerminalTab(chatTabId, `\r\n\x1b[36m[🤖 AI回复]\x1b[0m\r\n\r\n`);
		                } else {
	                    renderAiResult({ command: fullInput, response: '', isAiResult: true }, false, chatTabId);
                }

                // Trigger the backend operation
                const result = cmd
	                    ? await window.electronAPI.sshExecuteSpecialStreaming(cmd, fullInput.split(' ').slice(1), chatTabId)
	                    : await window.electronAPI.aiChatWithoutTerm(fullInput, true, chatTabId);

                // Handle initial errors from the invoke call itself (e.g., API key not set)
                if (!ownsChatTab()) {
	                    window.electronAPI.removeAiStreamListener(streamListener);
	                    return;
	                }
                if (!result.success) {
	                    chatTabInfo.aiStreaming = false;
	                    window.electronAPI.removeAiStreamListener(streamListener);
	                    if (chatTabInfo.aiStreamListener === streamListener) chatTabInfo.aiStreamListener = null;
                    resultHandler(result);
                }
	            } else { // Non-streaming logic
		                const result = canSendToSsh(chatTabId)
		                    ? await window.electronAPI.sshExecuteSpecial('ai', fullInput.split(' ').slice(1), chatTabId)
		                    : await window.electronAPI.aiChatWithoutTerm(fullInput, false, chatTabId);
                resultHandler(result);
            }
        }

        // --- UI Rendering ---

	        function renderAiResult(result, isComplete = true, tabId = activeTabId) {
	            const tabInfo = terminalTabs.get(tabId);
	            if (!tabInfo) return;
	            tabInfo.aiResult = { ...result };
	            tabInfo.aiResultComplete = !!isComplete;
            const savedConfig = tabInfo.aiConfigSnapshot || readStoredObject('sshConfig');
            if (savedConfig.aiDisplayMode === 'terminal' && !result.forcePanel) {
                // This part is now only for NON-STREAMING results.
	                // Streaming is handled by handleAiChat and updateStreamingContent.
		                if (isComplete) { // Only render if it's a final, complete result
			                    if (tabId === activeTabId) showTerminal();
		                    writeToTerminalTab(tabId, `\r\n\x1b[36m[🤖 AI回复]\x1b[0m\r\n\r\n${result.response}\r\n`);
		                }
                return;
            }
	            if (tabId !== activeTabId) return;

            // The rest of the function handles split-screen display
            if (!isComplete) {
                // This is the streaming case for split-screen
	                renderAiResultStreaming(tabInfo.aiResult, tabId);
            } else {
                // This is the final/non-streaming case for split-screen
	                renderAiResultFinal(tabInfo.aiResult, tabId);
            }
        }

	        function renderAiResultFinal(result, tabId = activeTabId) {
	            if (tabId !== activeTabId) return;
            const mainContent = document.querySelector('.main-content');
            mainContent.classList.add('ai-active');

            const existingContainer = document.getElementById('aiResultContainer');
            if (existingContainer) existingContainer.remove();

            const aiContainer = document.createElement('div');
            aiContainer.className = 'ai-result-container';
            aiContainer.id = 'aiResultContainer';
	            aiContainer.dataset.tabId = tabId;

            let icon = '🤖', title = 'AI助手';
	            const resultCommand = result.command || '';
	            if (resultCommand.startsWith('fix')) { icon = '🔧'; title = 'AI修复建议'; }
	            else if (resultCommand.startsWith('analyze')) { icon = '📊'; title = 'AI系统分析'; }
	            else if (resultCommand.startsWith('cmd')) { icon = '⚡'; title = '自然语言命令转换'; }

	            const formattedResponse = formatAiResponse(result.response);
            const hasCommandSuggestion = result.response.includes('命令:');

            window.currentAiResult = result; // Set current result immediately

	            aiContainer.innerHTML = `
                <div class="ai-result-header">
                    <span>${icon}</span> <span>${title}</span>
                    <button class="ai-action-btn secondary close-ai-result" data-action="close-ai-result" style="margin-left: auto; padding: 4px 8px;">✕</button>
                </div>
                <div class="ai-result-content" id="aiResultContent">${formattedResponse}</div>
                <div class="ai-result-actions">
                    <button class="ai-action-btn secondary copy-ai-response" data-action="copy-ai-response">📋 复制回答</button>
                    ${hasCommandSuggestion ? `<button class="ai-action-btn primary" data-action="execute-ai-suggested-command">⚡ 执行建议命令</button>` : ''}
                    <button class="ai-action-btn secondary close-ai-result" data-action="close-ai-result">🔙 关闭</button>
	                </div>`;

                    if (workspace) workspace.aiMounted(aiContainer); else mainContent.appendChild(aiContainer);
	            enhanceAiContent(aiContainer);
        }

	        function renderAiResultStreaming(result, tabId = activeTabId) {
	            if (tabId !== activeTabId) return;
            const mainContent = document.querySelector('.main-content');
            mainContent.classList.add('ai-active');

            const existingContainer = document.getElementById('aiResultContainer');
            if (existingContainer) existingContainer.remove();

            const aiContainer = document.createElement('div');
            aiContainer.className = 'ai-result-container';
            aiContainer.id = 'aiResultContainer';
	            aiContainer.dataset.tabId = tabId;

            let icon = '🤖', title = 'AI助手';
	            const resultCommand = result.command || '';
	             if (resultCommand.startsWith('fix')) { icon = '🔧'; title = 'AI修复建议'; }
	            else if (resultCommand.startsWith('analyze')) { icon = '📊'; title = 'AI系统分析'; }
	            else if (resultCommand.startsWith('cmd')) { icon = '⚡'; title = '自然语言命令转换'; }

            aiContainer.innerHTML = `
                <div class="ai-result-header">
                    <span>${icon}</span> <span>${title}</span>
                    <div style="margin-left: auto; display: flex; align-items: center; gap: 10px;">
                        <div id="streamingIndicator" style="display: flex; align-items: center; gap: 5px; color: rgba(255,255,255,0.8); font-size: 12px;">
                            <div class="streaming-dots"><span>●</span><span>●</span><span>●</span></div>
                            <span>AI思考中...</span>
                        </div>
                        <button class="ai-action-btn secondary close-ai-result" data-action="close-ai-result" style="padding: 4px 8px;">✕</button>
                    </div>
                </div>
                <div class="ai-result-content" id="aiResultContent">
                    <div class="streaming-placeholder" style="color: var(--text-secondary); font-style: italic;">正在等待AI回复...</div>
                </div>
                <div class="ai-result-actions">
                    <button class="ai-action-btn secondary" id="copyBtn" data-action="copy-ai-response" disabled>📋 复制回答</button>
                    <button class="ai-action-btn secondary close-ai-result" data-action="close-ai-result">🔙 关闭</button>
                </div>`;

            const style = document.createElement('style');
            style.textContent = `
                .streaming-dots span { animation: streamingPulse 1.4s infinite ease-in-out; }
                .streaming-dots span:nth-child(1) { animation-delay: -0.32s; }
                .streaming-dots span:nth-child(2) { animation-delay: -0.16s; }
                @keyframes streamingPulse { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }`;
            document.head.appendChild(style);

            if (workspace) workspace.aiMounted(aiContainer); else mainContent.appendChild(aiContainer);
            window.currentAiResult = result;
        }

	        function updateStreamingContent(content, isComplete = false, tabId = activeTabId) {
	            const tabInfo = terminalTabs.get(tabId);
	            if (!tabInfo || tabInfo.isClosing) return;
	            if (tabInfo.aiResult) tabInfo.aiResult.response = content;
	            tabInfo.aiResultComplete = !!isComplete;
            const savedConfig = tabInfo.aiConfigSnapshot || readStoredObject('sshConfig');
            if (savedConfig.aiDisplayMode === 'terminal') {
	                if(getTabTerminal(tabId)) {
	                    const newContent = content.substring(tabInfo.aiStreamContent.length);
	                    writeToTerminalTab(tabId, newContent);
	                }
		                tabInfo.aiStreamContent = content;
		                if(isComplete) {
		                    writeToTerminalTab(tabId, '\r\n\x1b[32m[AI回复完成]\x1b[0m\r\n');
		                    tabInfo.aiStreamContent = '';
		                }
                return;
            }
	            if (tabId !== activeTabId) return;

            // Split-screen mode logic
	            const contentDiv = document.getElementById('aiResultContent');
	            const container = document.getElementById('aiResultContainer');
	            if (!contentDiv || container?.dataset?.tabId !== tabId) return;
	            const isCurrentPanel = () => (
	                ownsTerminalTab(tabId, tabInfo) &&
	                activeTabId === tabId &&
	                document.getElementById('aiResultContainer') === container &&
	                container.dataset.tabId === tabId
	            );

	            if (tabInfo.aiRenderingTimeout) clearTimeout(tabInfo.aiRenderingTimeout);

	            const performUpdate = () => {
	                if (!isCurrentPanel()) return;
                const wasAtBottom = contentDiv.scrollTop + contentDiv.clientHeight >= contentDiv.scrollHeight - 20;
                
                // 确保在流式渲染过程中也正确处理数学公式
                let processedContent = content;
                
                // 检查是否有未处理的占位符
                if (processedContent.includes('__MATH_BLOCK_') || processedContent.includes('__INLINE_MATH_')) {
                    console.warn('Found unprocessed math placeholders in streaming content, forcing re-render');
                    console.log('Streaming content length:', content.length);
                    processedContent = formatAiResponse(content);
                } else {
                    processedContent = formatAiResponse(content);
                }
                
                // 最终检查
                if (processedContent.includes('__MATH_BLOCK_') || processedContent.includes('__INLINE_MATH_')) {
                    console.error('Math placeholders still present after formatting!');
                    console.log('Processed content length:', processedContent.length);
                }
                
	                contentDiv.innerHTML = processedContent;
	                enhanceAiContent(contentDiv);
                if (wasAtBottom) contentDiv.scrollTop = contentDiv.scrollHeight;

	                window.currentAiResult = tabInfo.aiResult;

                if (isComplete) {
                    const streamingIndicator = container.querySelector('#streamingIndicator');
                    if (streamingIndicator) streamingIndicator.style.display = 'none';

                    const copyBtn = container.querySelector('#copyBtn');
                    if (copyBtn) {
                        copyBtn.disabled = false;
                    }

                    if (content.match(/命令:\s*([^\n\r]+)/)) {
                         const actionsDiv = contentDiv.parentElement.querySelector('.ai-result-actions');
                        if (actionsDiv && !actionsDiv.querySelector('.execute-cmd-btn')) {
                            const executeBtn = document.createElement('button');
	                            executeBtn.type = 'button';
                            executeBtn.className = 'ai-action-btn primary execute-cmd-btn';
                            executeBtn.dataset.action = 'execute-ai-suggested-command';
	                            executeBtn.dataset.tabId = tabId;
                            executeBtn.textContent = '⚡ 执行建议命令';
                            actionsDiv.insertBefore(executeBtn, actionsDiv.querySelector('.close-ai-result'));
                        }
                    }
                    
                    // 完成时再次检查并修复任何遗漏的数学公式
                    setTimeout(() => {
	                        if (!isCurrentPanel()) return;
                        const finalContent = contentDiv.innerHTML;
                        if (finalContent.includes('__MATH_BLOCK_') || finalContent.includes('__INLINE_MATH_')) {
                            console.log('Fixing remaining math placeholders...');
	                            contentDiv.innerHTML = formatAiResponse(content);
	                            enhanceAiContent(contentDiv);
                        }
                    }, 100);
                    
	                    tabInfo.aiStreaming = false;
                }
            };

            if (!isComplete) {
	                tabInfo.aiRenderingTimeout = setTimeout(performUpdate, 100);
            } else {
                performUpdate();
            }
        }

	        function syncAiResultPanelForTab(tabId) {
	            const existingContainer = document.getElementById('aiResultContainer');
	            if (existingContainer) existingContainer.remove();
	            document.querySelector('.main-content')?.classList.remove('ai-active');
                    workspace?.syncAi();
	            window.currentAiResult = null;
	            const tabInfo = terminalTabs.get(tabId);
	            const savedConfig = tabInfo?.aiConfigSnapshot || readStoredObject('sshConfig');
	            if (!tabInfo?.aiResult || (savedConfig.aiDisplayMode === 'terminal' && !tabInfo.aiResult.forcePanel)) return;
	            if (tabInfo.aiResultComplete) renderAiResultFinal(tabInfo.aiResult, tabId);
	            else {
	                renderAiResultStreaming(tabInfo.aiResult, tabId);
	                updateStreamingContent(tabInfo.aiResult.response || '', false, tabId);
	            }
	        }

        function formatAiResponse(response) {
            if (!response) return '';
            
            // 调试数学公式渲染
            if (response.includes('$') || response.includes('\\[') || response.includes('\\(')) {
                debugMathRendering(response);
            }
            
            initializeMarkdownRenderer();
            if (markdownRenderer && librariesLoaded.marked) {
                let processed = response;
                const mathBlocks = [], inlineMathBlocks = [];
                
                if(librariesLoaded.katex) {
                    // 处理块级数学公式 $$...$$
                    processed = processed.replace(/\$\$([\s\S]*?)\$\$/g, (match, formula) => {
                        const cleanFormula = formula.trim();
                        if (cleanFormula) {
                            const index = mathBlocks.length;
                            mathBlocks.push(cleanFormula);
                            console.log(`Stored math block ${index}, characters: ${cleanFormula.length}`);
                            return `MATH_BLOCK_${index}`;
                        }
                        return match;
                    });
                    
                    // 处理行内数学公式 $...$，简化正则表达式
                    processed = processed.replace(/\$([^$\n]+?)\$/g, (match, formula) => {
                        const cleanFormula = formula.trim();
                        // 避免处理代码块和已经处理过的占位符
                        if (cleanFormula && 
                            !cleanFormula.includes('`') && 
                            !cleanFormula.includes('MATH_BLOCK_') && 
                            !cleanFormula.includes('INLINE_MATH_')) {
                            const index = inlineMathBlocks.length;
                            inlineMathBlocks.push(cleanFormula);
                            console.log(`Stored inline math ${index}, characters: ${cleanFormula.length}`);
                            return `INLINE_MATH_${index}`;
                        }
                        return match;
                    });
                    
                    // 处理LaTeX风格的数学公式 \[...\] 和 \(...\)
                    processed = processed.replace(/\\\[([\s\S]*?)\\\]/g, (match, formula) => {
                        const cleanFormula = formula.trim();
                        if (cleanFormula) {
                            const index = mathBlocks.length;
                            mathBlocks.push(cleanFormula);
                            return `MATH_BLOCK_${index}`;
                        }
                        return match;
                    });
                    
                    processed = processed.replace(/\\\(([\s\S]*?)\\\)/g, (match, formula) => {
                        const cleanFormula = formula.trim();
                        if (cleanFormula) {
                            const index = inlineMathBlocks.length;
                            inlineMathBlocks.push(cleanFormula);
                            return `INLINE_MATH_${index}`;
                        }
                        return match;
                    });
                }
                
	                let html = sanitizeRenderedHtml(markdownRenderer.parse(processed));
                
                if(librariesLoaded.katex) {
                    // 渲染块级数学公式
                    html = html.replace(/MATH_BLOCK_(\d+)/g, (match, index) => {
                        const idx = parseInt(index);
                        console.log(`Processing math block placeholder: ${match}, index: ${idx}`);
                        console.log(`Available math blocks: ${mathBlocks.length}`);
                        
                        if (idx >= 0 && idx < mathBlocks.length && mathBlocks[idx]) {
                            console.log(`Rendering math block ${idx}, characters: ${mathBlocks[idx].length}`);
                            return renderMathFormula(mathBlocks[idx], true);
                        }
                        console.warn(`Math block ${idx} not found, available: ${mathBlocks.length}`);
                        return `<div class="math-error">数学公式渲染失败 (块级 ${idx})</div>`;
                    });
                    
                    // 渲染行内数学公式
                    html = html.replace(/INLINE_MATH_(\d+)/g, (match, index) => {
                        const idx = parseInt(index);
                        console.log(`Processing inline math placeholder: ${match}, index: ${idx}`);
                        console.log(`Available inline math: ${inlineMathBlocks.length}`);
                        
                        if (idx >= 0 && idx < inlineMathBlocks.length && inlineMathBlocks[idx]) {
                            console.log(`Rendering inline math ${idx}, characters: ${inlineMathBlocks[idx].length}`);
                            return renderMathFormula(inlineMathBlocks[idx], false);
                        }
                        console.warn(`Inline math ${idx} not found, available: ${inlineMathBlocks.length}`);
                        return `<span class="math-error">数学公式渲染失败 (行内 ${idx})</span>`;
                    });
                } else {
                    // 如果KaTeX不可用，清理所有占位符
                    html = html.replace(/__MATH_BLOCK_(\d+)__/g, '<div class="math-error">KaTeX未加载</div>');
                    html = html.replace(/__INLINE_MATH_(\d+)__/g, '<span class="math-error">KaTeX未加载</span>');
                }
                
                // 最终清理：确保没有遗漏的占位符
                html = cleanupMathPlaceholders(html);
                
		                return sanitizeRenderedHtml(html);
	            }
	            return escapeHtml(response).replace(/\n/g, '<br>');
	        }

	        function sanitizeRenderedHtml(html) {
	            return window.AITerminalRendererSecurity.sanitizeRenderedHtml(html, window.DOMPurify);
	        }

	        function sanitizeInteractiveHtml(html) {
	            return window.AITerminalRendererSecurity.sanitizeInteractiveHtml(html, window.DOMPurify);
	        }

        // 清理遗漏的数学公式占位符
        function cleanupMathPlaceholders(html) {
            // 查找剩余的占位符（现在使用无下划线格式）
            const remainingPlaceholders = html.match(/(?:MATH_BLOCK|INLINE_MATH)_\d+/g) || [];
            
            if (remainingPlaceholders.length > 0) {
                console.warn('Cleaning up remaining placeholders, count:', remainingPlaceholders.length);
                
                // 替换剩余的占位符
                html = html.replace(/MATH_BLOCK_(\d+)/g, (match, index) => {
                    return `<div class="math-error">数学公式渲染失败 (块级公式 ${index})</div>`;
                });
                
                html = html.replace(/INLINE_MATH_(\d+)/g, (match, index) => {
                    return `<span class="math-error">数学公式渲染失败 (行内公式 ${index})</span>`;
                });
            }
            
            return html;
        }

        function initializeMarkdownRenderer() {
            if (librariesLoaded.marked && !markdownRenderer) {
                markdownRenderer = new marked.Marked({ breaks: true, gfm: true });
                const renderer = new marked.Renderer();
	                renderer.code = (codeOrToken, language) => {
	                    const code = typeof codeOrToken === 'object' ? (codeOrToken.text || '') : String(codeOrToken || '');
	                    const detectedLanguage = typeof codeOrToken === 'object' ? (codeOrToken.lang || '') : (language || '');
	                    const highlighted = librariesLoaded.hljs && hljs.getLanguage(detectedLanguage)
	                        ? hljs.highlight(code, { language: detectedLanguage }).value
	                        : escapeHtml(code);
	                    const safeLanguage = String(detectedLanguage).replace(/[^A-Za-z0-9_-]/g, '');
	                    return `<div class="code-block-container"><pre><code class="hljs ${safeLanguage}">${highlighted}</code></pre></div>`;
	                };
                markdownRenderer.use({ renderer });
            }
        }

	function renderRfeResult(files, remotePath, tabId = activeTabId) {
            if (workspace) { workspace.fileResult(files, remotePath, tabId); return; }
	    const tabInfo = terminalTabs.get(tabId);
	    if (!tabInfo) return;

	    const container = tabInfo.container;
	    if (!container) return;

	    container.innerHTML = '';
	    const view = document.createElement('div');
	    view.className = 'view-container rfe-output';
	    const header = document.createElement('div');
	    header.className = 'view-header';
	    const title = document.createElement('h3');
	    title.textContent = `📁 目录: ${remotePath}`;
	    const backButton = document.createElement('button');
	    backButton.className = 'btn btn-primary';
	    backButton.textContent = '🔙 返回终端';
	    backButton.addEventListener('click', () => { if (activeTabId === tabId) showTerminal(); });
	    header.append(title, backButton);
	    view.appendChild(header);
	    files.forEach(file => {
	      const item = document.createElement('a');
	      item.href = '#';
	      item.onclick = (e) => { e.preventDefault(); handleRfeClick(remotePath, file.name, file.isDirectory, tabId); };
	      const icon = document.createElement('span');
	      icon.style.cssText = 'display:inline-block; width:25px;';
	      icon.textContent = file.isDirectory ? '📁' : '📄';
	      item.append(icon, document.createTextNode(` ${file.name}`));
	      view.appendChild(item);
	    });
	    container.appendChild(view);
	}
	        function renderMylsResult(data, tabId = activeTabId) {
	            if (activeTabId === tabId) showTerminal();
	            const tabInfo = terminalTabs.get(tabId);
	            if (!tabInfo) return;
	            tabInfo.mylsData = data;
	            if (activeTabId === tabId) currentMylsData = data;
            if (tabInfo.mylsLinkProvider) tabInfo.mylsLinkProvider.dispose();

            const fileRegex = new RegExp(`(${data.fileList.map(f => f.replace(/([.*+?^${}()|\[\]\/\\])/g, "\\$1")).join('|')})`, 'g');
            tabInfo.mylsLinkProvider = tabInfo.terminal.registerLinkProvider({
                provideLinks: (bufferLineNumber, callback) => {
                    const line = tabInfo.terminal.buffer.active.getLine(bufferLineNumber - 1);
                    if (!line) { callback([]); return; }
                    const links = [];
                    let match;
                    while ((match = fileRegex.exec(line.translateToString())) !== null) {
                        const filename = match[1];
                        if (data.fileList.includes(filename)) {
                            links.push({
                                range: { start: { x: match.index + 1, y: bufferLineNumber }, end: { x: match.index + filename.length, y: bufferLineNumber } },
                                text: filename,
	                            activate: (_event, text) => handleFileClick(text, tabId)
                            });
                        }
                    }
                    callback(links);
                }
            });
	            if (activeTabId === tabId) mylsLinkProvider = tabInfo.mylsLinkProvider;
	            writeToTerminalTab(tabId, '\r\n' + data.rawOutput + '\r\n\r\n💡 \x1b[1;36m提示:\x1b[0m 点击文件名可下载并打开文件\r\n');
        }

  function showTerminal() {
	    closeAiResult(false);
    const tabInfo = getActiveTabInfo();
    if (!tabInfo) return;

    const container = tabInfo.container || getActiveTerminalContainer();
    if (!container) return;

    // 如果容器内还没有 xterm 的 DOM，就重新挂载
    if (!container.querySelector('.xterm')) {
      tabInfo.terminal.open(container);
    }

    // 确保可见，避免 fit 取到 0 宽高
    container.style.visibility = 'visible';
    container.style.display = 'block';

	    scheduleFitTerminalTab(activeTabId, { focus: true, syncSsh: true });
	  }  
        //function showTerminal() {
        //    closeAiResult();
        //    if (terminalContainer.querySelector('.xterm')) return;
        //    terminalContainer.innerHTML = '';
        //    term.open(terminalContainer);
        //    fitAddon.fit();
        //    term.focus();
        //}

        // --- UI Actions & Helpers ---
	        function copyCodeBlock(button) {
	            const codeElement = button.parentElement?.querySelector('code');
	            if (!codeElement) return;
	            const code = codeElement.textContent;
            navigator.clipboard.writeText(code).then(() => {
                button.textContent = '✅ 已复制';
                button.classList.add('copied');
                setTimeout(() => {
                    button.textContent = '📋 复制';
                    button.classList.remove('copied');
                }, 2000);
            });
        }

	        function copyCurrentAiResponse(targetTabId = null) {
	            const panel = document.getElementById('aiResultContainer');
	            const resolvedTabId = targetTabId || panel?.dataset?.tabId || activeTabId;
	            const tabInfo = terminalTabs.get(resolvedTabId);
	            const response = tabInfo?.aiResult?.response;
            if (response) {
                navigator.clipboard.writeText(response).then(() => {
	                    if (!ownsTerminalTab(resolvedTabId, tabInfo)) return;
                    writeToTerminalTab(resolvedTabId, '\r\n\x1b[32m[✅ AI回答已复制到剪贴板]\x1b[0m\r\n');
                    const copyBtn = panel?.dataset?.tabId === resolvedTabId
                        ? panel.querySelector('.ai-result-actions .copy-ai-response, .ai-result-actions button#copyBtn')
                        : null;
                    if (copyBtn) {
                        const originalText = copyBtn.innerText;
                        copyBtn.innerText = '✅ 已复制';
                        setTimeout(() => { copyBtn.innerText = originalText; }, 2000);
                    }
                });
	            }
        }

	        async function executeAiSuggestedCommand(targetTabId = null) {
	            const panel = document.getElementById('aiResultContainer');
	            const resolvedTabId = targetTabId || panel?.dataset?.tabId || activeTabId;
	            const tabInfo = terminalTabs.get(resolvedTabId);
	            const response = tabInfo?.aiResult?.response || '';
	            if (!response) return;
	            const match = response.match(/命令:\s*`{1,3}([^`]+)`{1,3}/) || response.match(/命令:\s*([^\n\r]+)/);
	            if (match && match[1]) {
	                const command = match[1].trim();
	                const result = await window.electronAPI.terminalExecuteAudited(command, resolvedTabId);
	                if (!ownsTerminalTab(resolvedTabId, tabInfo)) return;
	                if (result?.success) {
	                    if (activeTabId === resolvedTabId) showTerminal();
	                    writeToTerminalTab(resolvedTabId, `\r\n\x1b[36m[已执行AI建议命令]\x1b[0m\r\n`);
	                } else if (!result?.cancelled) {
	                    writeToTerminalTab(resolvedTabId, `\r\n\x1b[31m[AI建议命令执行失败: ${result?.error || 'unknown error'}]\x1b[0m\r\n`);
	                }
	            } else {
	                writeToTerminalTab(resolvedTabId, '\r\n\x1b[31m[❌ 无法从AI响应中提取命令]\x1b[0m\r\n');
            }
        }

        async function runNotifiedCommand() {
            const tabId = activeTabId, owner = terminalTabs.get(tabId);
            const command = commandInput.value.trim();
            if (!owner || !command || owner.notifiedCommandPending) return;
            owner.notifiedCommandPending = true;
            try {
                const result = await window.electronAPI.terminalRunNotified(command, tabId);
                if (!ownsTerminalTab(tabId, owner)) return;
                if (!result?.success) {
                    writeToTerminalTab(tabId, `\r\n[运行并通知：${result?.error || '启动失败'}]\r\n`);
                    return;
                }
                if (activeTabId === tabId) {
                    if (commandInput.value.trim() === command) commandInput.value = '';
                    showTerminal(); owner.terminal.focus();
                }
            } catch (error) {
                if (ownsTerminalTab(tabId, owner)) writeToTerminalTab(tabId, `\r\n[运行并通知：${error.message}]\r\n`);
            } finally { owner.notifiedCommandPending = false; }
        }

	        function closeAiResult(forget = true, targetTabId = null) {
	            const aiContainer = document.getElementById('aiResultContainer');
	            const panelTabId = aiContainer?.dataset?.tabId || null;
	            const resolvedTabId = targetTabId || panelTabId || activeTabId;
	            if (forget) {
	                const tabInfo = terminalTabs.get(resolvedTabId);
	                if (tabInfo) {
	                    tabInfo.aiResult = null;
	                    tabInfo.aiResultComplete = true;
	                }
	                if (resolvedTabId === activeTabId) window.currentAiResult = null;
	            }
            if (aiContainer && (!targetTabId || panelTabId === resolvedTabId)) {
                aiContainer.remove();
                workspace?.syncAi();
                const mainContent = document.querySelector('.main-content');
                if (mainContent) {
                    mainContent.classList.remove('ai-active');
                }
	                const fitTabId = activeTabId;
	                setTimeout(() => {
	                    scheduleFitTerminalTab(fitTabId, { syncSsh: true });
	                }, 100);
	            }
	        }

	        function enhanceAiContent(container) {
	            if (!container) return;
	            container.querySelectorAll('.code-block-container').forEach((block) => {
	                if (!block.querySelector('code') || block.querySelector('[data-renderer-control="copy-code"]')) return;
	                const button = document.createElement('button');
	                button.type = 'button';
	                button.className = 'copy-code-btn';
	                button.dataset.rendererControl = 'copy-code';
	                button.textContent = '📋 复制';
	                block.appendChild(button);
	            });
	        }

        //function showTerminal() {
        //    closeAiResult();
        //    // 确保当前标签页的终端可见
        //    const activeContent = document.querySelector('.terminal-tab-content.active');
        //    if (activeContent) {
        //        activeContent.style.display = 'flex';
        //    }
        //}

	        async function handleFileClick(filename, targetTabId = activeTabId) {
	            const tabInfo = terminalTabs.get(targetTabId);
	            const data = tabInfo?.mylsData;
            if (!data) return;
            let fullPath = `${data.path === '/' ? '' : data.path}/${filename}`.replace('//', '/');
	            writeToTerminalTab(targetTabId, `\r\n\x1b[32m[正在下载并打开: ${filename}...]\x1b[0m\r\n`);
	            const result = await window.electronAPI.sshDownloadAndOpen(fullPath, targetTabId);
	            writeToTerminalTab(targetTabId, `\r\n\x1b[${result.success ? '32m[成功' : '31m[错误'}: ${result.message || result.error}]\x1b[0m\r\n`);
        }

	        async function handleRfeClick(currentPath, filename, isDirectory, targetTabId = activeTabId) {
	            let fullPath = `${currentPath === '/' ? '' : currentPath}/${filename}`.replace('//', '/');
	            if (isDirectory) {
	                const result = await window.electronAPI.sshExecuteSpecial('rfe', [fullPath], targetTabId);
	                if (result?.success && result.isRfeResult) renderRfeResult(result.files, result.path, targetTabId);
	                else writeToTerminalTab(targetTabId, `\r\n\x1b[31m[目录读取失败: ${result?.error || '未知错误'}]\x1b[0m\r\n`);
            } else {
	                if (activeTabId === targetTabId) showTerminal();
	                writeToTerminalTab(targetTabId, `\r\n\x1b[32m[正在下载: ${filename}...]\x1b[0m\r\n`);
	                const result = await window.electronAPI.sshDownloadFile(fullPath, targetTabId);
	                writeToTerminalTab(targetTabId, `\r\n\x1b[${result.success ? '32m[成功' : '31m[错误'}: ${result.message || result.error}]\x1b[0m\r\n`);
            }
        }

        function checkLibrariesLoaded() {
            librariesLoaded = {
                marked: typeof marked !== 'undefined',
                katex: typeof katex !== 'undefined',
                hljs: typeof hljs !== 'undefined'
            };
            
            // 测试KaTeX是否正常工作
            if (librariesLoaded.katex) {
                try {
                    const testRender = katex.renderToString('x = 1', { throwOnError: true });
                    console.log('KaTeX library loaded and working correctly');
                    console.log('KaTeX test render length:', testRender.length);
                } catch (error) {
                    console.warn('KaTeX library loaded but not working properly:', error);
                    librariesLoaded.katex = false;
                }
            } else {
                console.warn('KaTeX library not detected. typeof katex:', typeof katex);
            }
        }

        // 改进的数学公式渲染函数
        function renderMathFormula(formula, displayMode = false) {
            console.log(`Attempting to render formula, characters: ${(formula || '').length}, displayMode: ${displayMode}`);
            console.log(`KaTeX available: ${librariesLoaded.katex}, typeof katex: ${typeof katex}`);
            
            if (!librariesLoaded.katex) {
                console.warn('KaTeX not available for formula rendering');
                return displayMode ? 
                    `<div class="math-error">KaTeX未加载: ${escapeHtml(formula || 'empty')}</div>` : 
                    `<span class="math-error">$${escapeHtml(formula || 'empty')}$</span>`;
            }
            
            if (!formula || formula.trim() === '') {
                console.warn('Empty formula provided');
                return displayMode ? 
                    `<div class="math-error">空公式</div>` : 
                    `<span class="math-error">空公式</span>`;
            }

            try {
                console.log('Calling katex.renderToString');
                const rendered = katex.renderToString(formula, {
                    displayMode: displayMode,
                    throwOnError: false,
	                    trust: false,
                    strict: false,
                    macros: {
                        "\\RR": "\\mathbb{R}",
                        "\\NN": "\\mathbb{N}",
                        "\\ZZ": "\\mathbb{Z}",
                        "\\QQ": "\\mathbb{Q}",
                        "\\CC": "\\mathbb{C}"
                    }
                });
                
                console.log('KaTeX render result length:', rendered.length);
                
                if (!rendered || rendered.trim() === '') {
                    throw new Error('KaTeX returned empty result');
                }
                
                return rendered;
            } catch (error) {
                console.error('KaTeX render error:', error?.name || 'Error');
                console.error('Error details:', {
                    name: error.name,
                    message: String(error.message || '').slice(0, 500)
                });
                
                const safeError = escapeHtml(error.message || 'unknown error');
                const errorMsg = displayMode ? 
                    `<div class="math-error">数学公式渲染错误: ${escapeHtml(formula)}<br><small>${safeError}</small></div>` :
                    `<span class="math-error" title="${safeError}">$${escapeHtml(formula)}$</span>`;
                return errorMsg;
            }
        }

        // 调试函数：检查数学公式渲染状态
        function debugMathRendering(content) {
            console.group('Math Rendering Debug');
            console.log('Original content length:', content.length);
            console.log('KaTeX loaded:', librariesLoaded.katex);
            
            const mathBlockMatches = content.match(/\$\$([\s\S]*?)\$\$/g) || [];
            const inlineMathMatches = content.match(/\$([^$\n]+?)\$/g) || [];
            const placeholderMatches = content.match(/(?:MATH_BLOCK|INLINE_MATH)_\d+/g) || [];
            
            console.log('Math blocks found:', mathBlockMatches.length);
            console.log('Inline math found:', inlineMathMatches.length);
            console.log('Placeholders found:', placeholderMatches.length);
            
            // 显示内容片段以便调试
            if (content.includes('MATH_BLOCK') || content.includes('INLINE_MATH')) {
                console.log('Content with math placeholders, characters:', content.length);
            }
            
            if (placeholderMatches.length > 0) {
                console.warn('Unprocessed placeholders detected!');
            }
            
            console.groupEnd();
        }

        // 测试数学公式渲染的函数
        function testMathRendering() {
            console.log('=== Math Rendering Test ===');
            const testContent = '这是一个测试：$x = 1$ 和 $$y = 2$$';
            console.log('Test input length:', testContent.length);
            
            const result = formatAiResponse(testContent);
            console.log('Test output length:', result.length);
            
            // 检查是否有未处理的占位符
            const hasPlaceholders = result.includes('MATH_BLOCK') || result.includes('INLINE_MATH');
            console.log('Has unprocessed placeholders:', hasPlaceholders);
            
            return result;
        }

        // 在控制台暴露测试函数
        window.testMathRendering = testMathRendering;

        // --- 常用命令功能 ---
        let commonCommandsData = [];
        let selectedCommandIndex = -1;

        function setupCommonCommands() {
            const commandInput = document.getElementById('commandInput');
            const commandDropdown = document.getElementById('commandDropdown');

            // 加载常用命令
            loadCommonCommands();

            // 监听输入事件
            commandInput.addEventListener('input', handleCommandInput);
            commandInput.addEventListener('keydown', handleCommandKeydown);

            // 点击外部关闭下拉列表
            document.addEventListener('click', (e) => {
                if (!commandInput.contains(e.target) && !commandDropdown.contains(e.target)) {
                    hideCommandDropdown();
                }
            });
        }

        function loadCommonCommands() {
            const config = readStoredObject('sshConfig');
            if (config.commonCommands) {
                commonCommandsData = config.commonCommands.split('\n')
                    .map(cmd => cmd.trim())
                    .filter(cmd => cmd.length > 0)
                    .map(cmd => ({
                        command: cmd,
                        description: getCommandDescription(cmd)
                    }));
            }
        }

        function getCommandDescription(command) {
            const descriptions = {
                'ls -la': '显示详细文件列表',
                'ps aux': '显示所有进程',
                'df -h': '显示磁盘使用情况',
                'top': '显示系统进程',
                'htop': '交互式进程查看器',
                'free -h': '显示内存使用情况',
                'netstat -tulpn': '显示网络连接',
                'systemctl status': '显示服务状态',
                'tail -f': '实时查看文件末尾',
                'grep -r': '递归搜索文本',
                'find . -name': '按名称查找文件',
                'chmod +x': '添加执行权限',
                'chown': '更改文件所有者',
                'tar -xzf': '解压tar.gz文件',
                'wget': '下载文件',
                'curl': '发送HTTP请求',
                'ssh': 'SSH连接',
                'scp': '安全复制文件',
                'rsync': '同步文件',
                'git status': '查看Git状态',
                'docker ps': '显示Docker容器',
                'nginx -t': '测试Nginx配置',
                'systemctl restart': '重启服务'
            };

            // 查找匹配的描述
            for (const [key, desc] of Object.entries(descriptions)) {
                if (command.startsWith(key)) {
                    return desc;
                }
            }
            return '自定义命令';
        }

        function handleCommandInput(e) {
            const input = e.target.value;
            
            if (input === '/') {
                showCommandDropdown();
            } else if (input.startsWith('/') && input.length > 1) {
                const searchTerm = input.substring(1).toLowerCase();
                filterAndShowCommands(searchTerm);
            } else {
                hideCommandDropdown();
            }
        }

        function handleCommandKeydown(e) {
            const dropdown = document.getElementById('commandDropdown');
            const items = dropdown.querySelectorAll('.command-dropdown-item');

            if (!dropdown.classList.contains('show') || items.length === 0) {
                return;
            }

            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    selectedCommandIndex = Math.min(selectedCommandIndex + 1, items.length - 1);
                    updateSelectedCommand(items);
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    selectedCommandIndex = Math.max(selectedCommandIndex - 1, -1);
                    updateSelectedCommand(items);
                    break;
                case 'Enter':
                    e.preventDefault();
                    if (selectedCommandIndex >= 0 && selectedCommandIndex < items.length) {
                        selectCommand(items[selectedCommandIndex].dataset.command);
                    }
                    break;
                case 'Escape':
                    e.preventDefault();
                    hideCommandDropdown();
                    break;
            }
        }

        function showCommandDropdown() {
            if (commonCommandsData.length === 0) {
                return;
            }

            const dropdown = document.getElementById('commandDropdown');
            dropdown.innerHTML = '';
            selectedCommandIndex = -1;

            commonCommandsData.forEach((item, index) => {
                const div = document.createElement('div');
                div.className = 'command-dropdown-item';
                div.dataset.command = item.command;
                div.innerHTML = `
                    <div class="command-text">${escapeHtml(item.command)}</div>
                    <div class="command-desc">${escapeHtml(item.description)}</div>
                `;
                div.addEventListener('click', () => selectCommand(item.command));
                dropdown.appendChild(div);
            });

            dropdown.classList.add('show');
        }

        function filterAndShowCommands(searchTerm) {
            const filteredCommands = commonCommandsData.filter(item => 
                item.command.toLowerCase().includes(searchTerm) ||
                item.description.toLowerCase().includes(searchTerm)
            );

            if (filteredCommands.length === 0) {
                hideCommandDropdown();
                return;
            }

            const dropdown = document.getElementById('commandDropdown');
            dropdown.innerHTML = '';
            selectedCommandIndex = -1;

            filteredCommands.forEach((item, index) => {
                const div = document.createElement('div');
                div.className = 'command-dropdown-item';
                div.dataset.command = item.command;
                
                // 高亮搜索词
                const highlightedCommand = highlightSearchTerm(item.command, searchTerm);
                const highlightedDesc = highlightSearchTerm(item.description, searchTerm);
                
                div.innerHTML = `
                    <div class="command-text">${highlightedCommand}</div>
                    <div class="command-desc">${highlightedDesc}</div>
                `;
                div.addEventListener('click', () => selectCommand(item.command));
                dropdown.appendChild(div);
            });

            dropdown.classList.add('show');
        }

        function highlightSearchTerm(text, searchTerm) {
            if (!searchTerm) return escapeHtml(text);
            
            const escapedText = escapeHtml(text);
            const escapedSearchTerm = escapeHtml(searchTerm);
            const regex = new RegExp(`(${escapedSearchTerm})`, 'gi');
            return escapedText.replace(regex, '<mark>$1</mark>');
        }

        function updateSelectedCommand(items) {
            items.forEach((item, index) => {
                item.classList.toggle('selected', index === selectedCommandIndex);
            });

            // 滚动到选中项
            if (selectedCommandIndex >= 0 && selectedCommandIndex < items.length) {
                items[selectedCommandIndex].scrollIntoView({
                    block: 'nearest',
                    behavior: 'smooth'
                });
            }
        }

        function selectCommand(command) {
            const commandInput = document.getElementById('commandInput');
            const fullCommand = 'send ' + command;
            commandInput.value = fullCommand;
            hideCommandDropdown();
            commandInput.focus();
            
            // 将光标移到末尾
            commandInput.setSelectionRange(fullCommand.length, fullCommand.length);
        }

        function hideCommandDropdown() {
            const dropdown = document.getElementById('commandDropdown');
            dropdown.classList.remove('show');
            selectedCommandIndex = -1;
        }

        // --- 模态框分页功能 ---
        let currentTabIndex = 0;
	        const tabIds = ['ssh-tab', 'ai-tab', 'terminal-tab', 'commands-tab', 'webhook-tab'];

        function switchTab(tabId) {
            // 隐藏所有标签页内容
            document.querySelectorAll('.tab-content').forEach(tab => {
                tab.classList.remove('active');
            });
            
            // 移除所有标签按钮的active状态
            document.querySelectorAll('.modal-tab').forEach(btn => {
                btn.classList.remove('active');
            });
            
            // 显示选中的标签页
            const targetTab = document.getElementById(tabId);
            const targetBtn = document.getElementById(tabId + '-btn');
            
            if (targetTab && targetBtn) {
                targetTab.classList.add('active');
                targetBtn.classList.add('active');
                
                // 更新当前标签索引
                currentTabIndex = tabIds.indexOf(tabId);
                updateTabNavigation();
            }
        }

        function switchToNextTab() {
            if (currentTabIndex < tabIds.length - 1) {
                currentTabIndex++;
                switchTab(tabIds[currentTabIndex]);
            }
        }

        function switchToPrevTab() {
            if (currentTabIndex > 0) {
                currentTabIndex--;
                switchTab(tabIds[currentTabIndex]);
            }
        }

        function updateTabNavigation() {
            const prevBtn = document.getElementById('prevTabBtn');
            const nextBtn = document.getElementById('nextTabBtn');
            const indicator = document.getElementById('tabIndicator');
            
            if (prevBtn && nextBtn && indicator) {
                prevBtn.disabled = currentTabIndex === 0;
                nextBtn.disabled = currentTabIndex === tabIds.length - 1;
                indicator.textContent = `${currentTabIndex + 1} / ${tabIds.length}`;
            }
        }

        // 键盘快捷键支持
        function setupModalKeyboardShortcuts() {
            document.addEventListener('keydown', function(e) {
                // 只在模态框打开时处理快捷键
                if (sshModal.style.display !== 'block') return;
                
                if (e.ctrlKey || e.metaKey) {
                    switch(e.key) {
                        case 'ArrowLeft':
                            e.preventDefault();
                            switchToPrevTab();
                            break;
                        case 'ArrowRight':
                            e.preventDefault();
                            switchToNextTab();
                            break;
                        case 's':
                            e.preventDefault();
                            saveCurrentConfigProfile();
                            break;
                    }
                }
                
                // Tab键切换
                if (e.key === 'Tab' && e.shiftKey) {
                    e.preventDefault();
                    switchToPrevTab();
                } else if (e.key === 'Tab' && !e.shiftKey && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'SELECT') {
                    e.preventDefault();
                    switchToNextTab();
                }
            });
        }

        function escapeHtml(text) {
            return window.AITerminalRendererSecurity.escapeHtml(text);
        }

        function escapeHtmlAttribute(text) {
            return window.AITerminalRendererSecurity.escapeHtml(text);
        }

        // 自定义对话框函数
        function showCustomAlert(title, message, callback) {
            const overlay = document.createElement('div');
            overlay.className = 'custom-dialog-overlay';
            
            overlay.innerHTML = `
                <div class="custom-dialog">
                    <div class="custom-dialog-header">
                        <h3 class="custom-dialog-title">${escapeHtml(title)}</h3>
                    </div>
                    <div class="custom-dialog-body">
                        <p class="custom-dialog-message">${escapeHtml(message)}</p>
                        <div class="custom-dialog-actions">
                            <button class="custom-dialog-btn custom-dialog-btn-primary" data-action="close-custom-dialog">确定</button>
                        </div>
                    </div>
                </div>
            `;
            
            document.body.appendChild(overlay);
            
            // 点击遮罩层关闭
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    closeCustomDialog(overlay.querySelector('button'));
                }
            });
            
            // 存储回调函数
            overlay._callback = callback;
            
            // 聚焦到按钮
            setTimeout(() => {
                overlay.querySelector('button').focus();
            }, 100);
        }

        function showCustomConfirm(title, message, callback) {
            const overlay = document.createElement('div');
            overlay.className = 'custom-dialog-overlay';
            
            overlay.innerHTML = `
                <div class="custom-dialog">
                    <div class="custom-dialog-header">
                        <h3 class="custom-dialog-title">${escapeHtml(title)}</h3>
                    </div>
                    <div class="custom-dialog-body">
                        <p class="custom-dialog-message">${escapeHtml(message)}</p>
                        <div class="custom-dialog-actions">
                            <button class="custom-dialog-btn custom-dialog-btn-secondary" data-action="close-custom-dialog" data-result="false">取消</button>
                            <button class="custom-dialog-btn custom-dialog-btn-primary" data-action="close-custom-dialog" data-result="true">确定</button>
                        </div>
                    </div>
                </div>
            `;
            
            document.body.appendChild(overlay);
            
            // 点击遮罩层关闭
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    closeCustomDialog(overlay.querySelector('button'), false);
                }
            });
            
            // 存储回调函数
            overlay._callback = callback;
            
            // 聚焦到确定按钮
            setTimeout(() => {
                overlay.querySelectorAll('button')[1].focus();
            }, 100);
        }

        function showCustomPrompt(title, message, defaultValue, callback) {
            const overlay = document.createElement('div');
            overlay.className = 'custom-dialog-overlay';
            
            overlay.innerHTML = `
                <div class="custom-dialog">
                    <div class="custom-dialog-header">
                        <h3 class="custom-dialog-title">${escapeHtml(title)}</h3>
                    </div>
                    <div class="custom-dialog-body">
                        <p class="custom-dialog-message">${escapeHtml(message)}</p>
                        <input type="text" class="custom-dialog-input" placeholder="请输入...">
                        <div class="custom-dialog-actions">
                            <button class="custom-dialog-btn custom-dialog-btn-secondary" data-action="close-custom-dialog">取消</button>
                            <button class="custom-dialog-btn custom-dialog-btn-primary" data-action="close-custom-dialog" data-result="input">确定</button>
                        </div>
                    </div>
                </div>
            `;
	        overlay.querySelector('.custom-dialog-input').value = String(defaultValue || '');
            
            document.body.appendChild(overlay);
            
            const input = overlay.querySelector('.custom-dialog-input');
            
            // 点击遮罩层关闭
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    closeCustomDialog(overlay.querySelector('button'), null);
                }
            });
            
            // 回车键确定
            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    closeCustomDialog(overlay.querySelectorAll('button')[1], 'input');
                }
            });
            
            // 存储回调函数
            overlay._callback = callback;
            
            // 聚焦到输入框并选中文本
            setTimeout(() => {
                input.focus();
                input.select();
            }, 100);
        }

        function closeCustomDialog(button, result) {
            const overlay = button.closest('.custom-dialog-overlay');
            const callback = overlay._callback;
            
            if (result === 'input') {
                const input = overlay.querySelector('.custom-dialog-input');
                result = input.value;
            }
            
            // 移除对话框
            overlay.remove();
            
            // 执行回调
            if (callback) {
                callback(result);
            }
        }

        // --- Connection & Modal Logic ---
		        function toggleSSH() {
		            if (canSendToSsh(activeTabId)) {
		                disconnectCurrentSshSession(activeTabId);
		            } else {
	                createSSHModal();
	                sshModal.style.display = 'block';
            }
        }

        function closeSSHModal() {
            sshModal.style.display = 'none';
        }

		        function updateSSHButton() {
		            const connectedHere = refreshActiveConnectionState();
		            if (connectedHere) {
		                sshButton.textContent = '断开 SSH';
		                sshButton.className = 'btn ssh-button disconnect';
		            } else {
	                sshButton.textContent = '连接 SSH';
	                sshButton.className = 'btn ssh-button connect';
	            }
	        }

	        function updateStatusIndicator() {
	            refreshActiveConnectionState();
	            const activeInfo = terminalTabs.get(activeTabId);
	            const status = isSSHConnected ? 'connected' : (activeInfo?.localTerminalActive ? 'local' : 'disconnected');
	            statusIndicator.className = `status-indicator status-${status}`;
                    workspace?.updatePane(activeTabId);
	        }

		        async function connectSSH() {
            const authMethod = document.getElementById('sshAuthMethod').value;
            const rawConfig = {
                host: document.getElementById('sshHost').value.trim(),
                port: document.getElementById('sshPort').value.trim(),
                username: document.getElementById('sshUsername').value.trim(),
                authMethod: authMethod,
                password: authMethod === 'password' ? document.getElementById('sshPassword').value : '',
                privateKeyPath: authMethod === 'privateKey' ? document.getElementById('sshPrivateKeyPath').value.trim() : '',
                passphrase: authMethod === 'privateKey' ? document.getElementById('sshPassphrase').value : '',
                rememberPassword: document.getElementById('rememberPassword').checked,
                trustServer: document.getElementById('trustServer').checked,
                autoCommand: document.getElementById('autoCommand').value.trim(),
                aiDisplayMode: document.getElementById('aiDisplayMode').value,
                aiApiKey: document.getElementById('aiApiKey').value.trim(),
                aiBaseUrl: document.getElementById('aiBaseUrl').value.trim(),
                aiApiFormat: document.getElementById('aiApiFormat').value,
                aiModel: getSelectedModel(),
                aiMaxTokens: document.getElementById('aiMaxTokens').value,
                aiTemperature: document.getElementById('aiTemperature').value,
                aiCustomRequirements: document.getElementById('aiCustomRequirements').value.trim(),
	                showFullConversation: document.getElementById('showFullConversation').checked,
	                commonCommands: document.getElementById('commonCommands').value.trim(),
	                enableAI: document.getElementById('enableAI').checked,
	                webhookConfig: getWebhookConfigFromForm()
	            };
	            const config = validateConfigData(rawConfig);
	            const ownerTabId = activeTabId;
	            const ownerTabInfo = terminalTabs.get(ownerTabId);
	            if (!ownerTabInfo || ownerTabInfo.isClosing) {
	                showCustomAlert('连接失败', '当前标签页已关闭或不可用');
	                return;
	            }


		            try {
		                await saveConfig(config, ownerTabId);
		            } catch (error) {
		                showCustomAlert('保存失败', error?.message || '配置保存失败');
		                return;
		            }
	            if (terminalTabs.get(ownerTabId) !== ownerTabInfo || ownerTabInfo.isClosing) return;
                    ownerTabInfo.connectionConfig = sanitizeConfigForStorage(config);
                    if (!config.host || !config.username) {
                        updateTerminalConfig(); loadCommonCommands(); closeSSHModal();
                        workspace?.message('设置已保存');
                        return;
                    }
                    workspace?.backendChanged(ownerTabId, { preservePins: !!ownerTabInfo.pendingRemote });
                    ownerTabInfo.pendingRemote = false;
                    getTabContent(ownerTabId)?.querySelector('.pending-connection')?.remove();
            updateTerminalConfig(); // Save and apply terminal settings
            loadCommonCommands(); // Reload common commands
            closeSSHModal();
            const ownerTerm = ownerTabInfo?.terminal || getTabTerminal(ownerTabId);
	            if (!ownerTabInfo || !ownerTerm) {
	                showCustomAlert('连接失败', '当前标签页已关闭或终端不可用');
	                return;
	            }
		            const connectToken = Symbol(`ssh-connect:${ownerTabId}`);
		            ownerTabInfo.sshConnectToken = connectToken;
		            ownerTabInfo.isConnected = false;
	                if (activeTabId === ownerTabId) showTerminal();
            if (config.enableAI && config.aiApiKey) {
                ownerTerm?.write(`\r\n\x1b[36m[🤖 AI助手已启用 - 模型: ${config.aiModel}]\x1b[0m\r\n`);
            }
            ownerTerm?.write('\r\n\x1b[36m[尝试连接SSH...]\x1b[0m\r\n');
            if (!config.host || !config.username) {
                //alert('请填写服务器地址和用户名！');
                ownerTerm?.write('\r\n\x1b[36m[配置已保存，发现服务器地址或用户名缺失]\x1b[0m\r\n');
            }

            stopLocalTerminalForTab(ownerTabId);
            updateTabStatus(ownerTabId, 'connecting');
	            ownerTabInfo.sshConnecting = true;
		            let result;
		            try {
		                result = await window.electronAPI.sshConnect(config, ownerTabId);
		            } catch (error) {
		                result = { success: false, message: error.message || String(error) };
		            }
		            if (terminalTabs.get(ownerTabId) !== ownerTabInfo || ownerTabInfo.isClosing ||
		                ownerTabInfo.sshConnectToken !== connectToken) return;
		            ownerTabInfo.sshConnectToken = null;
		            ownerTabInfo.sshConnecting = false;
		            if (result.success) {
		                setSshOwnerTab(ownerTabId, true);
		            } else {
		                setSshOwnerTab(ownerTabId, false);
	            }
	            
	            // 更新当前活动标签页的连接状态
	            ownerTabInfo.isConnected = result.success;
            
            updateSSHButton();
            updateStatusIndicator();
            
            // 更新AI接管按钮状态
            if (aiTakeoverManager) {
                aiTakeoverManager.updateTakeoverButtons();
            }

	            if (result.success) {
	                updateTabStatus(ownerTabId, 'connected');
	                updateTabTitle(ownerTabId, `${config.username}@${config.host}`);
                ownerTerm?.write(`\r\n\x1b[32m[${result.message}]\x1b[0m\r\n`);
	                scheduleFitTerminalTab(ownerTabId, { syncSsh: true });
	                if (config.autoCommand) {
                    ownerTerm?.write(`\r\n\x1b[36m[执行自动命令...]\x1b[0m\r\n`);
		                    for (const cmd of config.autoCommand.split('\n')) {
		                        if (terminalTabs.get(ownerTabId) !== ownerTabInfo || !ownerTabInfo.isConnected || ownerTabInfo.sshConnectToken) break;
		                        if (cmd.trim()) await window.electronAPI.sshSendRaw(cmd.trim() + '\r', ownerTabId);
	                    }
	                }
	            } else {
	                updateTabStatus(ownerTabId, 'disconnected');
                ownerTerm?.write(`\r\n\x1b[31m[${result.message}]\x1b[0m\r\n`);
                if (!workspace?.pendingRemote(ownerTabId)) startLocalTerminalForTab(ownerTabId);
	            }
	        }

        function createSSHModal() {
            sshModal.innerHTML = `
                <div class="modal-content">
                    <div class="modal-header">
                        <h2>🔐 配置管理</h2>
                        <div class="config-profiles">
                            <select id="configProfileSelect" data-action="load-config-profile">
                                <option value="">选择配置方案...</option>
                            </select>
                            <button class="btn btn-secondary" data-action="save-config-profile" title="保存当前配置">💾</button>
                            <button class="btn btn-secondary" data-action="delete-config-profile" title="删除选中配置">🗑️</button>
                        </div>
                    </div>
                    
                    <!-- 标签页导航 -->
                    <div class="modal-tabs">
                        <button class="modal-tab active" id="ssh-tab-btn" data-action="switch-config-tab" data-target="ssh-tab">🖥️ SSH配置</button>
                        <button class="modal-tab" id="ai-tab-btn" data-action="switch-config-tab" data-target="ai-tab">🤖 AI配置</button>
                        <button class="modal-tab" id="terminal-tab-btn" data-action="switch-config-tab" data-target="terminal-tab">🖥️ 终端配置</button>
	                        <button class="modal-tab" id="commands-tab-btn" data-action="switch-config-tab" data-target="commands-tab">⚡ 命令配置</button>
	                        <button class="modal-tab" id="webhook-tab-btn" data-action="switch-config-tab" data-target="webhook-tab">🔔 Webhook</button>
                    </div>
                    
                    <!-- 标签页导航控制 -->
                    <div class="tab-navigation">
                        <button class="nav-btn" id="prevTabBtn" data-action="previous-config-tab" disabled>◀ 上一页</button>
	                        <span class="tab-indicator" id="tabIndicator">1 / 5</span>
                        <button class="nav-btn" id="nextTabBtn" data-action="next-config-tab">下一页 ▶</button>
                    </div>

                    <div class="modal-body">
                        <!-- SSH配置标签页 -->
                        <div class="tab-content active" id="ssh-tab">
                            <div class="config-section">
                                <h3>🖥️ SSH服务器配置</h3>
                                <div class="form-group"><label>服务器地址:</label><input type="text" id="sshHost" placeholder="例如: 192.168.1.100"></div>
                                <div class="form-group"><label>端口:</label><input type="number" id="sshPort" value="22"></div>
                                <div class="form-group"><label>用户名:</label><input type="text" id="sshUsername" placeholder="例如: root"></div>
                                
                                <div class="form-group">
                                    <label>认证方式:</label>
                                    <select id="sshAuthMethod">
                                        <option value="password">密码认证</option>
                                        <option value="privateKey">私钥认证</option>
                                    </select>
                                </div>
                                
                                <div class="form-group" id="passwordGroup">
                                    <label>密码:</label>
                                    <input type="password" id="sshPassword" placeholder="输入密码">
                                </div>
                                
                                <div class="form-group" id="privateKeyGroup" style="display: none;">
                                    <label>私钥文件:</label>
                                    <div style="display: flex; gap: 10px; align-items: center;">
                                        <input type="text" id="sshPrivateKeyPath" placeholder="选择私钥文件路径" readonly style="flex: 1;">
                                        <button type="button" class="btn btn-secondary" data-action="select-private-key-file" style="padding: 8px 16px; font-size: 12px;">浏览</button>
                                    </div>
                                    <small>支持 OpenSSH 格式的私钥文件 (id_rsa, id_ed25519 等)</small>
                                </div>
                                
                                <div class="form-group" id="passphraseGroup" style="display: none;">
                                    <label>私钥密码 (如果有):</label>
                                    <input type="password" id="sshPassphrase" placeholder="私钥密码，如无密码请留空">
                                </div>
                                
                                <div class="checkbox-group"><input type="checkbox" id="rememberPassword"><label for="rememberPassword">记住认证信息并自动登录</label></div>
                                <div class="checkbox-group"><input type="checkbox" id="trustServer"><label for="trustServer">信任该服务器，减少高危命令确认</label></div>
                                <small class="form-help">仅对已核验指纹的当前 SSH 服务器生效；指纹变化仍会阻断连接。</small>
                                <div class="form-group"><label>登录后自动执行命令:</label><textarea id="autoCommand" placeholder="例如: cd /var/www\nls -la"></textarea></div>
                            </div>
                        </div>

                        <!-- AI配置标签页 -->
                        <div class="tab-content" id="ai-tab">
                            <div class="config-section">
                                <h3>🤖 AI助手配置</h3>
                                <div class="checkbox-group"><input type="checkbox" id="enableAI" checked><label for="enableAI">启用AI助手功能</label></div>
                                <div class="form-group"><label>AI回答显示方式:</label><select id="aiDisplayMode"><option value="modal">分屏显示 (推荐)</option><option value="terminal">终端显示</option></select></div>
                                <div class="form-group"><label for="aiApiKey">API密钥:</label><input type="password" id="aiApiKey" placeholder="输入所选服务的 API Key" autocomplete="off"><small>请使用与 API 地址对应的服务商密钥。</small></div>
                                <div class="form-group"><label for="aiApiFormat">API 格式:</label><select id="aiApiFormat"><option value="auto">自动（根据完整 URL 识别，默认 Chat Completions）</option><option value="chat-completions">OpenAI Chat Completions · /v1/chat/completions</option><option value="responses">OpenAI Responses · /v1/responses</option><option value="messages">Anthropic Messages · /v1/messages</option></select></div>
                                <div class="form-group"><label for="aiBaseUrl">API 地址:</label><input type="text" id="aiBaseUrl" value="https://api.openai.com"><small>支持基础地址、/v1 前缀或完整接口 URL。Messages 可填写 https://api.anthropic.com；请同时填写该服务的模型名称和 API Key。</small></div>
                                <div class="form-group"><label>AI模型:</label><div class="model-input-group"><select id="aiModel"><option value="gpt-3.5-turbo">GPT-3.5 Turbo</option><option value="gpt-4">GPT-4</option><option value="gpt-4-turbo-preview">GPT-4 Turbo</option><option value="custom">自定义...</option></select><input type="text" id="aiModelCustom" placeholder="输入自定义模型名称"><button type="button" class="model-toggle-btn" data-action="toggle-model-input" hidden=true>自定义</button></div></div>
                                <div class="form-row"><div class="form-group" style="flex:1"><label>最大Token数:</label><input type="number" id="aiMaxTokens" value="2000"></div><div class="form-group" style="flex:1"><label>温度值 (0-2):</label><input type="number" id="aiTemperature" value="0.7" step="0.1"></div></div>
                                <div class="form-group"><label>我的要求:</label><textarea id="aiCustomRequirements" placeholder="输入对AI回复的特殊要求，例如：回答简短一点、使用中文回复、专业术语解释等" rows="3"></textarea><small>这些要求将会附加到每个AI请求中，帮助AI更好地理解您的需求</small></div>
                                <div class="checkbox-group"><input type="checkbox" id="showFullConversation"><label for="showFullConversation">显示完整对话</label><small>勾选后将在AI回复中显示完整的对话历史</small></div>
                                <div class="form-group"><button type="button" class="btn btn-secondary" data-action="test-ai-connection" style="width: 100%;">🔍 测试AI连接</button><small id="testResult" style="display: none;"></small></div>
                            </div>
                        </div>

                        <!-- 终端配置标签页 -->
                        <div class="tab-content" id="terminal-tab">
                            <div class="config-section">
                                <h3>🖥️ 终端配置</h3>
                                <div class="form-row"><div class="form-group" style="flex:1"><label>字体大小:</label><input type="number" id="terminalFontSize" value="14"></div><div class="form-group" style="flex:1"><label>字体族:</label><select id="terminalFontFamily"><option value="Consolas, 'Courier New', monospace">Consolas</option><option value="'Fira Code', monospace">Fira Code</option><option value="'JetBrains Mono', monospace">JetBrains Mono</option></select></div></div>
                                <div class="form-group"><label>终端主题:</label><select id="terminalTheme"><option value="dark">Dark</option><option value="light">Light</option><option value="solarized-dark">Solarized Dark</option><option value="solarized-light">Solarized Light</option><option value="monokai">Monokai</option><option value="dracula">Dracula</option><option value="nord">Nord</option><option value="one-dark">One Dark</option></select></div>
                                <div class="form-row"><div class="form-group" style="flex:1"><label>光标样式:</label><select id="terminalCursorStyle"><option value="block">方块</option><option value="underline">下划线</option><option value="bar">竖线</option></select></div><div class="form-group" style="flex:1"><label>滚动行数:</label><input type="number" id="terminalScrollback" value="1000"></div></div>
                                <div class="checkbox-group"><input type="checkbox" id="terminalCursorBlink" checked><label for="terminalCursorBlink">光标闪烁</label></div>
                            </div>
                        </div>

                        <!-- 命令配置标签页 -->
	                    <div class="tab-content" id="commands-tab">
                            <div class="config-section">
                                <h3>⚡ 常用命令配置</h3>
                                <div class="form-group"><label>常用命令:</label><textarea id="commonCommands" placeholder="每行输入一个常用SSH命令，例如：&#10;ls -la&#10;ps aux&#10;df -h&#10;top&#10;在命令输入框中输入 / 可快速调用这些命令" rows="8"></textarea><small>在命令输入框中输入"/"可快速选择这些常用命令</small></div>
                            </div>

                        </div>

	                    <div class="tab-content" id="webhook-tab">
	                        <div class="config-section">
	                            <h3>🔔 Webhook 通知</h3>
	                            <div class="checkbox-group"><input type="checkbox" id="webhookEnabled"><label for="webhookEnabled">启用 Webhook</label></div>
                            <div class="form-group"><label>HTTPS URL:</label><div class="webhook-url-row"><input type="url" id="webhookUrl" placeholder="https://hooks.example.com/notify" autocomplete="off"><button type="button" class="btn btn-secondary" data-action="clear-webhook-url">清除</button></div><small id="webhookUrlStatus" class="webhook-url-status"></small></div>
	                            <div class="form-group"><label>通知事件:</label>
	                                <div class="checkbox-group"><input type="checkbox" id="webhookTaskStarted" checked><label for="webhookTaskStarted">任务开始</label></div>
	                                <div class="checkbox-group"><input type="checkbox" id="webhookSecurityConfirmation" checked><label for="webhookSecurityConfirmation">高危确认</label></div>
	                                <div class="checkbox-group"><input type="checkbox" id="webhookTaskCompleted" checked><label for="webhookTaskCompleted">任务完成</label></div>
	                                <div class="checkbox-group"><input type="checkbox" id="webhookTaskError" checked><label for="webhookTaskError">任务错误</label></div>
	                                <div class="checkbox-group"><input type="checkbox" id="webhookSshDisconnected" checked><label for="webhookSshDisconnected">SSH 断开</label></div>
                                    <div class="checkbox-group"><input type="checkbox" id="webhookProgramStopped" checked><label for="webhookProgramStopped">程序停止（正常结束、异常退出、被停止）</label></div>
                                    <div class="checkbox-group"><input type="checkbox" id="webhookOutputMatched"><label for="webhookOutputMatched">终端输出匹配</label></div>
	                            </div>
                                <div class="form-group"><label for="webhookOutputRules">匹配关键词（每行一条）:</label><textarea id="webhookOutputRules" rows="4" placeholder="任务完成&#10;Traceback&#10;需要确认" maxlength="4020"></textarea><small>最多 20 条，每条最多 200 字符，按字面文本匹配。支持彩色输出和分批到达的文本；规则分别作用于每个标签的本地、SSH 和 AI/插件程序输出。</small></div>
                                <div class="checkbox-group"><input type="checkbox" id="webhookOutputIgnoreCase" checked><label for="webhookOutputIgnoreCase">匹配时忽略大小写</label></div>
                                <div class="form-group"><label for="webhookOutputCooldown">同一输出来源、同一关键词的通知间隔（秒）:</label><input type="number" id="webhookOutputCooldown" min="1" max="86400" value="60"></div>
                                <div class="checkbox-group"><input type="checkbox" id="webhookIncludeOutput"><label for="webhookIncludeOutput">通知中附带匹配附近的输出片段</label></div>
                                <p class="form-help">AI/插件启动的程序自动监听退出。手动运行时，在底部输入命令（如 codex），点击“运行并通知”；请在 Shell 提示符下使用。SSH 断线会通知退出状态未知。</p>
	                            <div class="checkbox-group"><input type="checkbox" id="webhookIncludeCommand"><label for="webhookIncludeCommand">通知中包含命令文本</label></div>
	                            <div class="form-group"><label>超时 (毫秒):</label><input type="number" id="webhookTimeout" min="1000" max="30000" value="8000"></div>
	                            <div class="form-row">
	                                <button type="button" class="btn btn-secondary" data-action="test-webhook" style="flex:1;">测试</button>
	                                <button type="button" class="btn btn-primary" data-action="save-webhook-settings" style="flex:1;">保存</button>
	                            </div>
	                            <small id="webhookTestResult" style="display:none;"></small>
	                        </div>
	                    </div>
                        </div>
                    
                    <div class="modal-footer">
                        <div class="modal-actions">
                            <button class="btn" data-action="close-ssh-modal" style="background: #6c757d;">取消</button>
                            <button class="btn btn-primary" data-action="connect-ssh">🔗 连接(保存)</button>
                        </div>
                    </div>
                </div>`;
            loadSavedConfig();
            loadConfigProfiles();
            refreshWebhookSettings();
            setupServerTrustInputs();
            document.getElementById('aiModel').addEventListener('change', function() {
                if (this.value === 'custom') showCustomModelInput(); else hideCustomModelInput();
            });
            document.getElementById('sshAuthMethod').addEventListener('change', function() {
                toggleAuthMethod();
            });
        }

        // 配置方案管理功能
        function loadConfigProfiles() {
            const profiles = readStoredObject('configProfiles');
            const select = document.getElementById('configProfileSelect');
            
            // 清空现有选项
            select.innerHTML = '<option value="">选择配置方案...</option>';
            
            // 添加保存的配置方案
            Object.keys(profiles).forEach(name => {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name;
                select.appendChild(option);
            });
        }

        function saveCurrentConfigProfile() {
            showCustomPrompt('保存配置方案', '请输入配置方案名称:', '', (profileName) => {
                if (!profileName || profileName.trim() === '') {
                    return;
                }

                const trimmedName = profileName.trim();
            
	            // 配置方案只保存非敏感字段；凭据由系统安全存储统一管理。
	            const currentConfig = sanitizeConfigForStorage({
                // SSH配置
                host: document.getElementById('sshHost').value.trim(),
                port: document.getElementById('sshPort').value.trim(),
                username: document.getElementById('sshUsername').value.trim(),
                authMethod: document.getElementById('sshAuthMethod').value,
	                privateKeyPath: document.getElementById('sshPrivateKeyPath').value.trim(),
                rememberPassword: document.getElementById('rememberPassword').checked,
                trustServer: document.getElementById('trustServer').checked,
                autoCommand: document.getElementById('autoCommand').value.trim(),
                
                // AI配置
                enableAI: document.getElementById('enableAI').checked,
                aiDisplayMode: document.getElementById('aiDisplayMode').value,
                aiBaseUrl: document.getElementById('aiBaseUrl').value.trim(),
                aiApiFormat: document.getElementById('aiApiFormat').value,
                aiModel: getSelectedModel(),
                aiMaxTokens: document.getElementById('aiMaxTokens').value,
                aiTemperature: document.getElementById('aiTemperature').value,
                aiCustomRequirements: document.getElementById('aiCustomRequirements').value.trim(),
                showFullConversation: document.getElementById('showFullConversation').checked,
                
                // 终端配置
                terminalFontSize: document.getElementById('terminalFontSize').value,
                terminalFontFamily: document.getElementById('terminalFontFamily').value,
                terminalTheme: document.getElementById('terminalTheme').value,
                terminalCursorStyle: document.getElementById('terminalCursorStyle').value,
                terminalCursorBlink: document.getElementById('terminalCursorBlink').checked,
                terminalScrollback: document.getElementById('terminalScrollback').value,
                
	                // 命令配置
	                commonCommands: document.getElementById('commonCommands').value.trim(),
	                webhookConfig: getWebhookConfigFromForm(),
                
                // 保存时间戳
	                savedAt: new Date().toISOString()
	            });

            // 保存到localStorage
            const profiles = readStoredObject('configProfiles');
            profiles[trimmedName] = currentConfig;
            localStorage.setItem('configProfiles', JSON.stringify(profiles));
            workspace?.renderAssets();
            
            // 刷新下拉列表
            loadConfigProfiles();
            
            // 选中刚保存的配置
            document.getElementById('configProfileSelect').value = trimmedName;
            
            showCustomAlert('成功', `配置方案 "${trimmedName}" 已保存！`);
            });
        }

        function loadConfigProfile() {
            const select = document.getElementById('configProfileSelect');
            const profileName = select.value;
            
            if (!profileName) {
                return;
            }
            
            const profiles = readStoredObject('configProfiles');
            const profile = profiles[profileName];
            
            if (!profile) {
                showCustomAlert('错误', '配置方案不存在！');
                return;
            }
            
            // 确认是否要加载配置
            showCustomConfirm('确认加载', `确定要加载配置方案 "${profileName}" 吗？当前未保存的配置将会丢失。`, (confirmed) => {
                if (!confirmed) {
                    select.value = '';
                    return;
                }
            
            // 加载SSH配置
            if (profile.host) document.getElementById('sshHost').value = profile.host;
            if (profile.port) document.getElementById('sshPort').value = profile.port;
            if (profile.username) document.getElementById('sshUsername').value = profile.username;
            if (profile.authMethod) {
                document.getElementById('sshAuthMethod').value = profile.authMethod;
                toggleAuthMethod();
            }
	            if (profile.privateKeyPath) document.getElementById('sshPrivateKeyPath').value = profile.privateKeyPath;
            document.getElementById('rememberPassword').checked = profile.rememberPassword === true;
            document.getElementById('trustServer').checked = profile.trustServer === true;
            syncServerTrustMarker();
            if (profile.autoCommand) document.getElementById('autoCommand').value = profile.autoCommand;
            
            // 加载AI配置
            document.getElementById('enableAI').checked = profile.enableAI !== false;
            if (profile.aiDisplayMode) document.getElementById('aiDisplayMode').value = profile.aiDisplayMode;
            if (profile.aiBaseUrl) document.getElementById('aiBaseUrl').value = profile.aiBaseUrl;
            document.getElementById('aiApiFormat').value = profile.aiApiFormat || 'auto';
            if (profile.aiModel) {
                const preset = ['gpt-3.5-turbo', 'gpt-4', 'gpt-4-turbo-preview'].includes(profile.aiModel);
                document.getElementById('aiModel').value = preset ? profile.aiModel : 'custom';
                if (!preset) {
                    document.getElementById('aiModelCustom').value = profile.aiModel;
                    showCustomModelInput();
                }
            }
            if (profile.aiMaxTokens) document.getElementById('aiMaxTokens').value = profile.aiMaxTokens;
            if (profile.aiTemperature !== undefined && Number.isFinite(Number(profile.aiTemperature))) document.getElementById('aiTemperature').value = profile.aiTemperature;
            if (profile.aiCustomRequirements) document.getElementById('aiCustomRequirements').value = profile.aiCustomRequirements;
            document.getElementById('showFullConversation').checked = profile.showFullConversation === true;
            
            // 加载终端配置
            if (profile.terminalFontSize) document.getElementById('terminalFontSize').value = profile.terminalFontSize;
            if (profile.terminalFontFamily) document.getElementById('terminalFontFamily').value = profile.terminalFontFamily;
            if (profile.terminalTheme) document.getElementById('terminalTheme').value = profile.terminalTheme;
            if (profile.terminalCursorStyle) document.getElementById('terminalCursorStyle').value = profile.terminalCursorStyle;
            document.getElementById('terminalCursorBlink').checked = profile.terminalCursorBlink !== false;
            if (profile.terminalScrollback) document.getElementById('terminalScrollback').value = profile.terminalScrollback;
            
	            // 加载命令配置
	            if (profile.commonCommands) document.getElementById('commonCommands').value = profile.commonCommands;
            applyWebhookConfigToForm(profile.webhookConfig || {});
            refreshWebhookSettings();
            
            showCustomAlert('成功', `配置方案 "${profileName}" 已加载！`);
            });
        }

        function deleteConfigProfile() {
            const select = document.getElementById('configProfileSelect');
            const profileName = select.value;
            
            if (!profileName) {
                showCustomAlert('提示', '请先选择要删除的配置方案！');
                return;
            }
            
            showCustomConfirm('确认删除', `确定要删除配置方案 "${profileName}" 吗？此操作不可撤销。`, (confirmed) => {
                if (!confirmed) {
                    return;
                }
            
            const profiles = readStoredObject('configProfiles');
            delete profiles[profileName];
            localStorage.setItem('configProfiles', JSON.stringify(profiles));
            workspace?.renderAssets();
            
            // 刷新下拉列表
            loadConfigProfiles();
            
            showCustomAlert('成功', `配置方案 "${profileName}" 已删除！`);
            });
        }

	        function getWebhookConfigFromForm() {
	            const eventMap = [
	                ['webhookTaskStarted', 'task_started'],
	                ['webhookSecurityConfirmation', 'security_confirmation'],
	                ['webhookTaskCompleted', 'task_completed'],
	                ['webhookTaskError', 'task_error'],
	                ['webhookSshDisconnected', 'ssh_disconnected'],
                    ['webhookProgramStopped', 'program_stopped'],
                    ['webhookOutputMatched', 'output_matched']
	            ];
	            return {
	                enabled: document.getElementById('webhookEnabled')?.checked === true,
	                url: document.getElementById('webhookUrl')?.value.trim() || '',
	                events: eventMap.filter(([id]) => document.getElementById(id)?.checked).map(([, event]) => event),
	                includeCommand: document.getElementById('webhookIncludeCommand')?.checked === true,
                    outputRules: (document.getElementById('webhookOutputRules')?.value || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean),
                    outputIgnoreCase: document.getElementById('webhookOutputIgnoreCase')?.checked !== false,
                    outputCooldownSeconds: Number(document.getElementById('webhookOutputCooldown')?.value || 60),
                    includeOutput: document.getElementById('webhookIncludeOutput')?.checked === true,
	                timeoutMs: parseInt(document.getElementById('webhookTimeout')?.value, 10) || 8000
	            };
	        }

        function getServerIdentityFromForm() {
            const host = document.getElementById('sshHost')?.value.trim().toLowerCase() || '';
            const port = parseInt(document.getElementById('sshPort')?.value, 10) || 22;
            const username = document.getElementById('sshUsername')?.value.trim() || '';
            return host && username ? JSON.stringify([host, port, username]) : '';
        }

        function syncServerTrustMarker() {
            const trust = document.getElementById('trustServer');
            if (trust) trust.dataset.identity = trust.checked ? getServerIdentityFromForm() : '';
        }

        function setupServerTrustInputs() {
            const trust = document.getElementById('trustServer');
            if (!trust) return;
            for (const id of ['sshHost', 'sshPort', 'sshUsername']) {
                document.getElementById(id)?.addEventListener('input', () => {
                    if (trust.checked && trust.dataset.identity !== getServerIdentityFromForm()) trust.checked = false;
                });
            }
            trust.addEventListener('change', syncServerTrustMarker);
            syncServerTrustMarker();
        }

	        function applyWebhookConfigToForm(input = {}) {
	            const defaults = ['task_started', 'security_confirmation', 'task_completed', 'task_error', 'ssh_disconnected', 'program_stopped'];
	            const events = Array.isArray(input.events) ? input.events : defaults;
	            const setChecked = (id, event) => {
	                const element = document.getElementById(id);
	                if (element) element.checked = events.includes(event);
	            };
	            const enabled = document.getElementById('webhookEnabled');
	            const url = document.getElementById('webhookUrl');
	            const includeCommand = document.getElementById('webhookIncludeCommand');
	            const timeout = document.getElementById('webhookTimeout');
	            if (enabled) enabled.checked = input.enabled === true;
	            if (url) {
	                url.value = input.url || '';
	                url.dataset.hasStoredUrl = input.hasStoredUrl === true ? 'true' : 'false';
	                url.placeholder = input.hasStoredUrl === true
	                    ? '已安全保存；输入新 URL 可替换'
	                    : 'https://hooks.example.com/notify';
	            }
	            const urlStatus = document.getElementById('webhookUrlStatus');
	            if (urlStatus) {
	                urlStatus.textContent = input.hasStoredUrl === true ? '已安全保存 Webhook URL（不会回显）' : '';
	                urlStatus.style.display = input.hasStoredUrl === true ? 'block' : 'none';
	            }
	            if (includeCommand) includeCommand.checked = input.includeCommand === true;
	            if (timeout) timeout.value = input.timeoutMs || 8000;
	            setChecked('webhookTaskStarted', 'task_started');
	            setChecked('webhookSecurityConfirmation', 'security_confirmation');
	            setChecked('webhookTaskCompleted', 'task_completed');
	            setChecked('webhookTaskError', 'task_error');
	            setChecked('webhookSshDisconnected', 'ssh_disconnected');
                setChecked('webhookProgramStopped', 'program_stopped');
                setChecked('webhookOutputMatched', 'output_matched');
                const rules = document.getElementById('webhookOutputRules');
                if (rules) rules.value = Array.isArray(input.outputRules) ? input.outputRules.join('\n') : '';
                const ignoreCase = document.getElementById('webhookOutputIgnoreCase');
                if (ignoreCase) ignoreCase.checked = input.outputIgnoreCase !== false;
                const cooldown = document.getElementById('webhookOutputCooldown');
                if (cooldown) cooldown.value = input.outputCooldownSeconds ?? 60;
                const includeOutput = document.getElementById('webhookIncludeOutput');
                if (includeOutput) includeOutput.checked = input.includeOutput === true;
	        }

	        function showWebhookResult(message, type) {
	            const element = document.getElementById('webhookTestResult');
	            if (!element) return;
	            element.style.display = 'block';
	            element.textContent = message;
	            element.style.color = type === 'success' ? 'var(--success-color)' : 'var(--danger-color)';
	        }

	        async function saveWebhookSettings() {
		            const config = getWebhookConfigFromForm();
	            const result = await window.electronAPI.webhookConfigure(config);
	            if (!result?.success) {
	                showWebhookResult(`保存失败: ${result?.error || '未知错误'}`, 'error');
	                return false;
	            }
		            localStorage.setItem('webhookConfig', JSON.stringify({ ...(result.config || config), url: '' }));
	            applyWebhookConfigToForm(result.config || config);
	            showWebhookResult('Webhook 配置已保存', 'success');
	            return true;
	        }

        async function clearWebhookUrl() {
            const config = getWebhookConfigFromForm();
            config.enabled = false;
            config.url = '';
            config.clearStoredUrl = true;
            const result = await window.electronAPI.webhookConfigure(config);
            if (!result?.success) {
                showWebhookResult(`清除失败: ${result?.error || '未知错误'}`, 'error');
                return false;
            }
            localStorage.setItem('webhookConfig', JSON.stringify({ ...(result.config || config), url: '' }));
            applyWebhookConfigToForm(result.config || config);
            showWebhookResult('Webhook URL 已清除', 'success');
            return true;
        }

        async function refreshWebhookSettings() {
            try {
                const result = await window.electronAPI?.webhookGetConfig?.();
                if (result?.success) applyWebhookConfigToForm(result.config || {});
            } catch (error) {
                console.warn('读取 Webhook 配置失败:', error.message);
            }
        }

	        async function testWebhook() {
	            const config = getWebhookConfigFromForm();
	            showWebhookResult('正在发送测试通知...', 'success');
	            const result = await window.electronAPI.webhookTest(config);
	            showWebhookResult(result?.success ? `测试成功 (HTTP ${result.statusCode})` : `测试失败: ${result?.error || '未知错误'}`, result?.success ? 'success' : 'error');
	        }

	        async function testAIConnection() {
            const btn = document.querySelector('[data-action="test-ai-connection"]');
            const resultEl = document.getElementById('testResult');
	            const config = validateConfigData({
                aiApiKey: document.getElementById('aiApiKey').value.trim(),
                aiBaseUrl: document.getElementById('aiBaseUrl').value.trim(),
                aiApiFormat: document.getElementById('aiApiFormat').value,
                aiModel: getSelectedModel()
	            });

	            btn.disabled = true; btn.innerHTML = '🔄 测试中...';
            showTestResult('正在测试...', 'info');

	            const targetTabId = activeTabId;
	            const result = await window.electronAPI.aiTestConnection(config, targetTabId);
            if (result.success && result.response.includes('✅')) {
                showTestResult('✅ AI连接测试成功！', 'success');
            } else {
                showTestResult(`❌ 测试失败: ${result.error || result.response}`, 'error');
            }
            btn.disabled = false; btn.innerHTML = '🔍 测试AI连接';
        }

        // --- Config Management ---
	        async function saveConfig(config, targetTabId = activeTabId) {
	            const webhookConfig = config.webhookConfig || getWebhookConfigFromForm();
	            const webhookResult = await window.electronAPI?.webhookConfigure?.(webhookConfig);
	            if (webhookResult && !webhookResult.success) {
	                throw new Error(webhookResult.error || 'Webhook 配置保存失败');
	            }
	            localStorage.setItem('webhookConfig', JSON.stringify({ ...webhookConfig, url: '' }));
	            localStorage.setItem('sshConfig', JSON.stringify(sanitizeConfigForStorage(config)));
                    const info = terminalTabs.get(targetTabId);
                    if (info) { info.aiConfigSnapshot = sanitizeConfigForStorage(config); info.connectionConfig = sanitizeConfigForStorage(config); }
	            await window.electronAPI?.aiConfigure?.(config, targetTabId);
                    workspace?.renderAssets();
	        }

	        function loadSavedConfig() {
	            const config = { ...readStoredObject('sshConfig'), ...getActiveTabInfo()?.aiConfigSnapshot, ...getActiveTabInfo()?.connectionConfig };
                    // Restored workspaces never inherit another connection's startup command or trust decision.
                    if (getActiveTabInfo()?.pendingRemote) { config.autoCommand = ''; config.trustServer = false; }
	            const termConfig = readStoredObject('terminalConfig');
	            const webhookConfig = readStoredObject('webhookConfig');

            // SSH & AI
            if(config.host) document.getElementById('sshHost').value = config.host;
            if(config.port) document.getElementById('sshPort').value = config.port;
            if(config.username) document.getElementById('sshUsername').value = config.username;
            
            // 设置认证方式
            if(config.authMethod) {
                document.getElementById('sshAuthMethod').value = config.authMethod;
                toggleAuthMethod(); // 切换显示相应的认证字段
            }
            
	            if(config.privateKeyPath) document.getElementById('sshPrivateKeyPath').value = config.privateKeyPath;
	            document.getElementById('rememberPassword').checked = config.rememberPassword === true;
	            document.getElementById('trustServer').checked = config.trustServer === true;
	            syncServerTrustMarker();
            
            if(config.autoCommand) document.getElementById('autoCommand').value = config.autoCommand;
            if(config.aiDisplayMode) document.getElementById('aiDisplayMode').value = config.aiDisplayMode;
            if(config.aiBaseUrl) document.getElementById('aiBaseUrl').value = config.aiBaseUrl;
            document.getElementById('aiApiFormat').value = config.aiApiFormat || 'auto';
            if(config.aiModel) {
                 const preset = ['gpt-3.5-turbo', 'gpt-4', 'gpt-4-turbo-preview'].includes(config.aiModel);
                 document.getElementById('aiModel').value = preset ? config.aiModel : 'custom';
                 if(!preset) { document.getElementById('aiModelCustom').value = config.aiModel; showCustomModelInput(); }
            }
            if(config.aiMaxTokens) document.getElementById('aiMaxTokens').value = config.aiMaxTokens;
            if(Number.isFinite(Number(config.aiTemperature)) && config.aiTemperature !== undefined) document.getElementById('aiTemperature').value = config.aiTemperature;
            if(config.aiCustomRequirements) document.getElementById('aiCustomRequirements').value = config.aiCustomRequirements;
            document.getElementById('showFullConversation').checked = config.showFullConversation === true;
            if(config.commonCommands) document.getElementById('commonCommands').value = config.commonCommands;
            document.getElementById('enableAI').checked = config.enableAI !== false;

            // Terminal
            if(termConfig.fontSize) document.getElementById('terminalFontSize').value = termConfig.fontSize;
            if(termConfig.fontFamily) document.getElementById('terminalFontFamily').value = termConfig.fontFamily;
            if(termConfig.theme) document.getElementById('terminalTheme').value = termConfig.theme;
            if(termConfig.cursorStyle) document.getElementById('terminalCursorStyle').value = termConfig.cursorStyle;
            if(Number.isInteger(termConfig.scrollback)) document.getElementById('terminalScrollback').value = termConfig.scrollback;
	            document.getElementById('terminalCursorBlink').checked = termConfig.cursorBlink !== false;
	            applyWebhookConfigToForm(webhookConfig);
	        }

        function updateTerminalConfig() {
            const newConfig = window.AITerminalStorage.terminalConfig({
                fontSize: parseInt(document.getElementById('terminalFontSize').value) || 14,
                fontFamily: document.getElementById('terminalFontFamily').value,
                theme: document.getElementById('terminalTheme').value,
                cursorStyle: document.getElementById('terminalCursorStyle').value,
                cursorBlink: document.getElementById('terminalCursorBlink').checked,
                scrollback: parseInt(document.getElementById('terminalScrollback').value),
            }, terminalConfig, terminalThemes);
            terminalConfig = newConfig;

            terminalTabs.forEach((tabInfo) => {
                if (!tabInfo || !tabInfo.terminal) return;
                tabInfo.terminal.options.fontSize = newConfig.fontSize;
	                tabInfo.terminal.options.fontFamily = getSafeTerminalFontFamily(newConfig.fontFamily);
                tabInfo.terminal.options.cursorStyle = newConfig.cursorStyle;
                tabInfo.terminal.options.cursorBlink = newConfig.cursorBlink;
                tabInfo.terminal.options.scrollback = newConfig.scrollback;
                if (terminalThemes[newConfig.theme]) {
                    tabInfo.terminal.options.theme = terminalThemes[newConfig.theme];
                }
            });

            // 同步更新全局UI主题
            updateGlobalTheme(newConfig.theme);

	            if (workspace) workspace.fit(); else scheduleFitTerminalTab(activeTabId, { syncSsh: true });
	            localStorage.setItem('terminalConfig', JSON.stringify(newConfig));
	        }

        function updateGlobalTheme(themeName) {
            const body = document.body;
            
            // 移除所有现有的主题类
            body.removeAttribute('data-theme');
            
            // 根据终端主题设置全局主题
            if (themeName && themeName !== 'light') {
                body.setAttribute('data-theme', themeName);
            }
            
            console.log('Global theme updated to:', themeName);
        }

        function checkAutoLogin() {
            const config = readStoredObject('sshConfig');
            if (config.rememberPassword && config.host && config.username) {
                scheduleAutoConnectSSH(config, activeTabId);
            }
        }

        function scheduleAutoConnectSSH(config, ownerTabId, delayMs = 1000) {
            const owner = terminalTabs.get(ownerTabId);
            const snapshot = { ...config };
            setTimeout(() => {
                if (!ownsTerminalTab(ownerTabId, owner) || owner.isConnected || owner.sshConnecting) return;
                void autoConnectSSH(snapshot, ownerTabId);
            }, delayMs);
        }

	        async function autoConnectSSH(config, ownerTabId = activeTabId) {
	            const ownerTabInfo = terminalTabs.get(ownerTabId);
		            if (!ownsTerminalTab(ownerTabId, ownerTabInfo) || !ownerTabInfo.terminal) {
	                console.error('活动标签页的终端实例不可用');
		                return;
		            }
		            const connectToken = Symbol(`ssh-auto-connect:${ownerTabId}`);
		            ownerTabInfo.sshConnectToken = connectToken;
		            ownerTabInfo.isConnected = false;
                    ownerTabInfo.connectionConfig = sanitizeConfigForStorage(config);
                    workspace?.backendChanged(ownerTabId, { preservePins: !!ownerTabInfo.pendingRemote });
                    ownerTabInfo.pendingRemote = false;
                    getTabContent(ownerTabId)?.querySelector('.pending-connection')?.remove();

	            if (ownerTabId === activeTabId) showTerminal();
	            ownerTabInfo.terminal.write('\r\n\x1b[36m[尝试自动连接SSH...]\x1b[0m\r\n');
	            
		            try {
		                stopLocalTerminalForTab(ownerTabId);
		                updateTabStatus(ownerTabId, 'connecting');
		                ownerTabInfo.sshConnecting = true;
		                const result = await window.electronAPI.sshConnect(config, ownerTabId);
		                if (terminalTabs.get(ownerTabId) !== ownerTabInfo || ownerTabInfo.isClosing ||
		                    ownerTabInfo.sshConnectToken !== connectToken) return false;
		                ownerTabInfo.sshConnectToken = null;
		                ownerTabInfo.sshConnecting = false;
	                
	                // 更新连接状态
		                if (result.success) {
		                    setSshOwnerTab(ownerTabId, true);
		                } else {
		                    setSshOwnerTab(ownerTabId, false);
	                }
	                
	                // 更新UI状态
	                updateTabStatus(ownerTabId, result.success ? 'connected' : 'disconnected');
	                if (result.success) {
	                    updateTabTitle(ownerTabId, `${config.username}@${config.host}`);
	                }
	                updateSSHButton();
	                updateStatusIndicator();
	                
	                // 显示结果消息
	                ownerTabInfo.terminal.write(`\r\n\x1b[${result.success ? '32m[连接成功]' : `31m[自动连接失败: ${result.message}`}] \x1b[0m\r\n`);
	                
	                // 如果连接成功，聚焦终端
	                if (result.success) {
	                    scheduleFitTerminalTab(ownerTabId, { syncSsh: true });
	                    setTimeout(() => {
	                        if (activeTabId === ownerTabId) {
	                            ownerTabInfo.terminal.focus();
	                            fitTerminalTab(ownerTabId, { focus: true, syncSsh: true });
	                        }
	                    }, 500);
	                } else {
	                    if (!workspace?.pendingRemote(ownerTabId)) startLocalTerminalForTab(ownerTabId);
	                }
	                
	                return result.success;
		            } catch (error) {
		                console.error('自动连接错误:', error);
		                if (terminalTabs.get(ownerTabId) !== ownerTabInfo || ownerTabInfo.isClosing ||
		                    ownerTabInfo.sshConnectToken !== connectToken) return false;
		                ownerTabInfo.sshConnectToken = null;
		                ownerTabInfo.sshConnecting = false;
		                setSshOwnerTab(ownerTabId, false);
	                ownerTabInfo.terminal.write(`\r\n\x1b[31m[自动连接错误: ${error.message}]\x1b[0m\r\n`);
	                if (!workspace?.pendingRemote(ownerTabId)) startLocalTerminalForTab(ownerTabId);
	                return false;
	            }
	        }

        // --- Modal Input Helpers ---
        function toggleModelInput() {
            const customInput = document.getElementById('aiModelCustom');
            if ((customInput.style.display === 'none' || !customInput.style.display) && !customInput.classList.contains('active')) {
                showCustomModelInput();
            } else {
                hideCustomModelInput();
            }
        }
        function showCustomModelInput() {
            document.getElementById('aiModel').classList.add('hidden');
            document.getElementById('aiModelCustom').classList.add('active');
            document.querySelector('.model-toggle-btn').textContent = '选择';
        }
        function hideCustomModelInput() {
            document.getElementById('aiModel').classList.remove('hidden');
            document.getElementById('aiModelCustom').classList.remove('active');
            document.querySelector('.model-toggle-btn').textContent = '自定义';
        }
        function getSelectedModel() {
            const modelSelect = document.getElementById('aiModel');
            return modelSelect.value === 'custom'
                ? document.getElementById('aiModelCustom').value.trim() || 'gpt-3.5-turbo'
                : modelSelect.value;
        }
        function validateConfigData(config) {
            const cleaned = { ...config };
            if (cleaned.aiBaseUrl) cleaned.aiBaseUrl = cleaned.aiBaseUrl.trim().replace(/\/$/, '');
            return cleaned;
        }
        function showTestResult(message, type) {
            const el = document.getElementById('testResult');
            el.style.display = 'block';
            el.textContent = message;
            el.style.color = type === 'success' ? 'var(--success-color)' : type === 'error' ? 'var(--danger-color)' : 'var(--text-secondary)';
            el.style.background = 'var(--bg-secondary)';
            el.style.padding = '8px 12px';
            el.style.borderRadius = '4px';
            el.style.marginTop = '8px';
            el.style.border = '1px solid var(--border-color)';
        }

        // SSH认证方式切换
        function toggleAuthMethod() {
            const authMethod = document.getElementById('sshAuthMethod').value;
            const passwordGroup = document.getElementById('passwordGroup');
            const privateKeyGroup = document.getElementById('privateKeyGroup');
            const passphraseGroup = document.getElementById('passphraseGroup');
            
            if (authMethod === 'password') {
                passwordGroup.style.display = 'block';
                privateKeyGroup.style.display = 'none';
                passphraseGroup.style.display = 'none';
            } else if (authMethod === 'privateKey') {
                passwordGroup.style.display = 'none';
                privateKeyGroup.style.display = 'block';
                passphraseGroup.style.display = 'block';
            }
        }

        // 选择私钥文件
        async function selectPrivateKeyFile() {
            try {
                const result = await window.electronAPI.selectPrivateKeyFile();
                if (result.success && result.filePath) {
                    document.getElementById('sshPrivateKeyPath').value = result.filePath;
                }
            } catch (error) {
                console.error('选择私钥文件失败:', error);
            }
        }

        // 设置菜单事件监听器
        function setupMenuEventListeners() {
            // Terminal菜单
            window.electronAPI.onMenuNewConnection(() => {
                createSSHModal();
                sshModal.style.display = 'block';
            });

            if (window.electronAPI.onMenuNewTab) {
                window.electronAPI.onMenuNewTab(() => {
                    createNewTerminalTab();
                });
            }

		            window.electronAPI.onMenuDisconnect(() => {
		                if (canSendToSsh(activeTabId)) {
		                    disconnectCurrentSshSession(activeTabId);
		                }
	            });

            window.electronAPI.onMenuClearTerminal(() => {
                if (term) {
                    term.clear();
                }
            });

            window.electronAPI.onMenuResetTerminal(() => {
                if (term) {
                    term.reset();
                }
            });

            // AI助手菜单
            window.electronAPI.onMenuAiConfig(() => {
                createSSHModal();
                sshModal.style.display = 'block';// SSH配置模态框包含AI配置
                switchTab('ai-tab');
            });

            window.electronAPI.onMenuTestAi(() => {
                commandInput.value = 'test';
                executeSpecialCommand();
            });

	            window.electronAPI.onMenuClearAiHistory(async () => {
	                const targetTabId = activeTabId;
	                const targetTabInfo = terminalTabs.get(targetTabId);
	                const result = await window.electronAPI.aiClearHistory(targetTabId);
	                if (result?.success && ownsTerminalTab(targetTabId, targetTabInfo)) {
	                    targetTabInfo.takeoverFlowState = null;
	                    if (aiTakeoverManager?.switchTab && activeTabId === targetTabId) aiTakeoverManager.switchTab(targetTabId);
	                    writeToTerminalTab(targetTabId, '\r\n\x1b[36m[当前标签的AI对话历史已清除]\x1b[0m\r\n');
	                }
	            });

            // 文件菜单
            window.electronAPI.onMenuUploadFiles((payload) => {
                const filePaths = Array.isArray(payload) ? payload : payload?.filePaths;
                const targetTabId = Array.isArray(payload) ? activeTabId : payload?.tabId;
                if (filePaths && filePaths.length > 0) {
                    handleFileUpload(filePaths, targetTabId);
                }
            });

            window.electronAPI.onMenuDownloadFile((payload = {}) => {
	                const targetTabId = payload?.tabId || activeTabId;
                showCustomPrompt('下载文件', '请输入要下载的文件路径:', '', (fileName) => {
                    if (fileName) {
                        downloadFile(fileName, targetTabId);
                    }
                });
            });

            // 会话菜单
            window.electronAPI.onMenuSaveSession(() => {
                saveCurrentSession();
            });

            window.electronAPI.onMenuLoadSession(() => {
                loadSession();
            });

            // 工具菜单
            window.electronAPI.onMenuSystemMonitor(() => {
                commandInput.value = 'analyze 系统监控';
                executeSpecialCommand();
            });

            window.electronAPI.onMenuPortScan(() => {
                commandInput.value = 'cmd 扫描常用端口';
                executeSpecialCommand();
            });

            // 帮助菜单
            window.electronAPI.onMenuHelpGuide(() => {
                showHelpGuide();
            });

            window.electronAPI.onMenuAiHelp(() => {
                showAiHelp();
            });
        }

        // 文件上传处理
	        async function handleFileUpload(filePaths, targetTabId = activeTabId) {
		            const targetTabInfo = terminalTabs.get(targetTabId);
		            if (!canSendToSsh(targetTabId)) {
	                showCustomAlert('提示', '请先建立SSH连接');
	                return;
	            }

            try {
	                const result = await window.electronAPI.sshDragUpload(filePaths, targetTabId);
	                if (!ownsTerminalTab(targetTabId, targetTabInfo)) return;
                if (result.success) {
	                    writeToTerminalTab(targetTabId, `\r\n\x1b[32m[${result.message}]\x1b[0m\r\n`);
                } else {
	                    writeToTerminalTab(targetTabId, `\r\n\x1b[31m[上传失败: ${result.message}]\x1b[0m\r\n`);
                }
            } catch (error) {
	                if (ownsTerminalTab(targetTabId, targetTabInfo)) {
	                    writeToTerminalTab(targetTabId, `\r\n\x1b[31m[上传错误: ${error.message}]\x1b[0m\r\n`);
                }
            }
        }

        // 下载文件
	        async function downloadFile(remotePath, targetTabId = activeTabId) {
		            const targetTabInfo = terminalTabs.get(targetTabId);
		            if (!canSendToSsh(targetTabId)) {
	                showCustomAlert('提示', '请先建立SSH连接');
	                return;
	            }

            try {
	                const result = await window.electronAPI.sshDownloadFile(remotePath, targetTabId);
	                if (!ownsTerminalTab(targetTabId, targetTabInfo)) return;
                if (result.success) {
	                    writeToTerminalTab(targetTabId, `\r\n\x1b[32m[${result.message}]\x1b[0m\r\n`);
                } else {
	                    writeToTerminalTab(targetTabId, `\r\n\x1b[31m[下载失败: ${result.error}]\x1b[0m\r\n`);
                }
            } catch (error) {
	                if (ownsTerminalTab(targetTabId, targetTabInfo)) {
	                    writeToTerminalTab(targetTabId, `\r\n\x1b[31m[下载错误: ${error.message}]\x1b[0m\r\n`);
                }
            }
        }

        // 保存当前会话
        function saveCurrentSession() {
            const info = getActiveTabInfo();
            const config = info?.connectionConfig || info?.aiConfigSnapshot || readStoredObject('sshConfig');
            if (Object.keys(config).length) {
                const publicConfig = sanitizeConfigForStorage(config);
                const blob = new Blob([JSON.stringify(publicConfig, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'aiterminal-session.json';
                a.click();
                URL.revokeObjectURL(url);
                
                if (term) {
                    writeToTerminalTab(activeTabId, '\r\n\x1b[32m[会话配置已保存]\x1b[0m\r\n');
                }
            } else {
                if (term) {
                    writeToTerminalTab(activeTabId, '\r\n\x1b[33m[没有可保存的会话配置]\x1b[0m\r\n');
                }
            }
        }

        // 加载会话
        function loadSession() {
	        const targetTabId = activeTabId;
	        const targetTabInfo = terminalTabs.get(targetTabId);
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.onchange = (e) => {
                const file = e.target.files[0];
                if (file) {
	                if (file.size > 1024 * 1024) {
	                    if (ownsTerminalTab(targetTabId, targetTabInfo)) {
	                        writeToTerminalTab(targetTabId, '\r\n\x1b[31m[会话文件过大，最大允许 1 MiB]\x1b[0m\r\n');
	                    }
	                    return;
	                }
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        try {
	                        if (!ownsTerminalTab(targetTabId, targetTabInfo)) return;
	                        const config = sanitizeConfigForStorage(JSON.parse(e.target.result));
	                        localStorage.setItem('sshConfig', JSON.stringify(config));
	                        targetTabInfo.aiConfigSnapshot = config;
	                        targetTabInfo.connectionConfig = config;
	                            if (ownsTerminalTab(targetTabId, targetTabInfo)) {
	                                writeToTerminalTab(targetTabId, '\r\n\x1b[32m[会话配置已加载]\x1b[0m\r\n');
                            }
                        } catch (error) {
	                            if (ownsTerminalTab(targetTabId, targetTabInfo)) {
	                                writeToTerminalTab(targetTabId, '\r\n\x1b[31m[会话文件格式错误]\x1b[0m\r\n');
                            }
                        }
                    };
                    reader.readAsText(file);
                }
            };
            input.click();
        }

        function showHelpGuide() {
            const helpContent = `
🚀 AITerminal 使用指南

📋 基础功能:
• 本地终端: 打开即可使用；Windows 默认 WSL Ubuntu
• SSH连接: 点击"连接"按钮配置服务器信息
• 终端操作: 支持所有标准SSH终端功能
• 远程图片: 远程图片文件直接点击下载查看
• 文件传输: 拖拽文件到终端区域上传

🤖 AI助手命令:
• [问题] - 直接与AI助手对话
• ai [问题] - 与AI linux助手对话
• fix [问题] - 获取错误修复建议
• analyze [目标] - 系统分析
• cmd [描述] - 自然语言转命令
• test - 测试AI连接

⌨️ 快捷键:
• Ctrl+N: 新建连接
• Ctrl+D: 断开连接
• Ctrl+K: 清屏
• Ctrl+R: 重置终端
• Ctrl+Shift+A: AI配置
• Ctrl+T: 测试AI连接
• Ctrl/Cmd+Shift+E: 左右分屏；加 Alt 为上下分屏
• Ctrl/Cmd+Shift+←/→: 切换同组窗格
• Ctrl/Cmd+Shift+F: 搜索会话
• Ctrl/Cmd+Shift+P: 插件中心
• Ctrl/Cmd+Shift+C/V: 复制/粘贴；选中文本后回车复制

📁 文件操作:
• Ctrl+U: 上传文件
• Ctrl+Shift+D: 下载文件
• 拖拽上传: 直接拖拽文件到终端

💡 提示:
• 默认流式AI回复，添加 --no-stream 参数使用非流
• 可以保存和加载会话配置
• 右上角保存工作区，左侧导入/导出多窗格布局
• 恢复布局创建新会话；SSH 需重连，不重放旧命令
• 支持多种终端主题
💡 更多问题请访问项目AITerminal https://github.com/Amo-Zeng/AITerminal 
            `;
            
            if (term) {
                writeToTerminalTab(activeTabId, '\r\n\x1b[36m' + helpContent + '\x1b[0m\r\n');
            }
        }

        // 显示AI帮助
        function showAiHelp() {
            const aiHelpContent = `
🤖 AI助手功能详解

💬 对话命令:
• ai 如何查看系统内存？
• ai 解释Docker的工作原理
• ai Linux安全配置最佳实践

🔧 修复命令:
• fix nginx无法启动
• fix 磁盘空间不足
• fix SSH连接被拒绝

📊 分析命令:
• analyze 系统性能
• analyze 网络状态
• analyze 安全状况

⚡ 命令转换:
• cmd 查找大文件
• cmd 批量重命名文件
• cmd 设置定时任务

🌊 AI回复:
• 默认流式回复
• 添加 --no-stream 参数使用非流式回复
• 例: ai --no-stream 详细解释Kubernetes架构
• 默认分屏显示，支持完整的markdown和数学公式渲染
• 可以切换终端显示

💡 使用技巧:
• AI会根据当前目录和系统状态提供建议
• 可以进行连续对话，AI会记住上下文
• 危险操作会有明确警告提示
• 建议的命令可以直接复制执行
            `;
            
            if (term) {
                writeToTerminalTab(activeTabId, '\r\n\x1b[36m' + aiHelpContent + '\x1b[0m\r\n');
            }
        }

        // AI接管模式功能
        function initAiTakeoverMode() {
            const commandInput = document.getElementById('commandInput');
            const startTakeoverBtn = document.getElementById('startTakeover');
            const stopTakeoverBtn = document.getElementById('stopTakeover');
            const showFlowBtn = document.getElementById('showTakeoverFlow');
            const retryTakeoverBtn = document.getElementById('retryTakeover');
            const flowModal = document.getElementById('takeoverFlowModal');
            const flowList = document.getElementById('takeoverFlowList');
            const closeFlowBtn = document.getElementById('closeTakeoverFlow');
            const clearFlowBtn = document.getElementById('clearTakeoverFlow');

            // 简洁流程数据与方法
	            let flowStateTabId = activeTabId;
            let takeoverFlowData = [];
            let currentStreamingEntry = null;      // 正在汇总的流式面板条目
            let currentStreamingElement = null;    // 对应的DOM节点（面板打开时）
	            function createTakeoverFlowState() {
	                return {
	                    takeoverFlowData: [],
	                    currentStreamingEntry: null,
	                    currentReplyEntry: null,
	                    currentStreamingChildObj: null,
	                    lastReplChildObj: null,
	                    isStreamingActive: false,
	                    currentUserGroupEntry: null
	                };
	            }
	            function saveTakeoverFlowState(tabId = flowStateTabId) {
	                const tabInfo = terminalTabs.get(tabId);
	                if (!tabInfo) return;
	                tabInfo.takeoverFlowState = {
	                    takeoverFlowData,
	                    currentStreamingEntry,
	                    currentReplyEntry,
	                    currentStreamingChildObj,
	                    lastReplChildObj,
	                    isStreamingActive,
	                    currentUserGroupEntry
	                };
	            }
	            function loadTakeoverFlowState(tabId) {
	                const tabInfo = terminalTabs.get(tabId);
	                if (!tabInfo) return false;
	                const state = tabInfo.takeoverFlowState || createTakeoverFlowState();
	                tabInfo.takeoverFlowState = state;
	                flowStateTabId = tabId;
	                takeoverFlowData = state.takeoverFlowData || [];
	                currentStreamingEntry = state.currentStreamingEntry || null;
	                currentReplyEntry = state.currentReplyEntry || null;
	                currentStreamingChildObj = state.currentStreamingChildObj || null;
	                lastReplChildObj = state.lastReplChildObj || null;
	                isStreamingActive = !!state.isStreamingActive;
	                currentUserGroupEntry = state.currentUserGroupEntry || null;
	                currentStreamingElement = null;
	                currentReplyElement = null;
	                currentStreamingChildEl = null;
	                lastReplChildEl = null;
	                currentUserGroupElement = null;
	                return true;
	            }
	            function withTakeoverFlowState(tabId, callback) {
	                if (!terminalTabs.has(tabId)) return undefined;
	                const targetTabId = tabId;
	                const previousTabId = flowStateTabId;
	                saveTakeoverFlowState(previousTabId);
	                loadTakeoverFlowState(targetTabId);
	                try {
	                    return callback();
	                } finally {
	                    saveTakeoverFlowState(targetTabId);
	                    if (previousTabId !== targetTabId && terminalTabs.has(previousTabId)) {
	                        loadTakeoverFlowState(previousTabId);
	                    }
	                    if (targetTabId === activeTabId && flowModal?.style.display !== 'none') {
	                        openFlowModal();
	                    }
	                }
	            }
	            function isCurrentFlowVisible() {
	                return flowStateTabId === activeTabId && flowModal && flowModal.style.display !== 'none' && flowList;
	            }
            function formatTime(date) {
                const pad = n => String(n).padStart(2, '0');
                return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
            }
            function summarizeUpdate(update) {
                const typeMap = {
                    start: { label: '开始', icon: '🚀' },
                    thinking: { label: '思考', icon: '💭' },
                    streaming: { label: '回复', icon: '📝' },
                    analysis: { label: '分析', icon: '📊' },
                    executing: { label: '执行', icon: '⚙️' },
                    result: { label: '结果', icon: '📄' },
                    user_input: { label: '等待输入', icon: '❓' },
                    interrupted: { label: '已打断', icon: '⏸️' },
                    complete: { label: '完成', icon: '✅' },
                    stop: { label: '停止', icon: '🛑' },
                    error: { label: '错误', icon: '❌' },
                    waiting: { label: '等待', icon: '⏳' }
                };
                const m = typeMap[update.type] || { label: update.type || '更新', icon: '🔔' };
                let summary = update.message || '';
                if (update.type === 'analysis') {
                    // 去掉前缀“AI分析和计划”，突出分析内容首句
                    summary = summary.replace(/^📋\s*AI分析和计划[:：]?\s*/,'').trim();
                } else if (update.type === 'executing') {
                    const m1 = summary.match(/bash命令[:：]\s*([^\n]+)/);
                    const m2 = summary.match(/执行[：:]?\s*([^\n]+)/);
                    summary = (m1 && m1[1]) || (m2 && m2[1]) || summary;
                } else if (update.type === 'user_input') {
                    const m3 = summary.match(/AI需要您的指导[:：]\s*([\s\S]*)/);
                    summary = (m3 && m3[1]) ? m3[1] : summary;
                }
                summary = summary.replace(/^\s+|\s+$/g, '').split('\n')[0];
                if (summary.length > 120) summary = summary.slice(0, 120) + '...';
                return { icon: m.icon, label: m.label, summary };
            }
            function renderFlowItem(idx, entry) {
                const div = document.createElement('div');
                div.className = 'takeover-flow-item';
                div.dataset.index = String(idx);
                if (entry.kind) div.setAttribute('data-kind', entry.kind);
                const headerSummary = (entry && entry.kind === 'reply')
                    ? (String(entry.summary || '').slice(0, 16))
                    : (entry.summary || '');
                div.innerHTML = `
                    <div class=\"takeover-flow-header\" data-index=\"${idx}\">
                        <span class=\"takeover-flow-type\">${escapeHtml(entry.icon || '')} ${escapeHtml(entry.label || '')}</span>
                        <span class=\"takeover-flow-summary\">${escapeHtml(headerSummary)}</span>
                        <span class=\"takeover-flow-time\">${escapeHtml(entry.time || '')}</span>
                        <span class=\"takeover-flow-toggle\">展开 ▾</span>
                    </div>
	                    <div class=\"takeover-flow-content\">${entry.html ? sanitizeInteractiveHtml(entry.htmlContent || '') : (`<pre>${escapeHtml(entry.full || '')}</pre>`)}</div>
                    <div class=\"takeover-flow-children\"></div>
                `;
                // 渲染持久化子项（递归）
                const renderNode = (nodeObj) => {
                    const nodeEl = document.createElement('div');
                    nodeEl.className = 'takeover-flow-item child';
                    if (nodeObj.kind) nodeEl.setAttribute('data-kind', nodeObj.kind);
                    const childHeaderSummary = (nodeObj && nodeObj.kind === 'reply')
                        ? (String(nodeObj.summary || '').slice(0, 16))
                        : (nodeObj.summary || '');
                    nodeEl.innerHTML = `
                        <div class=\"takeover-flow-header\">\n\
                            <span class=\"takeover-flow-type\">${escapeHtml(nodeObj.icon || '')} ${escapeHtml(nodeObj.label || '')}</span>\n\
                            <span class=\"takeover-flow-summary\">${escapeHtml(childHeaderSummary)}</span>\n\
                            <span class=\"takeover-flow-time\">${escapeHtml(nodeObj.time || '')}</span>\n\
                            <span class=\"takeover-flow-toggle\">展开 ▾</span>\n\
                        </div>\n\
	                        <div class=\"takeover-flow-content\">${nodeObj.html ? sanitizeInteractiveHtml(nodeObj.htmlContent || '') : (`<pre>${escapeHtml(nodeObj.full || '')}</pre>`)}</div>
                        <div class=\"takeover-flow-children\"></div>`;
                    const sub = nodeEl.querySelector('.takeover-flow-children');
                    if (nodeObj.children && nodeObj.children.length) {
                        nodeObj.children.forEach(c => sub.appendChild(renderNode(c)));
                    }
                    return nodeEl;
                };
                if (entry.children && entry.children.length) {
                    const childrenEl = div.querySelector('.takeover-flow-children');
                    entry.children.forEach(child => childrenEl.appendChild(renderNode(child)));
                }
                return div;
            }
            // 将消息加入到面板（按时间正序：自上而下追加）
            // 分组规则：以 update.type === 'thinking' 的消息作为一轮“回复”分组的开始
            // 该分组内包含：streaming(回复内容)、analysis/exec/result/error/user_input/repl_output 等子项
            let currentReplyEntry = null;       // 当前分组的顶层数据
            let currentReplyElement = null;     // 当前分组的DOM节点
            let currentStreamingChildEl = null; // 当前分组内的流式子项
            let currentStreamingChildObj = null; // 当前流式子项数据对象（用于持久化全文）
            let lastReplChildEl = null;         // 当前分组内最近一个REPL输出子项
            let lastReplChildObj = null;        // 当前分组内最近一个REPL输出子项（数据）
            let isStreamingActive = false;      // 是否处于流式回复中（供 openFlowModal 定位）
            let currentUserGroupEntry = null;   // 顶层“用户输入”分组
            let currentUserGroupElement = null; // 顶层分组DOM

            function beginUserGroup(text) {
                const entry = { kind: 'user_input', icon: '🗣️', label: '用户输入', summary: (text||'').split('\n')[0].slice(0,120) || '用户输入', time: formatTime(new Date()), full: text||'', children: [] };
                takeoverFlowData.push(entry);
	                if (isCurrentFlowVisible()) {
                    const node = renderFlowItem(takeoverFlowData.length - 1, entry);
                    flowList.appendChild(node);
                    // 当前进行中的用户输入默认展开回复列表
                    node.classList.add('expanded');
                    currentUserGroupElement = node;
                }
                currentUserGroupEntry = entry;
                currentReplyEntry = null;
                currentReplyElement = null;
                currentStreamingChildEl = null;
                lastReplChildEl = null;
            }
	            function appendTakeoverFlowCurrent(update) {
                const appendTopLevel = (entry) => {
                    if (!entry.children) entry.children = [];
                    takeoverFlowData.push(entry);
	                    if (isCurrentFlowVisible()) {
                        const node = renderFlowItem(takeoverFlowData.length - 1, entry);
                        flowList.appendChild(node);
                        return node;
                    }
                    return null;
                };
                const appendChild = (parentEl, parentEntry, child) => {
                    // 写入数据模型
                    if (parentEntry) {
                        if (!parentEntry.children) parentEntry.children = [];
                        parentEntry.children.push(child);
                    }
                    // 面板可见时渲染DOM
                    if (parentEl) {
                        const children = parentEl.querySelector('.takeover-flow-children');
                        if (children) {
                            const childDiv = document.createElement('div');
                            childDiv.className = 'takeover-flow-item child';
                            if (child.kind) childDiv.setAttribute('data-kind', child.kind);
                            childDiv.innerHTML = `
                                <div class="takeover-flow-header">
                                    <span class="takeover-flow-type">${escapeHtml(child.icon || '')} ${escapeHtml(child.label || '')}</span>
                                    <span class="takeover-flow-summary">${escapeHtml(child.summary || '')}</span>
                                    <span class="takeover-flow-time">${escapeHtml(child.time || '')}</span>
                                    <span class="takeover-flow-toggle">展开 ▾</span>
                                </div>
	                                <div class="takeover-flow-content">${child.html ? sanitizeInteractiveHtml(child.htmlContent || '') : (`<pre>${escapeHtml(child.full || '')}</pre>`)}</div>
                            `;
                            children.appendChild(childDiv);
                            return childDiv;
                        }
                    }
                    return null;
                };

                const makeChild = (type, message) => {
                    const iconMap = { thinking:'💭', streaming:'🌊', analysis:'📊', executing:'⚙️', result:'📄', complete:'✅', stop:'🛑', error:'❌', user_input:'❓', repl_output:'🖥️', waiting:'⏳', start:'🚀', interrupted:'⏸️' };
                    const labelMap = { thinking:'思考', streaming:'流式', analysis:'分析', executing:'执行', result:'结果', complete:'完成', stop:'停止', error:'错误', user_input:'等待输入', repl_output:'交互输出', waiting:'等待', start:'开始', interrupted:'打断' };
                    // 对“分析”子项的摘要，去掉前缀
                    let sum = (message || '').split('\n')[0];
                    if (type === 'analysis') {
                        sum = sum.replace(/^📋\s*AI分析和计划[:：]?\s*/,'');
                    }
                    return {
                        kind: 'item',
                        icon: iconMap[type] || '🔔',
                        label: labelMap[type] || type,
                        summary: (sum || '').slice(0,120),
                        time: formatTime(new Date()),
                        full: message || ''
                    };
                };

                // 一轮开始：thinking 作为分组起点
                if (update.type === 'thinking') {
                    // 结束上一分组（如果上一轮没有完整结束，仍强制开启新分组）
                    currentReplyEntry = null;
                    currentReplyElement = null;
                    currentStreamingChildEl = null;
                    lastReplChildEl = null;
                    isStreamingActive = false;

                    const info = summarizeUpdate(update);
                    // 如果不存在“用户输入”分组，则创建系统分组
                    if (!currentUserGroupEntry) beginUserGroup('(系统)');
                    const replyEntry = { kind:'reply', icon: '📝', label: '回复', summary: info.summary || 'AI正在分析...', time: formatTime(new Date()), full: '', children: [] };
	                    if (currentUserGroupEntry) {
	                        currentUserGroupEntry.children.push(replyEntry);
	                        currentReplyEntry = replyEntry;
	                    }
	                    if (currentUserGroupElement) {
	                        const children = currentUserGroupElement.querySelector('.takeover-flow-children');
                        if (children) {
                            const replDiv = document.createElement('div');
                            replDiv.className = 'takeover-flow-item child expanded';
                            replDiv.setAttribute('data-kind','reply');
                            replDiv.innerHTML = `
                                <div class="takeover-flow-header">
                                    <span class="takeover-flow-type">📝 回复</span>
                                    <span class="takeover-flow-summary">${escapeHtml(replyEntry.summary)}</span>
                                    <span class="takeover-flow-time">${escapeHtml(replyEntry.time || '')}</span>
                                    <span class="takeover-flow-toggle">收起 ▴</span>
                                </div>
                                <div class="takeover-flow-content"><pre></pre></div>
                                <div class="takeover-flow-children"></div>`;
                            children.appendChild(replDiv);
                            currentReplyElement = replDiv;
                            currentReplyEntry = replyEntry;
                        }
                    }
                    return;
                }

                // streaming：作为子项（内容可能很长，聚合到一个子项中）
                if (update.type === 'streaming') {
                    if (!currentReplyEntry) {
                        // 若未有分组，优先挂到当前“用户输入”下，否则创建系统分组
                        if (!currentUserGroupEntry) beginUserGroup('(系统)');
                        const replyEntry = { kind:'reply', icon: '📝', label: '回复', summary: 'AI回复', time: formatTime(new Date()), full: '', children: [] };
                    if (currentUserGroupEntry) {
                        currentUserGroupEntry.children.push(replyEntry);
                        currentReplyEntry = replyEntry;
                    }
                    if (currentUserGroupElement) {
                        const children = currentUserGroupElement.querySelector('.takeover-flow-children');
                        if (children) {
                            const replDiv = document.createElement('div');
                            replDiv.className = 'takeover-flow-item child expanded';
                            replDiv.setAttribute('data-kind','reply');
                            const replyHeaderSummary = String(replyEntry.summary || '').slice(0, 16);
                            replDiv.innerHTML = `
                                <div class=\"takeover-flow-header\">\n\
                                    <span class=\"takeover-flow-type\">📝 回复</span>\n\
                                    <span class=\"takeover-flow-summary\">${escapeHtml(replyHeaderSummary)}</span>\n\
                                    <span class=\"takeover-flow-time\">${escapeHtml(replyEntry.time || '')}</span>\n\
                                    <span class=\"takeover-flow-toggle\">收起 ▴</span>\n\
                                </div>\n\
                                <div class=\"takeover-flow-content\"><pre></pre></div>
                                <div class=\"takeover-flow-children\"></div>`;
                            children.appendChild(replDiv);
                            currentReplyElement = replDiv;
                            // 数据已设置
                        }
                    }
                    }
	                    if (!currentStreamingChildObj) {
	                        const child = makeChild('streaming', update.message);
	                        currentStreamingChildEl = appendChild(currentReplyElement, currentReplyEntry, child);
	                        currentStreamingChildObj = child;
	                    } else {
	                        const pre = currentStreamingChildEl?.querySelector('.takeover-flow-content pre');
	                        const summaryEl = currentStreamingChildEl?.querySelector('.takeover-flow-summary');
                        if (pre) pre.textContent = update.message || '';
                        if (summaryEl) summaryEl.textContent = (update.message || '').split('\\n')[0].slice(0,120);
                        if (currentStreamingChildObj) {
                            currentStreamingChildObj.full = update.message || '';
                            currentStreamingChildObj.summary = (update.message || '').split('\\n')[0].slice(0,120);
                        }
                    }
                    isStreamingActive = !update.isComplete;
                    if (update.isComplete) {
                        // 流式完成
                        currentStreamingChildEl = null;
                        currentStreamingChildObj = null;
                        // 用回复首句替换顶部摘要
                        const firstLine = (update.message || '').split('\n')[0];
	                        if (firstLine && currentReplyEntry) {
	                            const sumEl = currentReplyElement?.querySelector('.takeover-flow-summary');
	                            if (sumEl) sumEl.textContent = firstLine.slice(0, 16);
	                            currentReplyEntry.summary = firstLine;
                        }
                    }
                    return;
                }

                // 其他类型：优先加入到当前回复分组（不再单列 analysis 子项）
                if (currentReplyEntry && ['executing','result','complete','stop','error','user_input','repl_output','start','interrupted','waiting'].includes(update.type)) {
                    if (update.type === 'repl_output') {
                        // 累积REPL输出
                        if (lastReplChildObj) {
                            lastReplChildObj.full = (lastReplChildObj.full || '') + (update.message || '');
                            if (lastReplChildEl) {
                                const pre = lastReplChildEl.querySelector('.takeover-flow-content pre');
                                if (pre) pre.textContent = lastReplChildObj.full;
                            }
                        } else {
                            const child = makeChild('repl_output', update.message);
                            lastReplChildEl = appendChild(currentReplyElement, currentReplyEntry, child);
                            lastReplChildObj = child;
                        }
                    } else {
                        const child = makeChild(update.type, update.message);
                        appendChild(currentReplyElement, currentReplyEntry, child);
                        if (update.type !== 'repl_output') { lastReplChildEl = null; lastReplChildObj = null; }
                        if (update.type === 'complete' || update.type === 'stop') {
                            // 结束一个分组
                            currentReplyEntry = null;
                            currentReplyElement = null;
                            lastReplChildEl = null; lastReplChildObj = null;
                            currentStreamingChildEl = null;
                            isStreamingActive = false;
                        }
                        if (update.type === 'error') {
                            // 保留分组可供重试后继续追加
                        }
                    }
                    return;
                }

                // 若没有当前分组
                // 特殊处理：analysis 类型不单列子项，忽略
                if (update.type === 'analysis') {
                    return;
                }
                const info = summarizeUpdate(update);
                // 优先作为“用户输入”下的回复分组
                if (!currentUserGroupEntry) beginUserGroup('(系统)');
                const replyEntry = { kind:'reply', icon: '📝', label: '回复', summary: info.summary, time: formatTime(new Date()), full: '', children: [] };
                if (currentUserGroupEntry) {
                    currentUserGroupEntry.children.push(replyEntry);
                    currentReplyEntry = replyEntry;
                }
	                if (currentUserGroupElement) {
                    const children = currentUserGroupElement.querySelector('.takeover-flow-children');
                    if (children) {
                        const replDiv = document.createElement('div');
                        replDiv.className = 'takeover-flow-item child expanded';
                        replDiv.setAttribute('data-kind','reply');
                        const replyHeaderSummary = String(replyEntry.summary || '').slice(0, 16);
                        replDiv.innerHTML = `
                            <div class=\"takeover-flow-header\">\n\
                                <span class=\"takeover-flow-type\">📝 回复</span>\n\
                                <span class=\"takeover-flow-summary\">${escapeHtml(replyHeaderSummary)}</span>\n\
                                <span class=\"takeover-flow-time\">${escapeHtml(replyEntry.time || '')}</span>\n\
                                <span class=\"takeover-flow-toggle\">收起 ▴</span>\n\
                            </div>\n\
                            <div class=\"takeover-flow-content\"><pre></pre></div>
                            <div class=\"takeover-flow-children\"></div>`;
                        children.appendChild(replDiv);
                        currentReplyElement = replDiv;
	                    }
	                }
	                const child = makeChild(update.type, update.message);
	                appendChild(currentReplyElement, currentReplyEntry, child);
	            }
	            function appendTakeoverFlow(update, tabId = update?.tabId || activeTabId) {
	                return withTakeoverFlowState(tabId, () => appendTakeoverFlowCurrent(update || {}));
	            }
            function openFlowModal() {
                if (!flowModal || !flowList) return;
                flowList.innerHTML = '';
                takeoverFlowData.forEach((entry, idx) => flowList.appendChild(renderFlowItem(idx, entry)));
                flowModal.style.display = 'block';
                // 只展开“当前进行中的回复”：默认折叠其它所有子容器
                try {
                    // 折叠全部
                    const allItems = flowList.querySelectorAll('.takeover-flow-item');
                    allItems.forEach(item => {
                        const children = item.querySelector('.takeover-flow-children');
                        if (children) children.style.display = 'none';
                        const t = item.querySelector('.takeover-flow-toggle');
                        if (t) t.textContent = '展开 ▾';
                    });
                    // 找到最后一个“用户输入”，并把其最后一个“回复”的子容器展开
                    const userGroups = flowList.querySelectorAll('.takeover-flow-item[data-kind="user_input"]');
                    if (userGroups.length) {
                        const lastUser = userGroups[userGroups.length - 1];
                        currentUserGroupElement = lastUser;
                        // 展开用户输入分组的子容器，否则看不到其“回复”
                        const userChildren = lastUser.querySelector('.takeover-flow-children');
                        if (userChildren) userChildren.style.display = 'block';
                        const ut = lastUser.querySelector('.takeover-flow-toggle');
                        if (ut) ut.textContent = '收起 ▴';
                        const replies = lastUser.querySelectorAll('.takeover-flow-item.child[data-kind="reply"]');
                        const targetReply = replies.length ? replies[replies.length - 1] : null;
                        if (targetReply) {
                            const children = targetReply.querySelector('.takeover-flow-children');
                            if (children) children.style.display = 'block';
                            const t = targetReply.querySelector('.takeover-flow-toggle');
                            if (t) t.textContent = '收起 ▴';
                        }
                    }
                } catch (e) { /* noop */ }
                // 若正在流式，指向当前条目的DOM，方便后续增量更新
                if (currentStreamingEntry) {
                    const last = flowList.lastElementChild;
                    if (last && last.querySelector('.takeover-flow-type')?.textContent?.includes('回复')) {
                        currentStreamingElement = last;
                    } else {
                        currentStreamingElement = null;
                    }
                }
            }
            function closeFlowModal() { if (flowModal) flowModal.style.display = 'none'; }
            function clearFlow() { 
                takeoverFlowData = []; 
                currentStreamingEntry = null; 
                currentStreamingElement = null; 
	                currentReplyEntry = null;
	                currentStreamingChildObj = null;
	                lastReplChildObj = null;
	                currentUserGroupEntry = null;
	                saveTakeoverFlowState(flowStateTabId);
                if (flowList) flowList.innerHTML = ''; 
            }

            showFlowBtn && showFlowBtn.addEventListener('click', openFlowModal);
            closeFlowBtn && closeFlowBtn.addEventListener('click', closeFlowModal);
            clearFlowBtn && clearFlowBtn.addEventListener('click', clearFlow);
            flowModal && flowModal.addEventListener('click', (e) => { if (e.target === flowModal) closeFlowModal(); });
            flowList && flowList.addEventListener('click', (e) => {
                const header = e.target.closest('.takeover-flow-header');
                if (!header) return;
                const item = header.parentElement;
                const toggleEl = header.querySelector('.takeover-flow-toggle');
                const isChild = item.classList.contains('child');
                const kind = item.getAttribute('data-kind') || '';
                const preferToggleChildren = ['user_input','reply','history','history_detail'].includes(kind) || !isChild;
                if (preferToggleChildren) {
                    // 分组（用户输入/回复/历史）切换子项容器
                    const children = item.querySelector('.takeover-flow-children');
                    const visible = children && children.style.display !== 'none';
                    if (children) children.style.display = visible ? 'none' : 'block';
                    if (toggleEl) toggleEl.textContent = visible ? '展开 ▾' : '收起 ▴';
                } else {
                    // 叶子子项切换正文
                    const content = item.querySelector('.takeover-flow-content');
                    const visible = content && content.style.display !== 'none';
                    if (content) content.style.display = visible ? 'none' : 'block';
                    if (toggleEl) toggleEl.textContent = visible ? '展开 ▾' : '收起 ▴';
                }
            });

            // 面板搜索
            const flowSearchInput = document.getElementById('flowSearchInput');
            const flowSearchBtn = document.getElementById('flowSearchBtn');
            function renderSearchResults(res, query = '') {
                const lines = (res.results || []).map((r, i) => `${i+1}. [#${r.index} ${r.role}] ${escapeHtml(r.snippet)}`).join('\n');
                const entry = {
                    icon: '🔎',
                    label: '搜索结果',
                    summary: query.slice(0, 60) || '搜索',
                    time: formatTime(new Date()),
                    full: lines || '(无结果)'
                };
                takeoverFlowData.push(entry);
	                if (isCurrentFlowVisible()) {
                    const node = renderFlowItem(takeoverFlowData.length - 1, entry);
                    flowList.appendChild(node);
                }
            }
            async function runFlowSearch() {
                const q = (flowSearchInput?.value || '').trim();
                if (!q) return;
	                const targetTabId = activeTabId;
	                const targetTabInfo = terminalTabs.get(targetTabId);
	                const res = await window.electronAPI.aiContextSearch(q, 30, targetTabId);
	                if (res?.success && ownsTerminalTab(targetTabId, targetTabInfo)) {
	                    withTakeoverFlowState(targetTabId, () => renderSearchResults(res, q));
	                }
            }
            flowSearchBtn && flowSearchBtn.addEventListener('click', runFlowSearch);
            flowSearchInput && flowSearchInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') runFlowSearch(); });

            // MCP 索引展示
            const showMcpIndexBtn = document.getElementById('showMcpIndexBtn');
            showMcpIndexBtn && showMcpIndexBtn.addEventListener('click', async () => {
	                const targetTabId = activeTabId;
	                const targetTabInfo = terminalTabs.get(targetTabId);
	                const idx = await window.electronAPI.aiContextGetIndex(targetTabId);
                if (!idx?.success || !ownsTerminalTab(targetTabId, targetTabInfo)) return;
                const { layers = [], summaries = [] } = idx.mcp || {};
                const html = `
                    <div>
                        <div style="margin-bottom:8px; color: var(--text-secondary);">层数: ${layers.length}</div>
                        <div>
	                            ${layers.map((l,i)=>`<div style="margin:4px 0;">L${i+1}: 范围 [${escapeHtml(l.range?.[0])}..${escapeHtml(l.range?.[1])}], 摘要 <code>${escapeHtml(l.summaryId)}</code> <button class="btn btn-secondary mcp-peek-btn" data-summary-id="${escapeHtmlAttribute(l.summaryId)}" style="padding:2px 8px; margin-left:6px;">展开</button></div>`).join('')}
                        </div>
                        <hr>
                        <div>
	                            ${summaries.map(s=>`<div style="margin:4px 0;"><code>${escapeHtml(s.id)}</code>: ${escapeHtml(s.title)} (${escapeHtml(s.children)} 项) <button class="btn btn-secondary mcp-peek-btn" data-summary-id="${escapeHtmlAttribute(s.id)}" style="padding:2px 8px; margin-left:6px;">展开</button></div>`).join('')}
                        </div>
                    </div>
                `;
                const entry = {
                    icon: '🗂️',
                    label: 'MCP 索引',
                    summary: `共${layers.length}层`,
                    time: formatTime(new Date()),
                    html: true,
                    htmlContent: html
                };
	                withTakeoverFlowState(targetTabId, () => {
	                    takeoverFlowData.push(entry);
	                });
            });

            // 面板内“展开”摘要（嵌套树形显示，不注入历史）
            flowList && flowList.addEventListener('click', async (e) => {
                const btn = e.target.closest('.mcp-peek-btn');
                if (!btn) return;
                const sid = btn.getAttribute('data-summary-id');
                // 找到所在行，作为嵌套容器的父节点
                const row = btn.closest('div');
                if (!row) return;
	                let container = Array.from(row.querySelectorAll('.mcp-children'))
	                    .find((candidate) => candidate.dataset.parentSummaryId === sid);
                if (container) {
                    // 已存在则切换显示/隐藏
                    container.style.display = (container.style.display === 'none') ? 'block' : 'none';
                    btn.textContent = container.style.display === 'none' ? '展开摘要' : '收起摘要';
                    return;
                }
                // 创建容器并加载第一页
                container = document.createElement('div');
                container.className = 'mcp-children';
                container.setAttribute('data-parent-summary-id', sid);
                container.style.marginLeft = '12px';
                container.style.paddingLeft = '8px';
                container.style.borderLeft = '2px solid var(--border-color)';
                row.appendChild(container);

	                const targetTabId = activeTabId;
	                const targetTabInfo = terminalTabs.get(targetTabId);
	                const details = await window.electronAPI.aiContextSummaryDetails(sid, 0, 50, targetTabId);
	                if (!ownsTerminalTab(targetTabId, targetTabInfo) || !btn.isConnected || !container.isConnected) return;
                if (!details || !details.success) { showNotification(`展开失败: ${details?.error || '未知错误'}`, 'error'); return; }
                const html = (details.results || []).map(r => `
	                    <div class=\"mcp-msg-row\" data-idx=\"${escapeHtmlAttribute(r.index)}\" data-nsid=\"${escapeHtmlAttribute(r.nestedSummaryId || '')}\" style=\"display:flex; gap:8px; align-items:center; margin:4px 0;\">
	                        <span style=\"color: var(--text-secondary);\">[#${escapeHtml(r.index)} ${escapeHtml(r.role)}]</span>
	                        <span style=\"flex:1;\">${escapeHtml(r.snippet)}</span>
	                        ${r.isSummaryMsg && r.nestedSummaryId ? `<button class=\"btn btn-secondary mcp-peek-btn\" data-summary-id=\"${escapeHtmlAttribute(r.nestedSummaryId)}\" style=\"padding:2px 8px;\">展开摘要</button>` : ''}
	                        <button class=\"btn btn-secondary mcp-msg-toggle\" data-index=\"${escapeHtmlAttribute(r.index)}\" style=\"padding:2px 8px;\">展开原文</button>
	                    </div>
	                    <div class=\"mcp-msg-full\" data-index=\"${escapeHtmlAttribute(r.index)}\" style=\"display:none; margin:4px 0 8px 0;\"><pre style=\"white-space:pre-wrap;\">(加载中...)</pre></div>
	                `).join('');
	                container.innerHTML = sanitizeInteractiveHtml(html + (details.hasMore ? `<div style=\"margin-top:8px;\"><button class=\"btn btn-secondary mcp-load-more\" data-summary-id=\"${escapeHtmlAttribute(sid)}\" data-offset=\"${escapeHtmlAttribute(details.nextOffset)}\" style=\"padding:4px 10px;\">加载更多</button></div>` : ''));
                btn.textContent = '收起摘要';
            });

            // 面板内“注入”摘要（注入到历史，供模型下一步使用）
            flowList && flowList.addEventListener('click', async (e) => {
                const btn = e.target.closest('.mcp-inject-btn');
                if (!btn) return;
                const sid = btn.getAttribute('data-summary-id');
	                const kw = flowSearchInput?.value || '';
	                const targetTabId = activeTabId;
	                const targetTabInfo = terminalTabs.get(targetTabId);
	                const res = await window.electronAPI.aiContextExpand(sid, kw, targetTabId);
	                if (!ownsTerminalTab(targetTabId, targetTabInfo)) return;
                if (res && res.success) {
                    showNotification(`已注入 ${sid}（${res.count} 条）`, 'success');
                } else {
                    showNotification(`注入失败: ${res?.error || '未知错误'}`, 'error');
                }
            });

            // 展开原文
            flowList && flowList.addEventListener('click', async (e) => {
                const btn = e.target.closest('.mcp-msg-toggle');
                if (!btn) return;
                const idx = parseInt(btn.getAttribute('data-index') || '-1', 10);
                const full = flowList.querySelector(`.mcp-msg-full[data-index="${idx}"]`);
                if (!full) return;
                if (full.style.display === 'none') {
	                    const targetTabId = activeTabId;
	                    const targetTabInfo = terminalTabs.get(targetTabId);
	                    const res = await window.electronAPI.aiContextGetMessage(idx, targetTabId);
	                    if (!ownsTerminalTab(targetTabId, targetTabInfo) || !full.isConnected || !btn.isConnected) return;
                    if (res && res.success) {
                        full.querySelector('pre').textContent = res.content;
                    } else {
                        full.querySelector('pre').textContent = '(加载失败)';
                    }
                    full.style.display = 'block';
                    btn.textContent = '收起原文';
                } else {
                    full.style.display = 'none';
                    btn.textContent = '展开原文';
                }
            });
            

            // 摘要“加载更多”懒加载
            flowList && flowList.addEventListener('click', async (e) => {
                const btn = e.target.closest('.mcp-load-more');
                if (!btn) return;
                const sid = btn.getAttribute('data-summary-id');
                const offset = parseInt(btn.getAttribute('data-offset') || '0', 10);
                btn.disabled = true;
	                const targetTabId = activeTabId;
	                const targetTabInfo = terminalTabs.get(targetTabId);
	                const details = await window.electronAPI.aiContextSummaryDetails(sid, offset, 50, targetTabId);
	                if (!ownsTerminalTab(targetTabId, targetTabInfo) || !btn.isConnected) return;
                if (details && details.success) {
                    const container = btn.closest('.mcp-children') || btn.closest('.takeover-flow-content');
                    const moreRows = (details.results || []).map(r => `
	                        <div class="mcp-msg-row" data-idx="${escapeHtmlAttribute(r.index)}" data-nsid="${escapeHtmlAttribute(r.nestedSummaryId || '')}" style="display:flex; gap:8px; align-items:center; margin:4px 0;">
	                            <span style="color: var(--text-secondary);">[#${escapeHtml(r.index)} ${escapeHtml(r.role)}]</span>
	                            <span style="flex:1;">${escapeHtml(r.snippet)}</span>
	                            ${r.isSummaryMsg && r.nestedSummaryId ? `<button class="btn btn-secondary mcp-peek-btn" data-summary-id="${escapeHtmlAttribute(r.nestedSummaryId)}" style="padding:2px 8px;">展开摘要</button>` : ''}
	                            <button class="btn btn-secondary mcp-msg-toggle" data-index="${escapeHtmlAttribute(r.index)}" style="padding:2px 8px;">展开原文</button>
	                        </div>
	                        <div class="mcp-msg-full" data-index="${escapeHtmlAttribute(r.index)}" style="display:none; margin:4px 0 8px 0;"><pre style="white-space:pre-wrap;">(加载中...)</pre></div>
	                    `).join('');
	                    const wrapper = document.createElement('div');
	                    wrapper.innerHTML = sanitizeInteractiveHtml(moreRows);
                    if (container && btn.parentElement) {
                        container.insertBefore(wrapper, btn.parentElement);
                    } else if (btn.parentElement) {
                        btn.parentElement.before(wrapper);
                    }
                    if (details.hasMore) {
                        btn.disabled = false;
                        btn.setAttribute('data-offset', String(details.nextOffset));
                    } else if (btn.parentElement) {
                        btn.parentElement.remove();
                    }
                } else {
                    btn.disabled = false;
                    showNotification(`加载失败: ${details?.error || '未知错误'}`, 'error');
                }
            });

            // 手动重试
	            retryTakeoverBtn && retryTakeoverBtn.addEventListener('click', async () => {
	            	const targetTabId = activeTabId;
	            	const targetInfo = terminalTabs.get(targetTabId);
                try {
	                    const res = await window.electronAPI.aiTakeoverRetry(targetTabId);
	                    if (!ownsTerminalTab(targetTabId, targetInfo)) return;
	                    if (res && res.success) {
	                        targetInfo.aiTakeoverMode = true;
	                        if (activeTabId === targetTabId) updateTakeoverButtons();
	                        showNotification('已重新开始接管', 'success');
	                        if (activeTabId === targetTabId) retryTakeoverBtn.style.display = 'none';
                    } else {
                        showNotification('重试失败: ' + (res?.error || '未知错误'), 'error');
                    }
                } catch (e) {
                    showNotification('重试失败: ' + e.message, 'error');
                }
            });

            // 更新按钮显示状态
            function getDefaultTakeoverLabel() {
		                if (getActiveTabInfo()?.aiWaitingForUserInput) return '💬 输入并继续';
	                if (getActiveTabInfo()?.aiControlMode !== 'host') return '接管当前终端';
	                return canSendToSsh(activeTabId) ? 'AI 接管 · SSH' : 'AI 接管 · 本地';
            }

            function resetTakeoverStartButtonLabel() {
                const startBtn = document.getElementById('startTakeover');
                if (!startBtn) return;
	                if (getActiveTabInfo()?.aiWaitingForUserInput) return;
                startBtn.innerHTML = getDefaultTakeoverLabel();
            }

            function updateTakeoverButtons() {
                const compressContextBtn = document.getElementById('compressContext');
	                const tabInfo = getActiveTabInfo();
                    const modeSelect=document.getElementById('aiControlMode');
                    if(modeSelect) {
                        modeSelect.value=tabInfo?.aiControlMode||'terminal';
                        modeSelect.disabled=!!(tabInfo?.aiTakeoverMode||tabInfo?.aiWaitingForUserInput||tabInfo?.aiTakeoverStarting);
                    }
	                isTakeoverMode = !!tabInfo?.aiTakeoverMode;
	                window.aiWaitingForUserInput = !!tabInfo?.aiWaitingForUserInput;
                
                if (!isTakeoverMode) {
                    startTakeoverBtn.style.display = 'inline-flex';
                    stopTakeoverBtn.style.display = 'none';
                    if (compressContextBtn) compressContextBtn.style.display = 'none';
                    if (retryTakeoverBtn) retryTakeoverBtn.style.display = 'none';
                    resetTakeoverStartButtonLabel();
                    return;
                }

                // takeover running
                startTakeoverBtn.style.display = 'none';
                stopTakeoverBtn.style.display = 'inline-flex';
                if (compressContextBtn) compressContextBtn.style.display = tabInfo?.aiTakeoverTarget==='terminal' ? 'none' : 'inline-flex';
                if (retryTakeoverBtn) retryTakeoverBtn.style.display = 'none';
            }
            
            // 启动AI接管模式（防止重复触发）
	            function parseTakeoverStartRequest(rawTask, tabId = activeTabId) {
	                const raw = (rawTask || '').trim();
	                let target = terminalTabs.get(tabId)?.aiControlMode === 'host' ? (canSendToSsh(tabId) ? 'remote' : 'local') : 'terminal';
                let task = raw;

                // 支持前缀: local:/本地: remote:/远程: hybrid:/混合:
                const m = /^(terminal|终端|local|本地|remote|远程|hybrid|混合)\s*[:：]\s*(.*)$/i.exec(raw);
                const m2 = m ? null : /^(terminal|终端|local|本地|remote|远程|hybrid|混合)\s+(.*)$/i.exec(raw);
                const hit = m || m2;
                if (hit) {
                    const k = (hit[1] || '').toLowerCase();
                    const rest = (hit[2] || '').trim();
                    if (k === 'local' || k === '本地') target = 'local';
                    else if (k === 'remote' || k === '远程') target = 'remote';
                    else if (k === 'hybrid' || k === '混合') target = 'hybrid';
                    else if (k === 'terminal' || k === '终端') target = 'terminal';
                    task = rest || raw;
                }

                return { target, task };
            }

	            startTakeoverBtn.addEventListener('click', async () => {
	                const takeoverTabId = activeTabId;
	                const takeoverTabInfo = terminalTabs.get(takeoverTabId);
	                if (!takeoverTabInfo || takeoverTabInfo.aiTakeoverStarting) return;
                        if (takeoverTabInfo.pendingRemote) { workspace?.message('请先连接此 SSH 会话，再启动 AI 接管。'); return; }
	                const task = commandInput.value.trim();
                if (!task) {
                    showNotification('请在输入框中输入要执行的任务', 'warning');
                    commandInput.focus();
                    return;
                }
                
                try {
	                    takeoverTabInfo.aiTakeoverStarting = true;
                    startTakeoverBtn.disabled = true;
                    // 以“用户输入”为顶层分组，把此次输入加入简洁流程
                    beginUserGroup(task);
                    // 检查是否是回复AI的问题或打断后的继续
	                    if (takeoverTabInfo.aiWaitingForUserInput) {
                        // 判断是回复问题还是打断后的新指示
	                        const isInterrupted = !!takeoverTabInfo.aiTakeoverInterrupted;
                        
                        const result = isInterrupted 
	                            ? await window.electronAPI.aiTakeoverResume(task, takeoverTabId)
	                            : await window.electronAPI.aiTakeoverContinue(task, takeoverTabId);
                            
	                        if (!ownsTerminalTab(takeoverTabId, takeoverTabInfo)) return;
	                        if (result?.stopped) {
                                takeoverTabInfo.aiTakeoverMode = false;
                                takeoverTabInfo.aiWaitingForUserInput = false;
                                takeoverTabInfo.aiTakeoverInterrupted = false;
                                if(activeTabId===takeoverTabId) {commandInput.value='';syncTakeoverUiForTab(takeoverTabId);}
	                        } else if (result?.success) {
	                            takeoverTabInfo.aiTakeoverMode = true;
	                            takeoverTabInfo.aiWaitingForUserInput = false;
	                            takeoverTabInfo.aiTakeoverInterrupted = false;
	                            if (activeTabId === takeoverTabId) {
	                                updateTakeoverButtons();
	                                commandInput.value = '';
	                                commandInput.placeholder = '🤖 AI接管模式运行中...';
	                                commandInput.disabled = true;
	                                window.aiWaitingForUserInput = false;
	                                if(takeoverTabInfo.aiTakeoverTarget!=='terminal')openFlowModal();
	                            }
	                            showNotification('AI接管模式继续执行', 'success');
                        } else {
                            showNotification('继续失败: ' + result.error, 'error');
                        }
                    } else {
                        // 正常启动AI接管模式
	                        const req = parseTakeoverStartRequest(task, takeoverTabId);
	                        takeoverTabInfo.aiTakeoverTarget=req.target;
                            takeoverTabInfo.terminalAgentLog=[];
	                        if ((req.target === 'remote' || req.target === 'hybrid') && !canSendToSsh(takeoverTabId)) {
	                            showNotification('需要SSH连接才能启动远程/混合AI接管模式', 'error');
	                            return;
	                        }
	                        const result = await window.electronAPI.aiTakeoverStart({ task: req.task, target: req.target }, takeoverTabId);
	                        if (!ownsTerminalTab(takeoverTabId, takeoverTabInfo)) return;
	                        if (result?.success) {
	                            // 更新当前标签页的AI接管状态
	                            const currentTabInfo = terminalTabs.get(takeoverTabId);
                            if (currentTabInfo) {
                                currentTabInfo.aiTakeoverMode = true;
	                                currentTabInfo.aiWaitingForUserInput = false;
                            }
	                            if (activeTabId === takeoverTabId && aiTakeoverManager && typeof aiTakeoverManager.updateTakeoverButtons === 'function') {
                                aiTakeoverManager.updateTakeoverButtons();
                            }
	                            if (activeTabId === takeoverTabId) {
	                                commandInput.value = '';
	                                commandInput.placeholder = '🤖 AI接管模式运行中...';
	                                commandInput.disabled = true;
	                                if(req.target!=='terminal')openFlowModal();
	                            }
	                            showNotification('AI接管模式已启动', 'success');
                        } else {
                            showNotification('启动失败: ' + result.error, 'error');
                        }
                    }
                } catch (error) {
                    showNotification('启动失败: ' + error.message, 'error');
                } finally {
	                    if (ownsTerminalTab(takeoverTabId, takeoverTabInfo)) takeoverTabInfo.aiTakeoverStarting = false;
	                    if (activeTabId === takeoverTabId) startTakeoverBtn.disabled = false;
                }
            });
            
            // 停止AI接管模式
            stopTakeoverBtn.addEventListener('click', async () => {
	            	const targetTabId = activeTabId;
	                const targetTabInfo = terminalTabs.get(targetTabId);
                try {
	                    const result = await window.electronAPI.aiTakeoverStop(targetTabId);
	                    if (!ownsTerminalTab(targetTabId, targetTabInfo)) return;
	                    if (result && result.success === false) throw new Error(result.error || '未知错误');
	                    // 更新当前标签页的AI接管状态
	                    targetTabInfo.aiTakeoverMode = false;
	                    targetTabInfo.aiWaitingForUserInput = true;
	                    targetTabInfo.aiTakeoverInterrupted = true;
	                    if (activeTabId === targetTabId) {
	                        if (aiTakeoverManager && typeof aiTakeoverManager.updateTakeoverButtons === 'function') {
	                            aiTakeoverManager.updateTakeoverButtons();
	                        }
	                        commandInput.disabled = false;
	                        commandInput.placeholder = '描述你想完成的任务，或输入 / 选择命令…';
	                        showNotification('AI接管模式已停止', 'info');
                    }
                } catch (error) {
                    showNotification('停止失败: ' + error.message, 'error');
                }
            });
            
            // 压缩上下文
            const compressContextBtn = document.getElementById('compressContext');
            if (compressContextBtn) {
                compressContextBtn.addEventListener('click', async () => {
	                	const targetTabId = activeTabId;
	                    const targetTabInfo = terminalTabs.get(targetTabId);
                    try {
	                        const result = await window.electronAPI.aiTakeoverCompressContext(targetTabId);
	                        if (!ownsTerminalTab(targetTabId, targetTabInfo)) return;
                        if (result.success) {
                            showNotification('上下文压缩成功', 'success');
	                            withTakeoverFlowState(targetTabId, () => {
                            // 将现有对话包装到“历史记录/详细历史”树中
                            const hasHistory = (takeoverFlowData || []).some(e => e && e.label === '历史记录');
                            if (!hasHistory) {
                                const past = (takeoverFlowData || []).slice();
                                const detail = {
                                    kind: 'history_detail',
                                    icon: '📜',
                                    label: '详细历史',
                                    summary: `共${past.length}项`,
                                    time: formatTime(new Date()),
                                    children: past
                                };
                                const history = {
                                    kind: 'history',
                                    icon: '🗂️',
                                    label: '历史记录',
                                    summary: '已压缩对话',
                                    time: formatTime(new Date()),
                                    children: [detail]
                                };
                                takeoverFlowData = [history];
                                // 清理当前进行中的引用，允许后续“新用户输入”作为新顶层项
                                currentUserGroupEntry = null;
                                currentUserGroupElement = null;
                                currentReplyEntry = null;
                                currentReplyElement = null;
                                currentStreamingChildEl = null;
                                currentStreamingChildObj = null;
                                lastReplChildEl = null;
                                // 重新渲染
                                if (flowModal && flowList) {
                                    flowList.innerHTML = '';
                                    takeoverFlowData.forEach((entry, idx) => flowList.appendChild(renderFlowItem(idx, entry)));
                                    flowModal.style.display = 'block';
	                                }
                            }
	                            });
                        } else {
                            showNotification('压缩失败: ' + result.error, 'error');
                        }
                    } catch (error) {
                        showNotification('压缩失败: ' + error.message, 'error');
                    }
                });
            }

	            function syncTakeoverUiForTab(tabId = activeTabId) {
	                if (tabId !== activeTabId) return;
	                const tabInfo = terminalTabs.get(tabId);
	                if (!tabInfo) return;
	                isTakeoverMode = !!tabInfo.aiTakeoverMode;
	                window.aiWaitingForUserInput = !!tabInfo.aiWaitingForUserInput;
	                updateTakeoverButtons();
	                if (tabInfo.aiWaitingForUserInput) {
	                    commandInput.disabled = false;
	                    commandInput.placeholder = tabInfo.aiTakeoverInterrupted
	                        ? '请输入新的指示或说"退出"来结束AI接管模式...'
	                        : '请回复AI的问题，然后点击"🤖 AI接管"继续...';
	                    startTakeoverBtn.innerHTML = '💬 输入并继续';
	                } else if (tabInfo.aiTakeoverMode) {
	                    commandInput.disabled = true;
	                    commandInput.placeholder = '🤖 AI接管模式运行中...';
	                } else {
	                    commandInput.disabled = false;
	                    commandInput.placeholder = '描述你想完成的任务，或输入 / 选择命令…';
	                    resetTakeoverStartButtonLabel();
	                }
	            }

	            function handleTabTakeoverUpdate(update) {
	                const targetTabId = update?.tabId;
	                const tabInfo = terminalTabs.get(targetTabId);
	                if (!targetTabId || !tabInfo) return true;
	                appendTakeoverFlow(update, targetTabId);

	                if (['start', 'thinking', 'streaming', 'analysis', 'executing', 'result', 'waiting', 'repl_output'].includes(update.type)) {
	                    tabInfo.aiTakeoverMode = true;
	                    tabInfo.aiWaitingForUserInput = false;
	                } else if (update.type === 'user_input' || update.type === 'interrupted') {
	                    tabInfo.aiTakeoverMode = false;
	                    tabInfo.aiWaitingForUserInput = true;
	                    tabInfo.aiTakeoverInterrupted = update.type === 'interrupted';
	                } else if (update.type === 'complete' || update.type === 'stop' || update.type === 'error') {
	                    tabInfo.aiTakeoverMode = false;
	                    tabInfo.aiWaitingForUserInput = false;
	                    tabInfo.aiTakeoverInterrupted = false;
	                }

	                const colorMap = {
	                    start: '\x1b[32m', thinking: '\x1b[33m', streaming: '\x1b[36m', analysis: '\x1b[36m',
	                    executing: '\x1b[35m', result: '\x1b[37m', complete: '\x1b[32m', error: '\x1b[31m',
	                    stop: '\x1b[31m', user_input: '\x1b[33m', interrupted: '\x1b[33m', repl_output: '\x1b[37m'
	                };
	                const color = colorMap[update.type] || '\x1b[37m';
	                const message = String(update.message || '');
                    if(update.surface==='terminal') {
                        tabInfo.aiTakeoverTarget='terminal';
                        const log=tabInfo.terminalAgentLog ||= [];
                        if(update.type!=='thinking')log.push(message);
                        if(log.length>30)log.splice(0,log.length-30);
                        const escaped=log.join('\n\n').replace(/[&<>]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[char]));
                        renderAiResult({response:'### 当前终端接管\n\n目标绑定此会话，切换窗格不会转移任务。\n\n<pre>'+escaped+'</pre>',command:'当前终端接管',forcePanel:true},true,targetTabId);
                    }
	                if (update.surface!=='terminal' && getTabTerminal(targetTabId)) {
	                    if (update.type === 'streaming') {
	                        if (!tabInfo.aiTakeoverStreamStarted) {
	                            writeToTerminalTab(targetTabId, `\r\n${color}[AI接管] 💭 AI正在思考，等待AI回复中...\x1b[0m\r\n`);
	                            tabInfo.aiTakeoverStreamStarted = true;
	                            tabInfo.aiTakeoverLastStreamContent = '';
	                        }
	                        const previous = tabInfo.aiTakeoverLastStreamContent || '';
	                        const newContent = message.startsWith(previous) ? message.substring(previous.length) : message;
	                        if (newContent) writeToTerminalTab(targetTabId, `${color}${newContent}\x1b[0m`);
	                        tabInfo.aiTakeoverLastStreamContent = message;
	                        if (update.isComplete) {
	                            writeToTerminalTab(targetTabId, '\r\n');
	                            tabInfo.aiTakeoverStreamStarted = false;
	                            tabInfo.aiTakeoverLastStreamContent = '';
	                        }
	                    } else {
	                        writeToTerminalTab(targetTabId, `\r\n${color}[AI接管] ${message}\x1b[0m\r\n`);
	                        tabInfo.aiTakeoverStreamStarted = false;
	                        tabInfo.aiTakeoverLastStreamContent = '';
	                    }
	                }

	                if (targetTabId !== activeTabId) return true;
	                syncTakeoverUiForTab(targetTabId);
	                const stopTakeoverText = document.getElementById('stopTakeoverText');
	                if (stopTakeoverText) {
	                    stopTakeoverText.textContent = (update.type === 'thinking' || update.type === 'streaming')
	                        ? '⚡ 打断'
	                        : (update.type === 'executing' ? '🛑 停止' : '🛑 停止接管');
	                }
	                if (update.type === 'user_input' || (update.type === 'interrupted' && update.surface !== 'terminal')) commandInput.focus();
	                if (update.type === 'error' && retryTakeoverBtn) retryTakeoverBtn.style.display = 'inline-flex';
	                if (update.type === 'complete' || update.type === 'stop' || update.type === 'error') startTakeoverBtn.disabled = false;
	                return true;
	            }
            
		            // 监听AI接管模式更新
		            if (window.electronAPI?.onAiTakeoverUpdate) window.electronAPI.onAiTakeoverUpdate((update) => {
		                handleTabTakeoverUpdate(update);
		            });
            
            // 添加回车键监听 - 使用keydown确保在其他事件之前处理
            commandInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    // 检查是否在AI接管相关状态
	                    const activeTakeoverInfo = getActiveTabInfo();
	                    if (activeTakeoverInfo?.aiTakeoverMode || activeTakeoverInfo?.aiWaitingForUserInput) {
                        e.preventDefault(); // 阻止默认的回车行为
                        e.stopPropagation(); // 阻止事件冒泡
                        
                        // 检查是否输入了退出指令
                        const input = commandInput.value.trim();
                        if (['退出','结束','exit'].includes(input.toLowerCase())) {
                            // 直接退出接管模式
	                            const targetTabId = activeTabId;
	                            const targetTabInfo = activeTakeoverInfo;
	                            const stop = targetTabInfo.aiTakeoverTarget === 'terminal'
                                    ? window.electronAPI.aiTakeoverContinue('退出',targetTabId)
                                    : window.electronAPI.aiTakeoverStop(targetTabId);
	                            stop.then((result) => {
	                                if (!ownsTerminalTab(targetTabId, targetTabInfo)) return;
	                                if (result && result.success === false) throw new Error(result.error || '未知错误');
	                                targetTabInfo.aiTakeoverMode = false;
	                                targetTabInfo.aiWaitingForUserInput = false;
                                if (activeTabId !== targetTabId) return;
                                isTakeoverMode = false;
                                window.aiWaitingForUserInput = false;
                                updateTakeoverButtons();
                                commandInput.disabled = false;
                                commandInput.value = '';
                                commandInput.placeholder = '描述你想完成的任务，或输入 / 选择命令…';
                                
                                // 恢复按钮文本
                                resetTakeoverStartButtonLabel();
	                            }).catch((error) => {
	                                if (ownsTerminalTab(targetTabId, targetTabInfo) && activeTabId === targetTabId) {
	                                    showNotification('停止失败: ' + error.message, 'error');
	                                }
	                            });
                        } else {
                            // 正常继续AI接管
                            startTakeoverBtn.click();
                        }
                    }
                    // 如果不在AI接管状态，让回车键正常工作（触发普通对话）
                }
            });
            
            // 返回更新函数供外部调用
	            function switchTakeoverTab(tabId) {
	                saveTakeoverFlowState(flowStateTabId);
	                loadTakeoverFlowState(tabId);
	                if (flowModal?.style.display !== 'none') openFlowModal();
	                syncTakeoverUiForTab(tabId);
	            }
	            loadTakeoverFlowState(activeTabId);
	            return { updateTakeoverButtons, switchTab: switchTakeoverTab };
        }

        // 通知函数
        function showNotification(message, type = 'info') {
            const notification = document.createElement('div');
            notification.className = `notification ${type}`;
            notification.textContent = message;
            notification.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                padding: 12px 20px;
                border-radius: 6px;
                color: white;
                font-weight: 500;
                z-index: 10000;
                opacity: 0;
                transform: translateX(100%);
                transition: all 0.3s ease;
            `;
            
            const colors = {
                'success': '#198754',
                'error': '#dc3545',
                'warning': '#ffc107',
                'info': '#0d6efd'
            };
            
            notification.style.background = colors[type] || colors.info;
            document.body.appendChild(notification);
            
            // 显示动画
            setTimeout(() => {
                notification.style.opacity = '1';
                notification.style.transform = 'translateX(0)';
            }, 100);
            
            // 自动隐藏
            setTimeout(() => {
                notification.style.opacity = '0';
                notification.style.transform = 'translateX(100%)';
                setTimeout(() => {
                    document.body.removeChild(notification);
                }, 300);
            }, 3000);
        }

        // AI接管模式管理器
        let aiTakeoverManager = null;

        // 在页面加载完成后初始化AI接管模式
        document.addEventListener('DOMContentLoaded', () => {
            aiTakeoverManager = initAiTakeoverMode();
        });

        // This bridge exists only for the real Electron clipboard smoke test.
        // It is query-gated so normal renderer pages never expose terminal internals.
        try {
            const smokeQuery = new URL(window.location.href).searchParams;
            if (smokeQuery.get('aiterminal-clipboard-smoke') === '1') {
                Object.defineProperty(window, '__aiterminalClipboardSmoke', {
                    configurable: false,
                    enumerable: false,
                    value: Object.freeze({
                        getTerminal: (tabId) => terminalTabs.get(tabId)?.terminal || null,
                        stopLocalTerminal: (tabId) => stopLocalTerminalForTab(tabId)
                    })
                });
            }
        } catch {}
