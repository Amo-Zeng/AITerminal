'use strict';
/**
 * Log Inspector — a read-only log inspection example (Plugin API 1.1).
 *
 * What this example shows:
 * - Read-only host access: ctx.files.read() with the files.read permission,
 *   publishing the result as a plain-text log panel, changing nothing.
 * - Bounded work: input validated by the manifest schema, only the last N
 *   lines are shown, and the panel text has a hard character cap.
 * - Clear target and diagnostics: the panel names the tab's target and shell
 *   (local or SSH), and file-service failures (missing file, permission
 *   denied) are surfaced verbatim instead of hidden.
 * - Per-tab isolation: a small ctx.state history is kept per tab; two tabs
 *   inspecting different files never see each other's results.
 *
 * Reads small files through the host (1 MiB output limit), then selects lines.
 * No log modification, no restarts, no model request and no model keys.
 *
 * @param {import('./sdk').PluginContext} ctx
 */

/** @typedef {{ file: string, lines: number, keyword: string | null, matches: number | null, at: string }} Inspection */
/** @typedef {{ history: Inspection[] }} InspectorState */

const MAX_LINES = 200;
const MAX_CHARS = 20000; // hard cap for the panel text
const MAX_ATTEMPTS = 3;

/**
 * Interpret stored state as this plugin's shape; anything else starts fresh.
 * Host-held JSON crosses the boundary untyped, so this is the one place we cast.
 * @param {unknown} value
 * @returns {InspectorState}
 */
const asState = value => {
    const saved = /** @type {Partial<InspectorState> | null} */ (value);
    return saved && Array.isArray(saved.history) ? { history: saved.history } : { history: [] };
};

/**
 * Absolute paths only: the file service resolves the path against the tab's
 * real target, so a relative path would silently depend on where the tab is.
 * @param {string} filePath
 * @param {string} shell
 */
const assertAbsolutePath = (filePath, shell) => {
    const windows = /^[a-zA-Z]:[\\/]/.test(filePath) || /^\\\\/.test(filePath);
    const posix = filePath.startsWith('/');
    if (/[\0\r\n]/.test(filePath) || !(shell === 'powershell' ? windows : posix)) {
        throw new Error(`"${filePath}" is not an absolute path. Pass the full path as the tab's target sees it (local or SSH).`);
    }
};

/**
 * Count literal, case-insensitive occurrences. No regex, on purpose: a log
 * path or keyword is data, not a pattern to execute.
 * @param {string[]} lines
 * @param {string} keyword
 * @returns {number | null}
 */
const countLiteral = (lines, keyword) => {
    if (!keyword) return null;
    const needle = keyword.toLowerCase();
    let total = 0;
    for (const line of lines) {
        const haystack = line.toLowerCase();
        for (let pos = haystack.indexOf(needle); pos !== -1; pos = haystack.indexOf(needle, pos + needle.length)) {
            total++;
        }
    }
    return total;
};

/**
 * @param {import('./sdk').PluginContext} ctx
 */
exports.activate = ctx => {
    const checkCancelled = () => { if (ctx.signal?.aborted) throw new Error('Inspection cancelled.'); };
    /**
     * Keep a small per-tab history of summaries. A concurrent write rejects
     * our revision; re-read and re-append instead of overwriting.
     * @param {Inspection} summary
     */
    const record = async summary => {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            checkCancelled();
            const saved = await ctx.state.read();
            const history = [...asState(saved.value).history, summary].slice(-10);
            // Escaped paths/keywords also count toward the host's 32 KiB limit.
            while (history.length && new TextEncoder().encode(JSON.stringify({ history })).length > 30000) history.shift();
            try {
                await ctx.state.write({ history }, saved.revision);
                return;
            } catch (error) {
                if (attempt === MAX_ATTEMPTS || ctx.signal?.aborted) throw error;
                const latest = await ctx.state.read();
                if (latest.revision === saved.revision) throw error;
            }
        }
    };

    ctx.tools.register('inspect', async ({ path, lines = 50, keyword = '' }) => {
        checkCancelled();
        const { tabId, target, shell } = await ctx.context.read();
        assertAbsolutePath(path, shell);
        checkCancelled();

        const result = await ctx.files.read(path);
        if (result.exitCode !== 0) {
            // The file service owns the real diagnostics (missing file,
            // permission denied, wrong target); pass them through verbatim.
            throw new Error(result.output || `Reading ${path} failed (exit ${result.exitCode}).`);
        }
        checkCancelled();

        const wanted = Math.max(1, Math.min(MAX_LINES, Math.trunc(Number(lines) || 50)));
        const all = result.output.length ? result.output.replace(/\r\n/g, '\n').split('\n') : [];
        // Drop the trailing empty line a final newline would produce.
        if (all.length && all[all.length - 1] === '') all.pop();
        const recent = all.slice(-wanted);
        const original = recent.join('\n');
        let body = original;
        // Include metadata in both the character cap and the host's JSON byte cap.
        // Shrink the oldest text, then recount only the text actually displayed.
        for (;;) {
            const truncated = body.length < original.length;
            const visible = body ? body.split('\n') : [];
            const matches = countLiteral(visible, String(keyword || ''));
            const header = [
                `Target: ${target} (${shell}) — tab ${tabId}`,
                `File: ${path}`,
                `Showing ${visible.length} recent line(s) of ${all.length}` +
                    (truncated ? ' (older text trimmed; first line may be partial)' : ''),
                matches === null ? 'No keyword filter.' : `Literal "${keyword}" in displayed text: ${matches}`
            ].join('\n');
            const panel = { type: /** @type {'log'} */ ('log'), title: 'Log inspection', text: `${header}\n\n${body}` };
            const bytes = new TextEncoder().encode(JSON.stringify(panel)).length;
            if (panel.text.length <= MAX_CHARS && bytes <= 60000) {
                checkCancelled();
                await record({ file: path, lines: visible.length, keyword: matches === null ? null : String(keyword), matches, at: new Date().toISOString() });
                checkCancelled();
                await ctx.ui.publish('inspection', panel);
                return { text: header, lines: visible.length, matches, truncated };
            }
            if (!body.length) throw new Error('Inspection metadata exceeds the panel limit.');
            const remove = Math.max(1, panel.text.length - MAX_CHARS, Math.ceil((bytes - 60000) / 6));
            body = body.slice(Math.min(body.length, remove));
            // Avoid starting the displayed suffix in the middle of a surrogate pair.
            if (/^[\uDC00-\uDFFF]/.test(body)) body = body.slice(1);
        }
    });
};
