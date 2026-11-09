/**
 * Runs the playwright-e2e-mcp engine as a child process over stdio and calls
 * its tools. AutoHeal never re-implements what the engine already does
 * (report loading, failure reading, heal guard, flaky verdicts, quarantine).
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { wrapCommand } from './sandbox.js';
import { VERSION } from './version.js';
/** Path of the engine's CLI entry (overridable for development). */
export function engineEntry(env = process.env) {
    if (env.AUTOHEAL_MCP_ENTRY)
        return env.AUTOHEAL_MCP_ENTRY;
    return fileURLToPath(import.meta.resolve('playwright-e2e-mcp'));
}
const SECRET_ENV = /^GITHUB_(?:ENV|PATH|OUTPUT|STEP_SUMMARY|STATE)$|^(?:ANTHROPIC|OPENAI)_API_KEY$|^AUTOHEAL_API_KEY$|^AUTOHEAL_DASHBOARD_SECRET$|^AUTOHEAL_DASHBOARD_VIEW_TOKEN$|^ACTIONS_(?:RUNTIME|ID_TOKEN_REQUEST|CACHE)_|^ACTIONS_RESULTS_URL$|^INPUT_(?:ANTHROPIC|OPENAI|GITHUB|DASHBOARD)/;
const GITHUB_ENV = /^(?:GITHUB_TOKEN|GH_TOKEN|GITLAB_TOKEN|CI_JOB_TOKEN|PW_MCP_CI_TOKEN|AUTOHEAL_GITHUB_TOKEN|AUTOHEAL_GITLAB_TOKEN|CIRCLE_TOKEN|CIRCLECI_TOKEN|CI_JOB_JWT(?:_V\d)?|CI_REGISTRY_PASSWORD|CI_DEPENDENCY_PROXY_PASSWORD|CI_DEPLOY_PASSWORD|CI_REPOSITORY_URL)$/;
/** The engine's environment: no AI key, no dashboard secret, no runner tokens. */
export function engineEnv(env, keepGithubToken) {
    const out = {};
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined || SECRET_ENV.test(key))
            continue;
        if (!keepGithubToken && GITHUB_ENV.test(key))
            continue;
        out[key] = value;
    }
    // Reruns must prove the code itself: the runtime healing fixture never heals inside the engine.
    out.AUTOHEAL_RUNTIME = 'off';
    return out;
}
export class McpTools {
    client;
    constructor(client) {
        this.client = client;
    }
    /**
     * `keepGithubToken` is only for loading a report from a CI run URL. Tests
     * (and every proposed fix) run inside the engine, so by default they see
     * neither the AI key nor any GitHub or Actions token.
     */
    static async start(projectRoot, options = {}) {
        const env = options.env ?? process.env;
        const childEnv = engineEnv(env, options.keepGithubToken === true);
        childEnv.PW_MCP_PROJECT_ROOT = projectRoot;
        childEnv.LOG_LEVEL = env.AUTOHEAL_DEBUG ? 'debug' : 'error';
        let command = process.execPath;
        let args = [engineEntry(env)];
        if (options.sandbox) {
            // The runner's browsers live in its home folder; the sandbox user has its own.
            if (!childEnv.PLAYWRIGHT_BROWSERS_PATH && env.AUTOHEAL_SANDBOX_BROWSERS)
                childEnv.PLAYWRIGHT_BROWSERS_PATH = env.AUTOHEAL_SANDBOX_BROWSERS;
            ({ command, args } = wrapCommand(options.sandbox, command, args, childEnv));
        }
        const transport = new StdioClientTransport({
            command,
            args,
            cwd: projectRoot,
            env: childEnv,
            stderr: env.AUTOHEAL_DEBUG ? 'inherit' : 'ignore',
        });
        const client = new Client({ name: 'autoheal-ai', version: VERSION });
        await client.connect(transport);
        return new McpTools(client);
    }
    async call(name, args, timeoutMs = 600_000) {
        try {
            const result = (await this.client.callTool({ name, arguments: args }, { timeout: timeoutMs }));
            const text = (result.content ?? [])
                .filter((c) => c.type === 'text' && typeof c.text === 'string')
                .map((c) => c.text)
                .join('\n');
            const data = result.structuredContent ?? {};
            const isError = result.isError === true;
            const ok = !isError && data.ok !== false;
            return { ok, isError, text, data };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, isError: true, text: `Tool ${name} failed: ${message}`, data: { ok: false, error: { kind: 'CALL_FAILED', message } } };
        }
    }
    async close() {
        await this.client.close().catch(() => undefined);
    }
}
//# sourceMappingURL=mcp.js.map