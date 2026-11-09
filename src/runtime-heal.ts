/**
 * Healing during the run, for Playwright Test. In your fixtures file:
 *
 *   import { test as base } from '@playwright/test';
 *   import { withAutoHeal } from 'xsignon-autoheal/playwright';
 *   export const test = withAutoHeal(base);
 *
 * (or `import { test, expect } from 'xsignon-autoheal/playwright'`).
 *
 * When an action (click, fill, check…) is about to wait on an element that
 * is not on the page, and AutoHeal has a fingerprint of what that locator
 * found before, it looks for that element on the current page. A clear match
 * is used for this one action, the test goes on, and the heal is written to
 * `autoheal-healed/` and the test's annotations. The AutoHeal job then turns
 * it into a proven code fix (stability rerun, anti-cheat guard) in a PR.
 *
 * Never healed: assertions (`expect(...)`, so checked values never move),
 * weak or unclear matches, frames other than the main one, and anything when
 * AUTOHEAL_RUNTIME=off (AutoHeal's own reruns always set that) or `report`
 * (records what it would have done, then lets the action fail as usual).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadFingerprints, lookup, type FingerprintEntry } from './fingerprints.js';
import { loadLearned, LEARNED_DIR } from './learned.js';
import { locatorFor, parseSelector, renderLocator, type ParsedLocator } from './locators.js';
import { bestMatch, elements, type El } from './snapshot.js';
import { restoreTree } from './cypress-dom.js';

export const HEALED_DIR = 'autoheal-healed';
export type RuntimeMode = 'heal' | 'report' | 'off';

export interface HealedEntry {
  version: 1;
  /** Spec file, relative to the project root, forward slashes. */
  file: string;
  /** Full title (describe titles and the test title joined by " › "). */
  title: string;
  /** Playwright's selector for the locator that found nothing. */
  selector: string;
  /** The locator used instead. */
  locator: ParsedLocator;
  /** The same, as code. */
  code: string;
  page?: string;
  score: number;
  signals: string[];
  /** What the test did with it. */
  action: string;
  /** heal: the action used the new locator; report: it only recorded it. */
  mode: 'heal' | 'report';
  at: string;
}

export interface AutoHealOptions {
  /** heal (default), report or off; AUTOHEAL_RUNTIME wins when set. */
  mode?: RuntimeMode;
  /** How long an element may be missing before AutoHeal looks for it (ms, default 3000). */
  waitMs?: number;
  /** Project root, for fingerprints and file names (default: the current folder). */
  root?: string;
  /** Where heals are written (default autoheal-healed/, or AUTOHEAL_HEALED_DIR). */
  outDir?: string;
  /** Test id attribute your config uses (default data-testid). */
  testIdAttribute?: string;
}

const ACTIONS = ['click', 'dblclick', 'fill', 'check', 'uncheck', 'setChecked', 'press', 'pressSequentially', 'type', 'hover', 'tap', 'selectOption', 'focus', 'clear', 'setInputFiles', 'selectText', 'dragTo'] as const;

export function runtimeMode(env: NodeJS.ProcessEnv, fallback: RuntimeMode = 'heal'): RuntimeMode {
  const v = (env.AUTOHEAL_RUNTIME ?? '').trim().toLowerCase();
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  if (v === 'report') return 'report';
  if (v === 'heal' || v === 'on' || v === 'true') return 'heal';
  return fallback;
}

/** The page as AutoHeal's element tree. Runs in the browser; keep it self-contained. */
export function serializeDom(): unknown {
  const MAX = 20000;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  let count = 0;
  const visit = (node: Node, depth: number): unknown => {
    if (count > MAX || depth > 200) return null;
    if (node.nodeType === 3) {
      const t = node.nodeValue;
      return t && t.trim() ? t.slice(0, 300) : null;
    }
    if (node.nodeType !== 1) return null;
    count++;
    const el = node as Element;
    const tag = String(el.tagName || '').toUpperCase();
    const attrs: Record<string, string> = {};
    for (const a of Array.from(el.attributes || []).slice(0, 40)) attrs[a.name] = String(a.value).slice(0, 300);
    const children: unknown[] = [];
    if (!SKIP.has(tag) && tag !== 'SVG') {
      for (const child of Array.from(el.childNodes)) {
        const c = visit(child, depth + 1);
        if (c !== null) children.push(c);
      }
    }
    return { tag, attrs, children };
  };
  return visit(document.documentElement, 0);
}

/** A clear, unique replacement for the selector on this page, or null. */
export function healOnPage(entry: FingerprintEntry, root: El, testIdAttribute = 'data-testid'): { locator: ParsedLocator; score: number; signals: string[] } | null {
  const match = bestMatch(entry.fingerprint, elements(root), { action: true });
  if (!match) return null;
  const locator = locatorFor(match.element, root, testIdAttribute);
  if (!locator) return null;
  return { locator, score: match.score, signals: match.signals };
}

