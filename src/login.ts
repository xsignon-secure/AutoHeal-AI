/**
 * Signed-in flows for `autoheal cover` (and KeepGreen, which calls it).
 *
 * Most important flows sit behind a login. AutoHeal reuses the engine's
 * `save-login` tool: it logs in once with steps you give, checks the session,
 * and saves it as a Playwright storageState file. The page tools then open
 * pages as that user, and the new test loads the same file.
 *
 * Secrets never reach the AI or the test file: login steps name them as
 * {{env:E2E_PASSWORD}} (and {{totp}} for an authenticator code), and the
 * engine fills them in at the moment they are typed. The engine only reads
 * variables named E2E_*, TEST_*, PW_*, PLAYWRIGHT_* or LOGIN_*.
 *
 * Without steps, AutoHeal uses a session file you already create (for
 * example with a Playwright setup project) and only checks that it exists.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolCaller } from './mcp.js';

export interface LoginConfig {
  /** The storageState file, relative to the project (default playwright/.auth/user.json). */
  session: string;
  /** Login page: a path such as /login, or a full URL on the app. */
  url?: string;
  /** Login steps, one per line: `fill getByLabel('Email') = {{env:E2E_USER}}`. */
  steps?: string[];
  /** A locator only a signed-in user sees, to check the session. */
  check?: string;
  /** Environment variable with the authenticator secret, for {{totp}}. */
  totpEnv?: string;
}

export interface LoginStep {
  type: 'goto' | 'click' | 'dblclick' | 'hover' | 'fill' | 'press' | 'check' | 'uncheck' | 'select' | 'wait';
  locator?: string;
  value?: string;
  url?: string;
  ms?: number;
}

export const DEFAULT_SESSION = 'playwright/.auth/user.json';

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginError';
  }
}

const WITH_VALUE = new Set(['fill', 'press', 'select']);
const LOCATOR_ONLY = new Set(['click', 'dblclick', 'hover', 'check', 'uncheck']);

/**
 * One step, written the way a person would:
 *   goto /login
 *   fill getByLabel('Email') = {{env:E2E_USER}}
 *   press getByLabel('Password') = Enter
 *   click getByRole('button', { name: 'Sign in' })
 *   wait getByRole('button', { name: 'Sign out' })     (or: wait 500)
 * The value comes after the last " = ", so locators may contain "=".
 */
export function parseLoginStep(line: string): LoginStep {
  const text = line.trim();
  const m = /^([a-z]+)\s+(.+)$/i.exec(text);
  if (!m) throw new LoginError(`Login step "${text}": expected "<action> <locator>", e.g. click getByRole('button', { name: 'Sign in' }).`);
  const type = (m[1] ?? '').toLowerCase();
  const rest = (m[2] ?? '').trim();
  if (type === 'goto') return { type: 'goto', url: rest };
  if (type === 'wait') {
    if (/^\d+$/.test(rest)) {
      const ms = Number(rest);
      if (ms > 10_000) throw new LoginError(`Login step "${text}": a wait without a locator is at most 10000 ms.`);
      return { type: 'wait', ms };
    }
    return { type: 'wait', locator: rest };
  }
  if (WITH_VALUE.has(type)) {
    const at = rest.lastIndexOf(' = ');
    if (at < 0) throw new LoginError(`Login step "${text}": ${type} needs "<locator> = <value>".`);
    const locator = rest.slice(0, at).trim();
    const value = rest.slice(at + 3).trim();
    if (!locator) throw new LoginError(`Login step "${text}": the locator is missing.`);
    return { type: type as LoginStep['type'], locator, value };
  }
  if (LOCATOR_ONLY.has(type)) return { type: type as LoginStep['type'], locator: rest };
  throw new LoginError(`Login step "${text}": unknown action "${type}". Use goto, fill, press, select, click, dblclick, hover, check, uncheck or wait.`);
}

/** A typed password in a step would reach the logs; secrets must come from {{env:...}}. */
function literalSecret(step: LoginStep): boolean {
  return step.type === 'fill' && /pass(word|code)?|secret|pin\b|otp|token/i.test(step.locator ?? '') && !!step.value && !/\{\{\s*(env:[A-Za-z0-9_]+|totp)\s*\}\}/.test(step.value);
}

/** The session path: a .json file inside the project, written with forward slashes. */
export function checkSessionPath(session: string): string {
  const p = session.trim().replace(/\\/g, '/');
  if (!p) throw new LoginError('The session path is empty.');
  if (path.posix.isAbsolute(p) || /^[A-Za-z]:/.test(p)) throw new LoginError(`The session path must be relative to the project: ${session}`);
  const norm = path.posix.normalize(p);
  if (norm.startsWith('..') || norm.split('/').includes('..') || norm.startsWith('.git/')) throw new LoginError(`The session path must stay inside the project: ${session}`);
  if (!norm.endsWith('.json')) throw new LoginError(`The session path must end in .json: ${session}`);
  if (!/^[\w./@-]+$/.test(norm)) throw new LoginError(`The session path may use letters, digits, ".", "_", "-", "@" and "/": ${session}`);
  return norm;
}

