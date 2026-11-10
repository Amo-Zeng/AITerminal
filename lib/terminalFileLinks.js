(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.AITerminalFileLinks = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    // Work in terminal cells, not UTF-16 offsets: CJK, emoji, combining marks
    // and wrapped names otherwise put the clickable range on the wrong glyphs.
    function readLogicalLine(terminal, row) {
        const buffer = terminal.buffer.active;
        let first = row - 1, last = row - 1;
        if (!buffer.getLine(first)) return null;
        while (first > 0 && row - first < 64 && buffer.getLine(first)?.isWrapped) first--;
        while (last - first < 63 && buffer.getLine(last + 1)?.isWrapped) last++;
        let text = '';
        const cells = [];
        for (let y = first; y <= last; y++) {
            const line = buffer.getLine(y);
            for (let x = 0; x < line.length; x++) {
                const cell = line.getCell(x), width = cell?.getWidth();
                if (!width) continue;
                // xterm leaves an empty last cell when a double-width glyph
                // must wrap. This padding is not part of the filename.
                if (x === line.length - 1 && !cell.getChars() &&
                    buffer.getLine(y + 1)?.isWrapped && buffer.getLine(y + 1).getCell(0)?.getWidth() === 2) continue;
                const chars = cell.getChars() || ' ';
                text += chars;
                for (let i = 0; i < chars.length; i++) cells.push({ start: { x: x + 1, y: y + 1 }, end: { x: x + width, y: y + 1 } });
            }
        }
        return { text, cells };
    }
    function matches(line, files, row) {
        if (!line) return [];
        const found = [], occupied = new Set();
        for (const file of [...files].sort((a, b) => b.name.length - a.name.length)) {
            if (!file.name || /[\x00-\x1f\x7f/]/.test(file.name)) continue;
            let offset = 0, start;
            while ((start = line.text.indexOf(file.name, offset)) !== -1) {
                const end = start + file.name.length;
                offset = end;
                if ((start && !/[\s'"`]/.test(line.text[start - 1])) || (end < line.text.length && !/[\s'"`*@]/.test(line.text[end]))) continue;
                if (occupied.has(start) || occupied.has(end - 1)) continue;
                const range = { start: line.cells[start].start, end: line.cells[end - 1].end };
                if (range.start.y > row || range.end.y < row) continue;
                for (let i = start; i < end; i++) occupied.add(i);
                found.push({ ...file, range });
            }
        }
        return found;
    }
    function attach(terminal, { enabled, load, open, message }) {
        let disposed = false;
        const usable = () => !disposed && enabled() && terminal.buffer.active.type === 'normal' && terminal.modes.mouseTrackingMode === 'none';
        const registration = terminal.registerLinkProvider({
            async provideLinks(row, callback) {
                if (!usable()) return callback([]);
                const line = readLogicalLine(terminal, row);
                if (!line?.text.trim()) return callback([]);
                try {
                    const result = await load();
                    if (!usable() || !result.success || readLogicalLine(terminal, row)?.text !== line.text) return callback([]);
                    callback(matches(line, result.files, row).map(file => ({
                        text: file.name, range: file.range,
                        hover() { terminal.element.title = `打开直连 SSH 文件：${file.path}`; },
                        leave() { terminal.element.removeAttribute('title'); },
                        async activate() {
                            if (!usable() || readLogicalLine(terminal, row)?.text !== line.text) return;
                            try {
                                const response = await open({ ...file, token: result.token });
                                if (!disposed) message(response.success ? response.message : response.error || '打开文件失败');
                            } catch (error) { if (!disposed) message(error.message); }
                        },
                    })));
                } catch { callback([]); }
            },
        });
        return { dispose() { disposed = true; registration.dispose(); } };
    }
    return { readLogicalLine, matches, attach };
});