// Minimal shapes of the Playwright objects used here (no type dependency on @playwright/test).
interface PwLocator {
  _selector?: string;
  _frame?: unknown;
  page(): PwPage;
  count(): Promise<number>;
  first(): PwLocator;
  waitFor(o: { state: string; timeout: number }): Promise<void>;
  [k: string]: unknown;
}
interface PwPage {
  url(): string;
  mainFrame(): unknown;
  evaluate<T>(fn: () => T): Promise<T>;
  locator(s: string): PwLocator;
  getByRole(role: string, o?: { name?: string; exact?: boolean }): PwLocator;
  getByLabel(t: string, o?: { exact?: boolean }): PwLocator;
  getByPlaceholder(t: string, o?: { exact?: boolean }): PwLocator;
  getByText(t: string, o?: { exact?: boolean }): PwLocator;
  getByAltText(t: string, o?: { exact?: boolean }): PwLocator;
  getByTitle(t: string, o?: { exact?: boolean }): PwLocator;
  getByTestId(t: string): PwLocator;
}
interface PwTestInfo {
  file: string;
  titlePath: string[];
  annotations: Array<{ type: string; description?: string }>;
}
interface PwTest {
  extend(fixtures: Record<string, unknown>): unknown;
  info(): PwTestInfo;
}

export function toLocator(page: PwPage, loc: ParsedLocator): PwLocator {
  const exact = loc.exact ? { exact: true } : undefined;
  switch (loc.kind) {
    case 'role':
      return page.getByRole(loc.value, { ...(loc.name !== undefined ? { name: loc.name } : {}), ...(loc.exact ? { exact: true } : {}) });
    case 'label':
      return page.getByLabel(loc.value, exact);
    case 'placeholder':
      return page.getByPlaceholder(loc.value, exact);
    case 'text':
      return page.getByText(loc.value, exact);
    case 'alt':
      return page.getByAltText(loc.value, exact);
    case 'title':
      return page.getByTitle(loc.value, exact);
    case 'testid':
      return page.getByTestId(loc.value);
    default:
      return page.locator(loc.value);
  }
}