/** Steps parsed and checked, before any browser starts. */
export function checkLogin(login: LoginConfig): { session: string; steps: LoginStep[] } {
  const session = checkSessionPath(login.session || DEFAULT_SESSION);
  const steps = (login.steps ?? []).map((s) => s.trim()).filter(Boolean).map(parseLoginStep);
  if (steps.length > 20) throw new LoginError('At most 20 login steps.');
  const bad = steps.find(literalSecret);
  if (bad) throw new LoginError(`Login step "${bad.type} ${bad.locator}" types a secret as plain text. Put it in an environment variable (E2E_PASSWORD) and write {{env:E2E_PASSWORD}}.`);
  if (steps.some((s) => s.type === 'fill' && /\{\{\s*totp\s*\}\}/.test(s.value ?? '')) && !login.totpEnv) {
    throw new LoginError('A step types {{totp}}, so name the variable with the authenticator secret (login-totp-env, e.g. E2E_TOTP_SECRET).');
  }
  if (steps.length && !login.check && !steps.some((s) => s.type === 'wait' && s.locator)) {
    throw new LoginError('Add login-check (a locator only a signed-in user sees, such as the Sign out button) or end the steps with "wait <that locator>", so a failed login is caught.');
  }
  return { session, steps };
}

/**
 * Make sure a working session file exists before anything opens a page.
 * With steps: the engine logs in (or keeps a saved session that still passes
 * the check). Without steps: the file must already be there.
 */
export async function ensureSession(
  mcp: ToolCaller,
  login: LoginConfig,
  options: { projectRoot: string; appUrl?: string; log?: (line: string) => void },
): Promise<string> {
  const log = options.log ?? (() => undefined);
  const { session, steps } = checkLogin(login);
  if (!steps.length) {
    const st = await stat(path.join(options.projectRoot, session)).catch(() => null);
    if (!st?.isFile()) {
      throw new LoginError(`The session file ${session} does not exist. Create it first (for example with your Playwright setup project), or give login steps so AutoHeal logs in itself.`);
    }
    log(`Signed in with the saved session ${session}`);
    return session;
  }
  if (!options.appUrl) throw new LoginError('Logging in needs the running app (--url or --start-command).');
  const origin = new URL(options.appUrl).origin;
  const loginUrl = new URL(login.url || '/login', options.appUrl);
  if (loginUrl.origin !== origin) throw new LoginError(`The login page must be on the app (${origin}); got ${loginUrl.origin}.`);
  for (const s of steps) {
    if (s.type === 'goto' && s.url && new URL(s.url, options.appUrl).origin !== origin) throw new LoginError(`Login step "goto ${s.url}" leaves the app (${origin}).`);
  }
  const res = await mcp.call(
    'save-login',
    {
      url: loginUrl.toString(),
      actions: steps,
      path: session,
      ...(login.check ? { verify: { visible: login.check } } : {}),
      ...(login.totpEnv ? { totpSecretEnv: login.totpEnv } : {}),
      timeoutMs: 120_000,
    },
    150_000,
  );
  const status = typeof res.data.status === 'string' ? res.data.status : '';
  if (!res.ok || (status !== 'saved' && status !== 'valid')) {
    const why = res.text.split('\n').filter((l) => l.trim()).slice(0, 6).join(' ').slice(0, 600);
    throw new LoginError(`Login failed, so nothing behind it can be tested: ${why || 'no answer from the engine'}`);
  }
  log(status === 'valid' ? `Signed in: the saved session ${session} still works` : `Signed in and saved the session to ${session}`);
  return session;
}

/** Where the new test should load the session: Playwright test.use, or pytest's browser_context_args. */
export function sessionPrompt(session: string, framework: string): string {
  if (framework === 'pytest') {
    return `The app needs a signed-in user. Pages you open are already signed in with the saved session ${session}. The test must use it too: unless conftest.py already passes storage_state in browser_context_args, mark the test with @pytest.mark.browser_context_args(storage_state="${session}"). Never type a password or log in inside the test.`;
  }
  return `The app needs a signed-in user. Pages you open are already signed in with the saved session ${session}. The test must use it too: unless playwright.config already sets storageState for these tests, add test.use({ storageState: '${session}' }); at the top of the file. Never type a password or log in inside the test.`;
}

/** The only session a new test may load is the configured one. */
export function sessionFindings(content: string, session: string | undefined): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/\b(?:storageState|storage_state)\s*[:=]\s*(?:(['"`])([^'"`]*)\1|([^\s,})]+))/g)) {
    const value = m[2] ?? m[3] ?? '';
    if (!session || path.posix.normalize(value.replace(/\\/g, '/').replace(/^\.\//, '')) !== session) {
      out.push(`session-file: the test loads a session other than the configured one (${value.slice(0, 80) || 'a computed value'})`);
    }
  }
  return out;
}
