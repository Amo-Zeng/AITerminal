'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { runElectronSmoke } = require('./clipboardSmoke');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(check, description) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (await check()) return;
        await delay(50);
    }
    throw new Error(`terminal interaction timed out: ${description}`);
}

async function runChecks({ client, evaluate }) {
    const write = async (data) => evaluate(`new Promise(resolve => terminalTabs.get('tab-1').terminal.write(${JSON.stringify(data)}, resolve))`);
    const mouse = async (type, col, row, extra = {}) => {
        const pos = await evaluate(`(() => {
            const t = terminalTabs.get('tab-1').terminal;
            const r = t.element.querySelector('.xterm-screen').getBoundingClientRect();
            return { x: r.x + (${col} + 0.5) * r.width / t.cols, y: r.y + (${row} + 0.5) * r.height / t.rows };
        })()`);
        await client.send('Input.dispatchMouseEvent', { type, ...pos, ...extra });
    };
    const click = async (button, col, row, modifiers = 0) => {
        await mouse('mousePressed', col, row, { button, clickCount: 1, modifiers });
        await mouse('mouseReleased', col, row, { button, clickCount: 1, modifiers });
    };
    const wheel = (deltaY, modifiers = 0, col = 4, row = 4) => mouse('mouseWheel', col, row, { deltaX: 0, deltaY, modifiers });

    await evaluate(`(async () => {
        window.__originalClipboard = await window.electronAPI.clipboardReadText('tab-1');
        stopLocalTerminalForTab('tab-1');
        // Suppress automatic shell restart during the renderer protocol checks.
        terminalTabs.get('tab-1').sshConnecting = true;
    })()`);
    await delay(200);
    await evaluate(`(() => {
        const t = terminalTabs.get('tab-1').terminal;
        t.reset();
        window.__input = [];
        window.__binary = [];
        window.__listeners = [t.onData(s => window.__input.push(s)), t.onBinary(s => window.__binary.push([...s].map(c => c.charCodeAt(0))))];
    })()`);
    try {
        // A terminal LF does not imply CR. Right pane redraws depend on this.
        await write('\x1b[5;40HR\nN');
        assert.equal(await evaluate("terminalTabs.get('tab-1').terminal.buffer.active.getLine(5).getCell(40).getChars()"), 'N', 'LF must preserve the pane column');
        await write('\x1b[H中😀X');
        assert.equal(await evaluate("terminalTabs.get('tab-1').terminal.buffer.active.getLine(0).getCell(4).getChars()"), 'X', 'CJK and emoji must occupy two cells each');

        await evaluate("terminalTabs.get('tab-1').terminal.reset()");
        await write('RIGHT_CLICK_COPY');
        await evaluate("terminalTabs.get('tab-1').terminal.select(0, 0, 16)");
        await click('right', 2, 0);
        await eventually(() => evaluate("(async () => (await window.electronAPI.clipboardReadText('tab-1')).text === 'RIGHT_CLICK_COPY' && !terminalTabs.get('tab-1').terminal.hasSelection())()"), 'right click copies selection');
        await evaluate("window.electronAPI.clipboardWriteText('RIGHT_CLICK_PASTE', 'tab-1')");
        await click('right', 2, 0);
        await eventually(() => evaluate("window.__input.includes('RIGHT_CLICK_PASTE')"), 'right click pastes');

        await write('\x1b[?1000h\x1b[?1006h');
        await evaluate('window.__input = []');
        await click('right', 8, 3);
        await eventually(() => evaluate("window.__input.includes('\x1b[<2;9;4M') && window.__input.includes('\x1b[<2;9;4m')"), 'right button reaches application in SGR mouse mode');
        assert.equal(await evaluate("window.__input.includes('RIGHT_CLICK_PASTE')"), false, 'application right click must not paste');
        await wheel(-120);
        await eventually(() => evaluate("window.__input.some(s => s.startsWith('\x1b[<64;'))"), 'wheel up reports mouse button 64');
        await wheel(120);
        await eventually(() => evaluate("window.__input.some(s => s.startsWith('\x1b[<65;'))"), 'wheel down reports mouse button 65');
        await evaluate('window.__input = []');
        await click('right', 8, 3, 8); // CDP Shift mask
        await eventually(() => evaluate("window.__input.includes('RIGHT_CLICK_PASTE')"), 'Shift right click bypasses application mouse mode');

        await write('\x1b[?1006l');
        const legacyCol = await evaluate("Math.min(100, terminalTabs.get('tab-1').terminal.cols - 1)");
        await click('left', legacyCol, 3);
        await eventually(() => evaluate(`window.__binary.some(b => b[0] === 27 && b[2] === 77 && b[4] === ${legacyCol + 33})`), 'legacy binary mouse coordinates');

        await write('\x1b[?1000l');
        await evaluate('window.__input = []');
        await write(Array.from({ length: 160 }, (_, i) => `history-${i}\r\n`).join(''));
        await evaluate("terminalTabs.get('tab-1').terminal.scrollToBottom()");
        await eventually(() => evaluate(`(() => {
            const t = terminalTabs.get('tab-1').terminal;
            const v = t.element.querySelector('.xterm-viewport');
            return t.buffer.active.baseY > 0 && v.scrollTop > 0 && v.scrollHeight > v.clientHeight;
        })()`), 'scrollback layout committed before wheel input');
        await wheel(-160);
        await eventually(() => evaluate("terminalTabs.get('tab-1').terminal.buffer.active.viewportY < terminalTabs.get('tab-1').terminal.buffer.active.baseY"), 'normal buffer scrollback');
        assert.deepEqual(await evaluate('window.__input'), [], 'scrollback must not type arrow keys');
        await write('\x1b[?1049h');
        await wheel(-120);
        await delay(100);
        assert.deepEqual(await evaluate('window.__input'), [], 'wheel without mouse mode must not cycle tmux shell history');
        await write('\x1b[?1049l');
        console.log('Terminal interaction smoke ok: LF, Unicode widths, right click, SGR/binary mouse, wheel');

        if (process.argv.includes('--tmux')) await checkTmux({ evaluate, client, click, wheel });
    } finally {
        await evaluate(`(async () => {
            for (const listener of window.__listeners || []) listener.dispose();
            if (window.__originalClipboard?.success) await window.electronAPI.clipboardWriteText(window.__originalClipboard.text || '', 'tab-1');
        })()`);
    }
}

