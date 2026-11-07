'use strict';
/**
 * Tab Notes — an offline example of per-tab session state (Plugin API 1.1).
 *
 * What this example shows:
 * - ctx.state.read() and ctx.state.write(value, revision): the read, compute,
 *   write-with-revision pattern, plus a bounded retry when another write wins
 *   the race and rejects our stale revision.
 * - Session state is scoped to one plugin instance and one tab: open two tabs,
 *   add a note in each, and neither tab sees the other's list.
 * - Every capability the code uses is declared in plugin.json: tools with
 *   input schemas, the notes panel, the context.read permission and
 *   engines.pluginApi "^1.1.0" (state is an API 1.1 feature).
 *
 * Needs no terminal connection, no model and no server.
 *
 * @param {import('./sdk').PluginContext<{ keepLast?: number }>} ctx
 */

/** @typedef {{ at: string, text: string }} Note */
/** @typedef {{ notes: Note[] }} NotesState */

/**
 * Interpret stored state as this plugin's shape; anything else starts fresh.
 * Host-held JSON crosses the boundary untyped, so this is the one place we cast.
 * @param {unknown} value
 * @returns {NotesState}
 */
const asNotes = value => {
    const saved = /** @type {Partial<NotesState> | null} */ (value);
    return saved && Array.isArray(saved.notes) ? { notes: saved.notes } : { notes: [] };
};

/**
 * @param {import('./sdk').PluginContext<{ keepLast?: number }>} ctx
 */
exports.activate = ctx => {
    const keepLast = Math.max(1, Math.min(50, Math.trunc(Number(ctx.config.keepLast) || 10)));
    const MAX_ATTEMPTS = 3; // bounded: give up instead of spinning forever

    // Tool handlers of one plugin instance can run concurrently, so serialize
    // same-tab writes; the retry loop below also covers races across tasks.
    /** @type {Promise<unknown>} */
    let queue = Promise.resolve();
    /**
     * @template T
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    const serial = fn => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };

    /**
     * Read, compute and write this tab's state with the revision from the read.
     * A stale revision makes write() reject; re-read, recompute and retry a
     * bounded number of times instead of overwriting the concurrent write.
     * @template T
     * @param {(value: unknown) => T} fn
     * @returns {Promise<T>}
     */
    const withState = fn => serial(async () => {
        for (let attempt = 1; ; attempt++) {
            const saved = await ctx.state.read();
            try {
                const written = await ctx.state.write(fn(saved.value), saved.revision);
                return written.value;
            } catch (error) {
                if (attempt >= MAX_ATTEMPTS) throw error;
                // Revision conflict: our copy went stale. Loop, re-read, retry.
            }
        }
    });

    /**
     * Render and publish the notes panel for the current tab.
     * @param {NotesState} state
     * @param {string} heading
     */
    const publish = async (state, heading) => {
        const { tabId } = await ctx.context.read();
        const lines = state.notes.length
            ? state.notes.map((note, index) => `${index + 1}. [${note.at}] ${note.text}`)
            : ['(no notes in this tab yet)'];
        const text = [
            `${heading} — tab ${tabId}`,
            `${state.notes.length} note(s), keeping the last ${keepLast}`, '',
            ...lines, '',
            'This list is per plugin + per tab; another tab has its own.',
            'Cleared on disable, update, tab close or app exit; it survives idle host recycling only.'
        ].join('\n');
        await ctx.ui.publish('notes', { type: 'text', title: `Tab Notes — tab ${tabId.slice(0, 8)}`, text });
        return { text };
    };

    ctx.tools.register('add', ({ text }) =>
        withState(value => {
            const state = asNotes(value);
            state.notes = [...state.notes, { at: new Date().toISOString(), text }].slice(-keepLast);
            return state;
        }).then(state => publish(state, 'Added')));

    ctx.tools.register('show', async () => {
        const saved = await ctx.state.read();
        return publish(asNotes(saved.value), 'Notes');
    });

    ctx.tools.register('clear', ({ confirm = false }) => {
        if (!confirm) return publish({ notes: [] }, 'Nothing cleared — call again with confirm: true');
        return withState(() => ({ notes: [] })).then(state => publish(state, 'Cleared'));
    });
};
