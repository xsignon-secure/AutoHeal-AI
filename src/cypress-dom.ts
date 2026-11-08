/**
 * What the xsignon-autoheal/cypress plugin saw during a run: for each test, the
 * elements its cy.get / .find calls found (as fingerprints) and, when a query
 * found nothing and the test failed, the page at that moment. AutoHeal reads
 * these the way it reads Playwright traces, so Cypress gets fingerprint fixes
 * with no AI tokens too.
 */

import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { elements, type El } from './snapshot.js';
import type { TraceDom, TraceCall } from './fingerprints.js';

export const CYPRESS_DOM_DIR = 'cypress/autoheal';
const MAX_FILES = 3000;
const MAX_BYTES = 4 * 1024 * 1024;

export interface CypressDom {
  spec: string;
  title: string;
  dom: TraceDom;
}

/** Puts parent links back into a tree that came through JSON (non-enumerable, like the browser side). */
export function restoreTree(raw: unknown, parent?: El, depth = 0): El | null {
  const n = raw as { tag?: unknown; attrs?: unknown; children?: unknown } | null;
  if (!n || typeof n !== 'object' || typeof n.tag !== 'string' || depth > 400) return null;
  const attrs: Record<string, string> = {};
  if (n.attrs && typeof n.attrs === 'object') for (const [k, v] of Object.entries(n.attrs as Record<string, unknown>)) if (typeof v === 'string') attrs[k] = v;
  const el: El = { tag: n.tag.toUpperCase(), attrs, children: [] };
  if (parent) Object.defineProperty(el, 'parent', { value: parent, enumerable: false, writable: true });
  for (const c of Array.isArray(n.children) ? n.children : []) {
    if (typeof c === 'string') el.children.push(c);
    else {
      const child = restoreTree(c, el, depth + 1);
      if (child) el.children.push(child);
    }
  }
  return el;
}

function readCall(raw: unknown): TraceCall | null {
  const c = raw as Partial<TraceCall> | null;
  if (!c || typeof c.selector !== 'string' || c.selector.length > 1000 || typeof c.callId !== 'string') return null;
  const out: TraceCall = { callId: c.callId, method: 'get', selector: c.selector, failed: c.failed === true };
  if (c.target && typeof c.target === 'object' && typeof (c.target as { tag?: unknown }).tag === 'string') out.target = c.target;
  if (typeof c.page === 'string' && c.page.length <= 400) out.page = c.page;
  return out;
}

/** One saved file, checked field by field. */
export function parseCypressDom(text: string): CypressDom | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!data || data.version !== 1 || typeof data.spec !== 'string' || typeof data.title !== 'string' || !Array.isArray(data.calls)) return null;
  const calls = (data.calls as unknown[]).slice(0, 2000).map(readCall).filter((c): c is TraceCall => c !== null);
  const dom: TraceDom = { calls };
  const fc = readCall(data.failedCall);
  const fp = data.failedPage as { root?: unknown; frameUrl?: unknown } | undefined;
  const root = fp ? restoreTree(fp.root) : null;
  if (fc && root) {
    const failedCall = calls.find((c) => c.callId === fc.callId) ?? fc;
    dom.failedCall = failedCall;
    dom.failedPage = { callId: failedCall.callId, phase: 'before', root, ...(typeof fp?.frameUrl === 'string' ? { frameUrl: fp.frameUrl } : {}) };
  }
  return { spec: data.spec.replace(/\\/g, '/'), title: data.title, dom };
}

/** Every saved file under the given folders (inside the project only). */
export async function loadCypressDoms(root: string, dirs: string[]): Promise<CypressDom[]> {
  const out: CypressDom[] = [];
  let files = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6 || files >= MAX_FILES) return;
    const rel = path.relative(root, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return;
    for (const name of (await readdir(dir).catch(() => [] as string[])).slice(0, 5000)) {
      if (name === 'node_modules' || name === '.git') continue;
      const p = path.join(dir, name);
      const st = await lstat(p).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) await walk(p, depth + 1);
      else if (/^[0-9a-f]{16}\.json$/.test(name) && st.size <= MAX_BYTES && files < MAX_FILES) {
        files++;
        const parsed = parseCypressDom(await readFile(p, 'utf8').catch(() => ''));
        if (parsed) out.push(parsed);
      }
    }
  };
  for (const d of [...new Set(dirs.map((x) => path.resolve(root, x)))]) await walk(d, 0);
  return out;
}

