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
 * Reads only. No log modification, no restarts, no model, no server, no keys.
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
 */
const assertAbsolutePath = filePath => {
    const windows = /^[a-zA-Z]:[\\/]/.test(filePath) || /^\\\\/.test(filePath);
    const posix = filePath.startsWith('/');
    if (!windows && !posix) {
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
    /**
     * Keep a small per-tab history of summaries. A concurrent write rejects
     * our revision; re-read and re-append instead of overwriting.
     * @param {Inspection} summary
     */
    const record = async summary => {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            const saved = await ctx.state.read();
            try {
                await ctx.state.write({ history: [...asState(saved.value).history, summary].slice(-10) }, saved.revision);
                return;
            } catch (error) {
                if (attempt === MAX_ATTEMPTS) return; // summary only: dropping beats fighting
            }
        }
    };

    ctx.tools.register('inspect', async ({ path, lines = 50, keyword = '' }) => {
        assertAbsolutePath(path);
        const { tabId, target, shell } = await ctx.context.read();

        const result = await ctx.files.read(path);
        if (result.exitCode !== 0) {
            // The file service owns the real diagnostics (missing file,
            // permission denied, wrong target); pass them through verbatim.
            throw new Error(result.output || `Reading ${path} failed (exit ${result.exitCode}).`);
        }
        if (ctx.signal?.aborted) return { text: 'Inspection cancelled.' };

        const wanted = Math.max(1, Math.min(MAX_LINES, Math.trunc(Number(lines) || 50)));
        const all = result.output.length ? result.output.replace(/\r\n/g, '\n').split('\n') : [];
        // Drop the trailing empty line a final newline would produce.
        if (all.length && all[all.length - 1] === '') all.pop();
        const recent = all.slice(-wanted);
        let body = recent.join('\n');
        if (body.length > MAX_CHARS) body = body.slice(-MAX_CHARS); // keep the most recent characters
        const matches = countLiteral(recent, String(keyword || ''));

        const header = [
            `Target: ${target} (${shell}) — tab ${tabId}`,
            `File: ${path}`,
            `Showing the last ${recent.length} of ${all.length} line(s)` +
                (matches === null ? '' : ` · "${keyword}" found ${matches} time(s)`)
        ].join('\n');
        await ctx.ui.publish('inspection', { type: 'log', title: 'Log inspection', text: `${header}\n\n${body}` });

        await record({ file: path, lines: recent.length, keyword: matches === null ? null : String(keyword), matches, at: new Date().toISOString() });
        return { text: header, lines: recent.length, matches: matches ?? undefined };
    });
};
