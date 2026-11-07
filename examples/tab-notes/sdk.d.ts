/** Plugin API 1.1.0. The host supplies this object to activate(). */
export interface Schema {
    type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
    properties?: Record<string, Schema>; required?: string[]; items?: Schema;
    title?: string; description?: string; default?: unknown; enum?: unknown[];
    minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
    minItems?: number; maxItems?: number; additionalProperties?: false;
}
export interface Command {
    argv?: string[]; command?: string; requiresConfirmation?: boolean;
    cols?: number; rows?: number;
}
export interface ExecutionResult { output: string; exitCode: number | null; signal: string | null; }
export interface TerminalRead {
    text: string; cursor: number; truncated: boolean; ended: boolean;
    exitCode: number | null; error: string;
}
export interface Panel { type: 'text' | 'log' | 'table'; title?: string; text?: string; columns?: string[]; rows?: unknown[][]; }
export interface ModelRequest {
    messages: Array<{ role: string; content: unknown; [key: string]: unknown }>;
    model?: string; temperature?: number; maxTokens?: number; streaming?: boolean;
    /** false disables nested tool dispatch for text-only tasks, even during AI takeover. */
    allowTools?: boolean;
}
export type Handler = (params: any) => unknown | Promise<unknown>;
export interface PluginContext<Config = Record<string, unknown>> {
    readonly apiVersion: '1.1.0'; readonly config: Readonly<Config>;
    /** Defined during tools, events, models and prompt handlers. */
    readonly signal: AbortSignal | undefined;
    /** Internal pinned Cordis context; AITerminal SDK is the stable API boundary. */
    readonly cordis: unknown;
    tools: { register(id: string, handler: Handler): () => Promise<void> };
    prompts: { register(id: string, provider: () => string | Promise<string>): () => Promise<void> };
    models: { register(id: string, handler: (request: ModelRequest) => Promise<string>): () => Promise<void>; request(request: ModelRequest): Promise<string> };
    services: { register(id: string, handler: Handler): () => Promise<void>; call(pluginId: string, serviceId: string, params: unknown): Promise<unknown> };
    events: { on(name: 'task.completed' | 'task.error' | 'task.cancelled' | 'task.started' | string, handler: Handler): () => Promise<void> };
    terminal: {
        exec(command: Command): Promise<ExecutionResult>;
        open(command: Command): Promise<{ sessionId: string }>;
        read(sessionId: string, options?: { cursor?: number; waitMs?: number }): Promise<TerminalRead>;
        write(sessionId: string, text: string): Promise<boolean>;
        resize(sessionId: string, cols: number, rows: number): Promise<boolean>;
        close(sessionId: string): Promise<boolean>;
    };
    files: { read(path: string): Promise<ExecutionResult>; write(path: string, text: string): Promise<ExecutionResult> };
    context: { read(): Promise<{ tabId: string; target: string; shell: string; cwd: string; recentOutput: string; task: string }> };
    notifications: { send(message: { event?: string; message: string }): Promise<{ delivered: boolean; attempts: number }> };
    ui: { publish(id: string, panel: Panel): Promise<boolean> };
    /** Per-tab, per-plugin JSON (32 KiB). Survives idle host recycling, not disable/update/tab close or app restart. */
    state: {
        read<T = unknown>(): Promise<{ revision: number; value: T | null }>;
        /** Pass the revision from read(); a concurrent write rejects instead of overwriting it. */
        write<T>(value: T, revision: number): Promise<{ revision: number; value: T }>;
    };
    progress(value: unknown): void;
    onDispose(cleanup: () => void | Promise<void>): () => Promise<void>;
    effect(setup: () => (() => void | Promise<void>)): () => Promise<void>;
    setInterval(callback: () => void | Promise<void>, milliseconds: number): () => Promise<void>;
}
export type Plugin<Config = Record<string, unknown>> = { activate(context: PluginContext<Config>, config: Config): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)> };