function pathOf(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

/** Shared state of one worker. */
interface State {
  options: Required<Pick<AutoHealOptions, 'waitMs' | 'root' | 'outDir' | 'testIdAttribute'>> & { mode: RuntimeMode };
  entries: FingerprintEntry[] | null;
  loading: Promise<FingerprintEntry[]> | null;
  info: (() => PwTestInfo) | null;
  written: number;
}

const state: State = { options: { mode: 'off', waitMs: 3000, root: process.cwd(), outDir: HEALED_DIR, testIdAttribute: 'data-testid' }, entries: null, loading: null, info: null, written: 0 };
const PATCHED = Symbol.for('autoheal.patched');
const HEALED = Symbol.for('autoheal.healed');

async function fingerprints(): Promise<FingerprintEntry[]> {
  if (state.entries) return state.entries;
  if (!state.loading) {
    state.loading = (async () => {
      const root = state.options.root;
      const out = await loadFingerprints(root);
      const learnedDir = process.env.AUTOHEAL_LEARNED_DIR || path.join(root, LEARNED_DIR);
      out.push(...(await loadLearned(learnedDir)));
      return out;
    })();
  }
  state.entries = await state.loading;
  return state.entries;
}

function record(entry: HealedEntry): void {
  try {
    const info = state.info?.();
    info?.annotations.push({ type: 'autoheal-healed', description: `${entry.code} (was ${entry.selector}; match ${Math.round(entry.score * 100)}%)` });
  } catch {
    // outside a test
  }
  if (state.written >= 200) return;
  try {
    const dir = path.resolve(state.options.root, state.options.outDir);
    mkdirSync(dir, { recursive: true });
    const id = createHash('sha256').update(`${entry.file}\n${entry.title}\n${entry.selector}`).digest('hex').slice(0, 16);
    writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(entry, null, 2)}\n`);
    state.written++;
  } catch {
    // Recording is a help; never fail the test because of it.
  }
}

/** Wraps the action methods of Playwright's Locator class once per worker. */
function patch(proto: Record<string | symbol, unknown>): void {
  if (proto[PATCHED]) return;
  proto[PATCHED] = true;
  for (const name of ACTIONS) {
    const original = proto[name];
    if (typeof original !== 'function') continue;
    proto[name] = async function (this: PwLocator, ...args: unknown[]): Promise<unknown> {
      const run = (target: PwLocator) => (original as (...a: unknown[]) => Promise<unknown>).apply(target, args);
      if (state.options.mode === 'off' || (this as unknown as Record<symbol, unknown>)[HEALED] || !state.info) return run(this);
      const selector = typeof this._selector === 'string' ? this._selector : undefined;
      let page: PwPage;
      try {
        page = this.page();
        if (this._frame && this._frame !== page.mainFrame()) return run(this);
      } catch {
        return run(this);
      }
      if (!selector || !parseSelector(selector)) return run(this);
      const saved = lookup(await fingerprints(), selector, pathOf(page.url()));
      if (!saved) return run(this);
      try {
        await this.first().waitFor({ state: 'attached', timeout: state.options.waitMs });
        return run(this);
      } catch {
        // Not on the page: look for the element it found before.
      }
      let found: ReturnType<typeof healOnPage> = null;
      try {
        const raw = await page.evaluate(serializeDom as () => unknown);
        const root = restoreTree(raw);
        if (root) found = healOnPage(saved, root, state.options.testIdAttribute);
      } catch {
        found = null;
      }
      if (!found) return run(this);
      const healed = toLocator(page, found.locator);
      if ((await healed.count().catch(() => 0)) !== 1) return run(this);
      let info: PwTestInfo | undefined;
      try {
        info = state.info();
      } catch {
        info = undefined;
      }
      const entry: HealedEntry = {
        version: 1,
        file: info ? path.relative(state.options.root, info.file).split(path.sep).join('/') : '',
        title: info ? info.titlePath.slice(1).join(' › ') : '',
        selector,
        locator: found.locator,
        code: renderLocator(found.locator, false),
        ...(pathOf(page.url()) ? { page: pathOf(page.url()) as string } : {}),
        score: found.score,
        signals: found.signals,
        action: name,
        mode: state.options.mode === 'report' ? 'report' : 'heal',
        at: new Date().toISOString(),
      };
      record(entry);
      if (state.options.mode === 'report') return run(this);
      console.warn(`[autoheal] healed ${name}(): ${selector} → ${entry.code} (match ${Math.round(found.score * 100)}%)`);
      (healed as unknown as Record<symbol, unknown>)[HEALED] = true;
      return run(healed);
    };
  }
}

/**
 * Your Playwright `test` with healing during the run. Pass options, or set
 * AUTOHEAL_RUNTIME=heal|report|off and AUTOHEAL_HEAL_AFTER_MS.
 */
export function withAutoHeal<T>(test: T, options: AutoHealOptions = {}): T {
  const t = test as unknown as PwTest;
  const env = process.env;
  const waitEnv = Number(env.AUTOHEAL_HEAL_AFTER_MS);
  state.options = {
    mode: runtimeMode(env, options.mode ?? 'heal'),
    waitMs: Number.isFinite(waitEnv) && waitEnv >= 0 ? waitEnv : (options.waitMs ?? 3000),
    root: options.root ?? process.cwd(),
    outDir: env.AUTOHEAL_HEALED_DIR || options.outDir || HEALED_DIR,
    testIdAttribute: options.testIdAttribute ?? 'data-testid',
  };
  return t.extend({
    // Wraps `page`, so tests that never open a page pay nothing.
    page: async ({ page }: { page: PwPage }, use: (v: PwPage) => Promise<void>) => {
      if (state.options.mode !== 'off') {
        try {
          patch(Object.getPrototypeOf(page.locator('html')) as Record<string | symbol, unknown>);
        } catch {
          // An unexpected Playwright version: run without healing.
        }
        state.info = () => t.info();
      }
      await use(page);
      state.info = null;
    },
  }) as T;
}

function validHealed(x: unknown): x is HealedEntry {
  const e = x as Partial<HealedEntry> | null;
  return (
    !!e &&
    e.version === 1 &&
    typeof e.file === 'string' &&
    e.file.length <= 400 &&
    !e.file.startsWith('/') &&
    !e.file.split('/').includes('..') &&
    typeof e.title === 'string' &&
    e.title.length <= 1000 &&
    typeof e.selector === 'string' &&
    e.selector.length <= 2000 &&
    !!e.locator &&
    typeof e.locator.kind === 'string' &&
    typeof e.locator.value === 'string' &&
    typeof e.score === 'number' &&
    Array.isArray(e.signals)
  );
}

/** Every heal recorded under these folders (any `autoheal-healed/` inside them, or the folder itself). */
export async function loadHealed(dirs: string[]): Promise<HealedEntry[]> {
  const { readdir, open, lstat } = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const out = new Map<string, HealedEntry>();
  const read = async (dir: string) => {
    for (const name of (await readdir(dir).catch(() => [] as string[])).slice(0, 500)) {
      if (!/^[0-9a-f]{16}\.json$/.test(name)) continue;
      const p = path.join(dir, name);
      // One open (no symlinks), then every check on that same descriptor.
      const fh = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
      if (!fh) continue;
      try {
        const st = await fh.stat();
        if (!st.isFile() || st.size > 64 * 1024) continue;
        const e = JSON.parse(await fh.readFile('utf8')) as unknown;
        if (validHealed(e)) out.set(`${e.file}\n${e.title}\n${e.selector}`, e);
      } catch {
        // skip
      } finally {
        await fh.close().catch(() => undefined);
      }
    }
  };
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 5) return;
    if (path.basename(dir) === HEALED_DIR) return read(dir);
    for (const name of (await readdir(dir).catch(() => [] as string[])).slice(0, 2000)) {
      if (name === 'node_modules' || name === '.git') continue;
      const p = path.join(dir, name);
      const st = await lstat(p).catch(() => null);
      if (st?.isDirectory()) await walk(p, depth + 1);
    }
  };
  for (const d of dirs) {
    const st = await lstat(d).catch(() => null);
    if (st?.isDirectory()) await walk(d, 0);
  }
  return [...out.values()];
}
