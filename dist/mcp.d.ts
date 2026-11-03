/**
 * Runs the playwright-e2e-mcp engine as a child process over stdio and calls
 * its tools. AutoHeal never re-implements what the engine already does
 * (report loading, failure reading, heal guard, flaky verdicts, quarantine).
 */
export interface ToolResult {
    ok: boolean;
    isError: boolean;
    text: string;
    data: Record<string, unknown>;
}
export interface ToolCaller {
    call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ToolResult>;
    close(): Promise<void>;
}
/** Path of the engine's CLI entry (overridable for development). */
export declare function engineEntry(env?: NodeJS.ProcessEnv): string;
/** The engine's environment: no AI key, no dashboard secret, no runner tokens. */
export declare function engineEnv(env: NodeJS.ProcessEnv, keepGithubToken: boolean): Record<string, string>;
export declare class McpTools implements ToolCaller {
    private readonly client;
    private constructor();
    /**
     * `keepGithubToken` is only for loading a report from a CI run URL. Tests
     * (and every proposed fix) run inside the engine, so by default they see
     * neither the AI key nor any GitHub or Actions token.
     */
    static start(projectRoot: string, options?: {
        env?: NodeJS.ProcessEnv;
        keepGithubToken?: boolean;
    }): Promise<McpTools>;
    call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ToolResult>;
    close(): Promise<void>;
}
