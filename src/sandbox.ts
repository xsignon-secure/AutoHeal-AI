/**
 * The test sandbox: your tests, and every fix the AI proposes, run as a
 * separate Linux user. AutoHeal's own process (which holds the AI key) runs as
 * the runner user. Linux does not let one user read another user's process
 * memory or environment (/proc/<pid>/environ, /proc/<pid>/mem), so code in a
 * test cannot read the key, the runner's tokens or its files.
 *
 * The action's "Prepare the sandbox" step (scripts/sandbox-setup.sh) creates
 * the user and grants it the project folder; this module only decides whether
 * to use it and wraps the engine's command line.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type SandboxMode = 'auto' | 'user' | 'off';

export interface Sandbox {
  user: string;
  home: string;
}

export interface SandboxChoice {
  sandbox: Sandbox | null;
  /** Shown in the PR and the job summary. */
  note: string;
}

const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;

export function sandboxMode(value: string | undefined): SandboxMode {
  const v = (value ?? 'auto').trim().toLowerCase();
  if (v === '' || v === 'auto') return 'auto';
  if (v === 'user' || v === 'true' || v === 'on') return 'user';
  if (v === 'off' || v === 'false') return 'off';
  throw new Error(`sandbox must be auto, user or off (got "${value}")`);
}

/** Whether `sudo -n -u <user> true` works, i.e. we can start processes as the sandbox user. */
function canSwitch(user: string, run: typeof execFileSync): boolean {
  try {
    run('sudo', ['-n', '-u', user, '--', 'true'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Picks the sandbox. `user` fails closed when it cannot be used; `auto` uses it
 * when the setup step prepared it (Linux runners) and says so when it could not.
 */
export function chooseSandbox(mode: SandboxMode, env: NodeJS.ProcessEnv = process.env, run: typeof execFileSync = execFileSync): SandboxChoice {
  if (mode === 'off') return { sandbox: null, note: 'off (sandbox: off): tests ran as the runner user, which can read the AI key' };
  const user = env.AUTOHEAL_SANDBOX_USER ?? '';
  const home = env.AUTOHEAL_SANDBOX_HOME ?? '';
  const why =
    process.platform !== 'linux'
      ? `not available on ${process.platform}`
      : !user
        ? 'the sandbox user was not prepared (needs passwordless sudo on a Linux runner)'
        : !USER_NAME.test(user) || !home.startsWith('/')
          ? 'the sandbox settings are invalid'
          : !canSwitch(user, run)
            ? `cannot start processes as ${user}`
            : '';
  if (why) {
    if (mode === 'user') throw new Error(`sandbox: user was requested but ${why}`);
    return { sandbox: null, note: `off (${why}): tests ran as the runner user, which can read the AI key` };
  }
  return { sandbox: { user, home }, note: `tests and fixes ran as the separate user \`${user}\`, which cannot read the AI key or the runner's tokens` };
}

/**
 * The command that starts `command args` as the sandbox user with exactly
 * `env` (nothing inherited). The values end up on the command line, so `env`
 * must hold no secrets; engineEnv() already removed them.
 */
export function wrapCommand(sandbox: Sandbox, command: string, args: string[], env: Record<string, string>): { command: string; args: string[] } {
  const vars = { ...env, HOME: sandbox.home, USER: sandbox.user, LOGNAME: sandbox.user };
  const assignments = Object.entries(vars)
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `${k}=${v}`);
  return { command: 'sudo', args: ['-n', '-u', sandbox.user, '--', '/usr/bin/env', '-i', ...assignments, command, ...args] };
}

/**
 * Runs scripts/sandbox-setup.sh, the step GitHub Actions runs before AutoHeal,
 * for CIs that have no such step (GitLab, CircleCI). Returns the variables
 * chooseSandbox() reads; empty when the sandbox could not be prepared (the
 * script says why, and `user` mode fails instead).
 */
export function prepareSandbox(projectRoot: string, mode: SandboxMode, log: (line: string) => void = () => undefined, run: typeof execFileSync = execFileSync): Record<string, string> {
  if (mode === 'off' || process.platform !== 'linux') return {};
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'autoheal-sb-')), 'out');
  writeFileSync(out, '');
  try {
    run('bash', [path.join(packageRoot, 'scripts', 'sandbox-setup.sh')], {
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: 300_000,
      env: { ...process.env, MODE: mode, PROJECT: projectRoot, ACTION_PATH: packageRoot, GITHUB_OUTPUT: out },
    });
  } catch (error) {
    if (mode === 'user') throw new Error(`sandbox: user was requested but the setup failed (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`);
    log('Sandbox setup failed; running without it (the PR says so).');
    return {};
  }
  const vars: Record<string, string> = {};
  for (const line of readFileSync(out, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at < 1) continue;
    const key = line.slice(0, at);
    const value = line.slice(at + 1);
    if (key === 'user') vars.AUTOHEAL_SANDBOX_USER = value;
    else if (key === 'home') vars.AUTOHEAL_SANDBOX_HOME = value;
    else if (key === 'browsers') vars.AUTOHEAL_SANDBOX_BROWSERS = value;
  }
  return vars;
}
