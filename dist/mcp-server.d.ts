/**
 * `autoheal mcp`: AutoHeal as an MCP server on stdio, so AI coding agents
 * (Claude Code, Cursor, VS Code, Windsurf...) can fix failing tests, write a
 * test for an uncovered flow, check the setup, or learn fingerprints, with the
 * same guards as in CI. Each tool runs the AutoHeal CLI as a child process in
 * the project, so its output never mixes with the protocol on stdout.
 *
 *   { "mcpServers": { "autoheal": { "command": "npx", "args": ["-y", "xsignon-autoheal", "mcp"] } } }
 */
interface Tool {
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations: Record<string, boolean>;
    args(input: Record<string, unknown>): string[] | string;
    timeoutMs: number;
}
export declare const TOOLS: Tool[];
/** Runs one AutoHeal command in the project; returns its output (last 20 KB). */
export declare function runCli(projectRoot: string, args: string[], timeoutMs: number, entry?: string): Promise<{
    code: number;
    output: string;
}>;
type Json = Record<string, unknown>;
export interface ServeOptions {
    projectRoot: string;
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    /** Injected for tests. */
    run?: (args: string[], timeoutMs: number) => Promise<{
        code: number;
        output: string;
    }>;
}
/** Handles one JSON-RPC message; returns the reply (null for notifications). */
export declare function handle(msg: Json, opts: ServeOptions): Promise<Json | null>;
/** Serves MCP over stdio (newline-delimited JSON-RPC) until stdin closes. */
export declare function serveMcp(opts: ServeOptions): Promise<void>;
export {};
