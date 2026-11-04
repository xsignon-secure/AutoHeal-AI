/**
 * Starts the app under test for the heal job (start-command), so the AI can
 * check locators against the real page instead of only the trace.
 *
 * The app is the repository's own code, so it is treated like the tests: it
 * runs in the sandbox when there is one, with the same scrubbed environment
 * as the engine (no AI key, no runner tokens), and is stopped when the job ends.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { engineEnv } from './mcp.js';
import { wrapCommand, type Sandbox } from './sandbox.js';

export interface StartedApp {
  url: string;
  /** For the PR: what ran and how. */
  note: string;
  stop(): Promise<void>;
}

export interface StartOptions {
  command: string;
  url: string;
  cwd: string;
  timeoutMs?: number;
  sandbox?: Sandbox | null;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** Injected for tests. */
  fetchFn?: typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Only plain http(s) URLs on this machine: the app runs here. */
export function checkAppUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`start-url is not a URL: ${url}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('start-url must be http or https');
  if (!/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/.test(u.hostname)) throw new Error('start-url must point at this machine (localhost or 127.0.0.1): the app is started here');
  return u;
}

async function ready(url: string, fetchFn: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchFn(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    await res.body?.cancel().catch(() => undefined);
    return res.status < 500;
  } catch {
    return false;
  }
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return resolve();
    const done = () => resolve();
    child.once('exit', done);
    const kill = (signal: NodeJS.Signals) => {
      try {
        // The whole process group: npm, the shell and the server under it.
        process.kill(-(child.pid as number), signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
    };
    kill('SIGTERM');
    setTimeout(() => {
      kill('SIGKILL');
      setTimeout(done, 1000);
    }, 5000).unref();
  });
}

/** Starts the command, waits until the URL answers, and returns a handle to stop it. */
export async function startApp(options: StartOptions): Promise<StartedApp> {
  const target = checkAppUrl(options.url);
  const log = options.log ?? (() => undefined);
  const fetchFn = options.fetchFn ?? fetch;
  const env = engineEnv(options.env ?? process.env, false);
  let command = '/bin/sh';
  let args = ['-c', options.command];
  if (options.sandbox) ({ command, args } = wrapCommand(options.sandbox, command, args, env));
  log(`Starting the app: ${options.command}${options.sandbox ? ` (as ${options.sandbox.user})` : ''}`);
  const child = spawn(command, args, { cwd: options.cwd, env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString('utf8')).slice(-2000);
  });
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    if (exited) throw new Error(`the start command exited before ${target.href} answered${stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`);
    if (await ready(target.href, fetchFn)) {
      log(`App is up at ${target.href}`);
      return {
        url: target.href,
        note: `started with \`${options.command.replace(/`/g, "'").slice(0, 200)}\` at ${target.origin}${options.sandbox ? ` as \`${options.sandbox.user}\`` : ''}; the AI checked locators against it`,
        stop: async () => {
          await stopChild(child);
          // The sandbox user exists only for this job: end whatever the app left behind.
          if (options.sandbox) spawnSync('sudo', ['-n', '-u', options.sandbox.user, '--', '/bin/kill', '-TERM', '-1'], { stdio: 'ignore', timeout: 15_000 });
        },
      };
    }
    await sleep(1000);
  }
  await stopChild(child);
  throw new Error(`${target.href} did not answer within ${Math.round((options.timeoutMs ?? 120_000) / 1000)} s after the start command`);
}