async function checkTmux({ evaluate, click, wheel }) {
    const socket = `ait-smoke-${process.pid}-${Date.now()}`;
    const env = { ...process.env, TERM: 'xterm-256color' };
    delete env.TMUX;
    delete env.TMUX_PANE;
    const tmux = (...args) => execFileSync('tmux', ['-L', socket, ...args], { env, encoding: 'utf8', timeout: 10000 }).trimEnd();
    const size = await evaluate("({cols: terminalTabs.get('tab-1').terminal.cols, rows: terminalTabs.get('tab-1').terminal.rows})");
    let mismatch;
    try {
        tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'smoke', '-x', String(size.cols), '-y', String(size.rows), '/bin/sh');
        tmux('set-option', '-g', 'mouse', 'on');
        tmux('set-option', '-g', 'status', 'off');
        tmux('split-window', '-h', '-t', 'smoke:0', '/bin/sh');
        for (const pane of ['0', '1']) {
            const marker = pane === '0' ? 'LEFT' : 'RIGHT';
            tmux('send-keys', '-t', `smoke:0.${pane}`, `printf '\\033[2J\\033[H'; i=0; while [ "$i" -lt 80 ]; do printf '${marker}-%03d 中😀\\n' "$i"; i=$((i+1)); done`, 'Enter');
        }
        await evaluate(`(async () => {
            const info = terminalTabs.get('tab-1');
            info.sshConnecting = false;
            await startLocalTerminalForTab('tab-1');
        })()`);
        await evaluate(`window.electronAPI.terminalLocalSend('tab-1', ${JSON.stringify(`env -u TMUX tmux -L ${socket} attach-session -t smoke\r`)})`);
        await eventually(() => evaluate("terminalTabs.get('tab-1').terminal.buffer.active.type === 'alternate' && terminalTabs.get('tab-1').terminal.modes.mouseTrackingMode !== 'none'"), 'real tmux attached to local PTY');

        const panes = () => tmux('list-panes', '-t', 'smoke:0', '-F', '#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height}').split('\n').map(line => {
            const [id, left, top, width, height] = line.split(' ');
            return { id, left: +left, top: +top, width: +width, height: +height };
        });
        const aligned = async () => {
            for (const pane of panes()) {
                const expected = tmux('capture-pane', '-p', '-t', pane.id).split('\n').map(s => s.trimEnd());
                const actual = await evaluate(`(() => {
                    const b = terminalTabs.get('tab-1').terminal.buffer.active;
                    return Array.from({ length: ${pane.height} }, (_, i) => b.getLine(b.baseY + i + ${pane.top})?.translateToString(true, ${pane.left}, ${pane.left + pane.width}) || '');
                })()`);
                for (let row = 0; row < pane.height; row++) {
                    if ((actual[row] || '').trimEnd() !== (expected[row] || '')) {
                        mismatch = { pane, row, actual: actual[row], expected: expected[row] };
                        return false;
                    }
                }
            }
            return true;
        };
        await eventually(aligned, 'both tmux panes match their PTY screen, including CJK and emoji');
        // Real layout changes, including non-integer cell widths and font changes.
        for (const width of ['73%', '100%']) {
            const beforeCols = await evaluate("terminalTabs.get('tab-1').terminal.cols");
            await evaluate(`terminalTabs.get('tab-1').container.style.setProperty('max-width', '${width}', 'important')`);
            await eventually(async () => {
                const current = await evaluate("({cols: terminalTabs.get('tab-1').terminal.cols, rows: terminalTabs.get('tab-1').terminal.rows})");
                return current.cols !== beforeCols && tmux('list-clients', '-F', '#{client_width} #{client_height}') === `${current.cols} ${current.rows}` && await aligned();
            }, `tmux resize at ${width}`);
        }
        for (const fontSize of [13, 16, 14]) {
            const beforeCols = await evaluate("terminalTabs.get('tab-1').terminal.cols");
            await evaluate(`(() => {
                terminalTabs.get('tab-1').terminal.options.fontSize = ${fontSize};
                scheduleFitTerminalTab('tab-1', { syncSsh: true });
            })()`);
            await eventually(async () => await evaluate("terminalTabs.get('tab-1').terminal.cols") !== beforeCols && await aligned(), `tmux font size ${fontSize}`);
        }
        await evaluate("renderAiResult({response:'Tmux layout regression',command:'ai'},true,'tab-1')");
        await eventually(async () => {
            const fit = await evaluate("terminalTabs.get('tab-1').terminal.cols < " + size.cols * 0.7);
            return fit && await aligned();
        }, 'tmux fits alongside the AI panel');
        await evaluate("closeAiResult(true,'tab-1')");
        await eventually(async () => await evaluate("terminalTabs.get('tab-1').terminal.cols") === size.cols && await aligned(), 'tmux restores full width');

        // Compare real rendered divider positions, not just the parsed buffer.
        const divider = panes()[1].left - 1;
        await eventually(() => evaluate(`(() => {
            const t = terminalTabs.get('tab-1').terminal;
            const rows = t.element.querySelectorAll('.xterm-rows > div');
            const screen = t.element.querySelector('.xterm-screen').getBoundingClientRect();
            const expectedX = screen.x + ${divider} * screen.width / t.cols;
            let checked = 0;
            for (const row of rows) {
                const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
                while (walker.nextNode()) {
                    const node = walker.currentNode;
                    const index = node.textContent.indexOf('│');
                    if (index < 0) continue;
                    const range = document.createRange();
                    range.setStart(node, index); range.setEnd(node, index + 1);
                    if (Math.abs(range.getBoundingClientRect().x - expectedX) > 1) return false;
                    checked++;
                }
            }
            return checked >= t.rows - 2;
        })()`), 'rendered tmux divider stays on its character column');
        const left = panes()[0];
        await click('left', left.left + 3, left.top + 3);
        await eventually(() => tmux('display-message', '-p', '-t', 'smoke:0', '#{pane_id}') === left.id, 'mouse selects left pane');
        await wheel(-120, 0, left.left + 3, left.top + 3);
        await eventually(() => tmux('display-message', '-p', '-t', left.id, '#{pane_in_mode}') === '1', 'wheel enters tmux copy mode');
        const scrollBefore = +tmux('display-message', '-p', '-t', left.id, '#{scroll_position}');
        await wheel(-120, 0, left.left + 3, left.top + 3);
        await eventually(() => +tmux('display-message', '-p', '-t', left.id, '#{scroll_position}') > scrollBefore, 'wheel up scrolls pane history');
        const up = +tmux('display-message', '-p', '-t', left.id, '#{scroll_position}');
        await wheel(120, 0, left.left + 3, left.top + 3);
        await eventually(() => +tmux('display-message', '-p', '-t', left.id, '#{scroll_position}') < up, 'wheel down scrolls pane history');
        if (tmux('display-message', '-p', '-t', left.id, '#{pane_in_mode}') === '1') tmux('send-keys', '-t', left.id, '-X', 'cancel');
        await eventually(aligned, 'pane redraw after scrolling');

        const right = panes()[1];
        const binaryCol = Math.min(size.cols - 2, right.left + right.width - 2);
        assert.ok(binaryCol >= 95, 'wide terminal required to exercise non-UTF-8 mouse bytes');
        await evaluate("new Promise(resolve => terminalTabs.get('tab-1').terminal.write('\x1b[?1006l', resolve))");
        await click('left', binaryCol, 3);
        await eventually(() => tmux('display-message', '-p', '-t', 'smoke:0', '#{pane_id}') === right.id, 'binary mouse coordinates reach real tmux through Electron IPC and PTY');
        await evaluate("new Promise(resolve => terminalTabs.get('tab-1').terminal.write('\x1b[?1006h', resolve))");

        // Resizing a second tab must not resize the hidden tmux client.
        const originalSize = tmux('list-clients', '-F', '#{client_width} #{client_height}');
        await evaluate('createNewTerminalTab()');
        await evaluate("terminalTabs.get('tab-2').container.style.setProperty('max-width', '65%', 'important')");
        await delay(200);
        assert.equal(tmux('list-clients', '-F', '#{client_width} #{client_height}'), originalSize);
        await evaluate("switchToTab('tab-1')");
        await eventually(aligned, 'tmux content after switching tabs');
        console.log('Real tmux smoke ok: two panes, Unicode, resize, mouse selection, scrollback, tab isolation');
    } catch (error) {
        const terminalSize = await evaluate("({cols: terminalTabs.get('tab-1').terminal.cols, rows: terminalTabs.get('tab-1').terminal.rows})");
        throw new Error(`${error.message}\n${JSON.stringify({ terminalSize, tmuxSize: tmux('list-clients', '-F', '#{client_width} #{client_height}'), mismatch })}`);
    } finally {
        try { tmux('kill-server'); } catch {}
    }
}

runElectronSmoke(runChecks).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
