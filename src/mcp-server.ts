/**
 * `autoheal mcp`: AutoHeal as an MCP server on stdio, so AI coding agents
 * (Claude Code, Cursor, VS Code, Windsurf...) can fix failing tests, write a
 * test for an uncovered flow, check the setup, or learn fingerprints, with the
 * same guards as in CI. Each tool runs the AutoHeal CLI as a child process in
 * the project, so its output never mixes with the protocol on stdout.
 *
 *   { "mcpServers": { "autoheal": { "command": "npx", "args": ["-y", "xsignon-autoheal", "mcp"] } } }
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { VERSION } from './version.js';

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
  args(input: Record<string, unknown>): string[] | string;
  timeoutMs: number;
}

const str = (v: unknown, max = 2000): string | undefined => (typeof v === 'string' && v.trim() && v.length <= max && !v.startsWith('-') ? v.trim() : undefined);

export const TOOLS: Tool[] = [
  {
    name: 'autoheal_fix',
    title: 'Fix failing end-to-end tests',
    description:
      'Run the project\'s Playwright, pytest, Cypress or WebdriverIO tests, find what broke, and fix only test bugs (moved locators, stale waits). Every fix passes an anti-cheat guard and a stability rerun; app bugs are reported, never hidden. Changes are left in the working tree, uncommitted, for review. Needs a clean git tree (or allowDirty).',
    inputSchema: {
      type: 'object',
      properties: {
        report: { type: 'string', description: 'An existing report folder to heal instead of running the tests' },
        maxUsd: { type: 'number', description: 'AI spend limit in US dollars (default 1)' },
        maxFailures: { type: 'integer', minimum: 1, maximum: 20 },
        allowDirty: { type: 'boolean', description: 'Allow uncommitted changes in the working tree' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    args: (i) => {
      const a = ['fix'];
      const report = str(i.report, 400);
      if (report) a.push('--report', report);
      if (typeof i.maxUsd === 'number' && i.maxUsd > 0 && i.maxUsd <= 50) a.push('--max-usd', String(i.maxUsd));
      if (Number.isInteger(i.maxFailures) && (i.maxFailures as number) >= 1 && (i.maxFailures as number) <= 20) a.push('--max-failures', String(i.maxFailures));
      if (i.allowDirty === true) a.push('--allow-dirty');
      return a;
    },
    timeoutMs: 45 * 60_000,
  },
  {
    name: 'autoheal_cover',
    title: 'Write a test for an uncovered flow',
    description:
      'Write ONE new end-to-end test for a user flow that has no test yet. The test is kept only if it makes real assertions, uses no fakes, skips or fixed waits, and passes every run (default 5 in a row). Needs an AI key and, ideally, the running app.',
    inputSchema: {
      type: 'object',
      properties: {
        flow: { type: 'string', description: 'The user flow in plain words, e.g. "a shopper adds two items and checks out"' },
        url: { type: 'string', description: 'The running app, e.g. http://localhost:3000' },
        file: { type: 'string', description: 'Where to write the test (default from the flow)' },
        runs: { type: 'integer', minimum: 2, maximum: 20 },
        session: { type: 'string', description: 'For a flow behind a login: a saved storageState file in the project, e.g. playwright/.auth/user.json (make one with the engine\'s save-login tool or your setup project)' },
      },
      required: ['flow'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    args: (i) => {
      const flow = str(i.flow);
      if (!flow) return 'flow is required';
      const a = ['cover', '--flow', flow];
      const url = str(i.url, 400);
      if (url) a.push('--url', url);
      const file = str(i.file, 400);
      if (file) a.push('--file', file);
      if (Number.isInteger(i.runs)) a.push('--runs', String(i.runs));
      const session = str(i.session, 200);
      if (session) a.push('--session', session);
      return a;
    },
    timeoutMs: 30 * 60_000,
  },
  {
    name: 'autoheal_doctor',
    title: 'Check the AutoHeal setup',
    description: 'Check this project and machine for AutoHeal: test framework, reporters, traces, CI workflow, AI key, policy file. Each problem comes with its fix. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    args: () => ['doctor'],
    timeoutMs: 120_000,
  },
  {
    name: 'autoheal_learn',
    title: 'Learn element fingerprints',
    description: 'Run the tests once with traces on and save element fingerprints (role, name, test id), so a broken locator can later be fixed without AI tokens.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    args: () => ['learn'],
    timeoutMs: 45 * 60_000,
  },
];

function cliPath(): string {
  return fileURLToPath(new URL('./cli.js', import.meta.url));
}

/** Runs one AutoHeal command in the project; returns its output (last 20 KB). */
export function runCli(projectRoot: string, args: string[], timeoutMs: number, entry = cliPath()): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: projectRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (b: Buffer) => {
      output = (output + b.toString('utf8')).slice(-20_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 1, output: e.message });
    });
  });
}

type Json = Record<string, unknown>;

export interface ServeOptions {
  projectRoot: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Injected for tests. */
  run?: (args: string[], timeoutMs: number) => Promise<{ code: number; output: string }>;
}

/** Handles one JSON-RPC message; returns the reply (null for notifications). */
export async function handle(msg: Json, opts: ServeOptions): Promise<Json | null> {
  const id = msg.id as string | number | undefined;
  const isRequest = id !== undefined && id !== null;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  const method = typeof msg.method === 'string' ? msg.method : '';
  if (!isRequest) return null;
  switch (method) {
    case 'initialize': {
      const asked = (msg.params as Json | undefined)?.protocolVersion;
      return reply({
        protocolVersion: typeof asked === 'string' ? asked : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'autoheal', title: 'AutoHeal AI', version: VERSION },
        instructions: 'AutoHeal fixes failing end-to-end tests without weakening them. Use autoheal_fix when tests fail, autoheal_cover to add a test for a flow, autoheal_doctor to check the setup.',
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) });
    case 'tools/call': {
      const params = (msg.params ?? {}) as Json;
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return fail(-32602, `Unknown tool: ${String(params.name)}`);
      const input = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Json;
      const args = tool.args(input);
      if (typeof args === 'string') return reply({ content: [{ type: 'text', text: args }], isError: true });
      const run = opts.run ?? ((a: string[], t: number) => runCli(opts.projectRoot, a, t));
      const res = await run(args, tool.timeoutMs);
      let text = res.output.trim() || `autoheal ${args[0]} exited with code ${res.code}`;
      if (tool.name === 'autoheal_fix') {
        const summary = await readFile(path.join(opts.projectRoot, '.autoheal-local', 'out', 'job-summary.md'), 'utf8').catch(() => '');
        if (summary) text = `${summary.slice(0, 20_000)}\n\n---\n${text.slice(-5_000)}`;
      }
      return reply({ content: [{ type: 'text', text }], isError: res.code !== 0 && !(tool.name === 'autoheal_fix' && res.code === 3) });
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

/** Serves MCP over stdio (newline-delimited JSON-RPC) until stdin closes. */
export async function serveMcp(opts: ServeOptions): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const rl = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      continue;
    }
    const p = handle(msg, opts)
      .then((r) => {
        if (r) output.write(`${JSON.stringify(r)}\n`);
      })
      .catch((e: unknown) => {
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } })}\n`);
      })
      .finally(() => pending.delete(p));
    pending.add(p);
  }
  await Promise.all(pending);
}