const sameSpec = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

/** The saved run of one failing test (same spec, same full title). */
export function domFor(doms: CypressDom[], file: string, title: string): TraceDom | undefined {
  return doms.find((d) => d.title === title && sameSpec(d.spec.replace(/\\/g, '/'), file.replace(/\\/g, '/')))?.dom;
}

const TEST_ATTRS = ['data-cy', 'data-test', 'data-testid', 'data-test-id', 'data-qa'];
const SAFE_VALUE = /^[^"'\\\n\r]{1,120}$/;
const IDENT = /^[A-Za-z][\w-]{0,80}$/;

/**
 * The strongest CSS selector that picks exactly this element, in the order
 * Cypress recommends: data-cy / data-test / data-testid first, then a stable
 * id, then name or aria-label with the tag. Null when none is unique.
 */
export function cypressSelectorFor(target: El, root: El): string | null {
  const all = elements(root);
  const unique = (pick: (e: El) => boolean) => all.filter(pick).length === 1;
  const tag = target.tag.toLowerCase();
  for (const a of TEST_ATTRS) {
    const v = target.attrs[a];
    if (v && SAFE_VALUE.test(v) && unique((e) => e.attrs[a] === v)) return `[${a}="${v}"]`;
  }
  const id = target.attrs.id;
  // Ids with long digit runs are usually generated per render.
  if (id && IDENT.test(id) && !/\d{3,}/.test(id) && unique((e) => e.attrs.id === id)) return `#${id}`;
  for (const a of ['name', 'aria-label']) {
    const v = target.attrs[a];
    if (v && SAFE_VALUE.test(v) && /^[a-z][a-z0-9-]*$/.test(tag) && unique((e) => e.tag === target.tag && e.attrs[a] === v)) return `${tag}[${a}="${v}"]`;
  }
  return null;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches a selector as the first argument of cy.get(...) or .find(...), in any quote style. */
export function cypressPattern(selector: string): RegExp {
  return new RegExp(`(\\b(?:get|find)\\(\\s*)(['"\`])${escapeRegex(selector)}\\2`, 'g');
}

/** The source with every cy.get / .find of the old selector changed to the new one. */
export function replaceCypressSelector(source: string, old: string, next: string): { next: string; before: string; after: string } | null {
  const pattern = cypressPattern(old);
  const first = pattern.exec(source);
  if (!first) return null;
  pattern.lastIndex = 0;
  let changedTo = '';
  const out = source.replace(pattern, (_m, call: string, quote: string) => {
    // Keep the file's quote: swap the selector's inner quotes when they clash.
    const inner = quote === '"' ? next.split('"').join("'") : next;
    if (quote !== '"' && inner.includes(quote)) return _m;
    changedTo = `${call}${quote}${inner}${quote}`;
    return changedTo;
  });
  if (out === source || !changedTo) return null;
  return { next: out, before: first[0], after: changedTo };
}

/** The `it(...)` titles in a spec, for quarantine entries (Cypress reports the full title). */
export function itTitles(source: string): string[] {
  const out: string[] = [];
  const re = /\b(?:it|specify)(?:\.only)?\(\s*(['"`])((?:(?!\1)[^\\\n]|\\.){1,300})\1/g;
  for (const m of source.matchAll(re)) if (m[2]) out.push(m[2]);
  return out;
}

/** The own title of a test from its full title (describe titles joined by spaces). */
export function ownTitle(fullTitle: string, source: string): string | undefined {
  return itTitles(source)
    .filter((t) => fullTitle === t || fullTitle.endsWith(` ${t}`))
    .sort((a, b) => b.length - a.length)[0];
}
