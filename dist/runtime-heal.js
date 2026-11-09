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
import { loadFingerprints, lookup } from './fingerprints.js';
import { loadLearned, LEARNED_DIR } from './learned.js';
import { locatorFor, parseSelector, renderLocator } from './locators.js';
import { bestMatch, elements } from './snapshot.js';
import { restoreTree } from './cypress-dom.js';
export const HEALED_DIR = 'autoheal-healed';
const ACTIONS = ['click', 'dblclick', 'fill', 'check', 'uncheck', 'setChecked', 'press', 'pressSequentially', 'type', 'hover', 'tap', 'selectOption', 'focus', 'clear', 'setInputFiles', 'selectText', 'dragTo'];
export function runtimeMode(env, fallback = 'heal') {
    const v = (env.AUTOHEAL_RUNTIME ?? '').trim().toLowerCase();
    if (v === 'off' || v === 'false' || v === '0')
        return 'off';
    if (v === 'report')
        return 'report';
    if (v === 'heal' || v === 'on' || v === 'true')
        return 'heal';
    return fallback;
}
/** The page as AutoHeal's element tree. Runs in the browser; keep it self-contained. */
export function serializeDom() {
    const MAX = 20000;
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
    let count = 0;
    const visit = (node, depth) => {
        if (count > MAX || depth > 200)
            return null;
        if (node.nodeType === 3) {
            const t = node.nodeValue;
            return t && t.trim() ? t.slice(0, 300) : null;
        }
        if (node.nodeType !== 1)
            return null;
        count++;
        const el = node;
        const tag = String(el.tagName || '').toUpperCase();
        const attrs = {};
        for (const a of Array.from(el.attributes || []).slice(0, 40))
            attrs[a.name] = String(a.value).slice(0, 300);
        const children = [];
        if (!SKIP.has(tag) && tag !== 'SVG') {
            for (const child of Array.from(el.childNodes)) {
                const c = visit(child, depth + 1);
                if (c !== null)
                    children.push(c);
            }
        }
        return { tag, attrs, children };
    };
    return visit(document.documentElement, 0);
}
/** A clear, unique replacement for the selector on this page, or null. */
export function healOnPage(entry, root, testIdAttribute = 'data-testid') {
    const match = bestMatch(entry.fingerprint, elements(root), { action: true });
    if (!match)
        return null;
    const locator = locatorFor(match.element, root, testIdAttribute);
    if (!locator)
        return null;
    return { locator, score: match.score, signals: match.signals };
}
export function toLocator(page, loc) {
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
function pathOf(url) {
    try {
        return new URL(url).pathname;
    }
    catch {
        return undefined;
    }
}
const state = { options: { mode: 'off', waitMs: 3000, root: process.cwd(), outDir: HEALED_DIR, testIdAttribute: 'data-testid' }, entries: null, loading: null, info: null, written: 0 };
const PATCHED = Symbol.for('autoheal.patched');
const HEALED = Symbol.for('autoheal.healed');
async function fingerprints() {
    if (state.entries)
        return state.entries;
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
function record(entry) {
    try {
        const info = state.info?.();
        info?.annotations.push({ type: 'autoheal-healed', description: `${entry.code} (was ${entry.selector}; match ${Math.round(entry.score * 100)}%)` });
    }
    catch {
        // outside a test
    }
    if (state.written >= 200)
        return;
    try {
        const dir = path.resolve(state.options.root, state.options.outDir);
        mkdirSync(dir, { recursive: true });
        const id = createHash('sha256').update(`${entry.file}\n${entry.title}\n${entry.selector}`).digest('hex').slice(0, 16);
        writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(entry, null, 2)}\n`);
        state.written++;
    }
    catch {
        // Recording is a help; never fail the test because of it.
    }
}
/** Wraps the action methods of Playwright's Locator class once per worker. */
function patch(proto) {
    if (proto[PATCHED])
        return;
    proto[PATCHED] = true;
    for (const name of ACTIONS) {
        const original = proto[name];
        if (typeof original !== 'function')
            continue;
        proto[name] = async function (...args) {
            const run = (target) => original.apply(target, args);
            if (state.options.mode === 'off' || this[HEALED] || !state.info)
                return run(this);
            const selector = typeof this._selector === 'string' ? this._selector : undefined;
            let page;
            try {
                page = this.page();
                if (this._frame && this._frame !== page.mainFrame())
                    return run(this);
            }
            catch {
                return run(this);
            }
            if (!selector || !parseSelector(selector))
                return run(this);
            const saved = lookup(await fingerprints(), selector, pathOf(page.url()));
            if (!saved)
                return run(this);
            try {
                await this.first().waitFor({ state: 'attached', timeout: state.options.waitMs });
                return run(this);
            }
            catch {
                // Not on the page: look for the element it found before.
            }
            let found = null;
            try {
                const raw = await page.evaluate(serializeDom);
                const root = restoreTree(raw);
                if (root)
                    found = healOnPage(saved, root, state.options.testIdAttribute);
            }
            catch {
                found = null;
            }
            if (!found)
                return run(this);
            const healed = toLocator(page, found.locator);
            if ((await healed.count().catch(() => 0)) !== 1)
                return run(this);
            let info;
            try {
                info = state.info();
            }
            catch {
                info = undefined;
            }
            const entry = {
                version: 1,
                file: info ? path.relative(state.options.root, info.file).split(path.sep).join('/') : '',
                title: info ? info.titlePath.slice(1).join(' › ') : '',
                selector,
                locator: found.locator,
                code: renderLocator(found.locator, false),
                ...(pathOf(page.url()) ? { page: pathOf(page.url()) } : {}),
                score: found.score,
                signals: found.signals,
                action: name,
                mode: state.options.mode === 'report' ? 'report' : 'heal',
                at: new Date().toISOString(),
            };
            record(entry);
            if (state.options.mode === 'report')
                return run(this);
            console.warn(`[autoheal] healed ${name}(): ${selector} → ${entry.code} (match ${Math.round(found.score * 100)}%)`);
            healed[HEALED] = true;
            return run(healed);
        };
    }
}
/**
 * Your Playwright `test` with healing during the run. Pass options, or set
 * AUTOHEAL_RUNTIME=heal|report|off and AUTOHEAL_HEAL_AFTER_MS.
 */
export function withAutoHeal(test, options = {}) {
    const t = test;
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
        page: async ({ page }, use) => {
            if (state.options.mode !== 'off') {
                try {
                    patch(Object.getPrototypeOf(page.locator('html')));
                }
                catch {
                    // An unexpected Playwright version: run without healing.
                }
                state.info = () => t.info();
            }
            await use(page);
            state.info = null;
        },
    });
}
function validHealed(x) {
    const e = x;
    return (!!e &&
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
        Array.isArray(e.signals));
}
/** Every heal recorded under these folders (any `autoheal-healed/` inside them, or the folder itself). */
export async function loadHealed(dirs) {
    const { readdir, readFile, lstat } = await import('node:fs/promises');
    const out = new Map();
    const read = async (dir) => {
        for (const name of (await readdir(dir).catch(() => [])).slice(0, 500)) {
            if (!/^[0-9a-f]{16}\.json$/.test(name))
                continue;
            const p = path.join(dir, name);
            const st = await lstat(p).catch(() => null);
            if (!st || !st.isFile() || st.size > 64 * 1024)
                continue;
            try {
                const e = JSON.parse(await readFile(p, 'utf8'));
                if (validHealed(e))
                    out.set(`${e.file}\n${e.title}\n${e.selector}`, e);
            }
            catch {
                // skip
            }
        }
    };
    const walk = async (dir, depth) => {
        if (depth > 5)
            return;
        if (path.basename(dir) === HEALED_DIR)
            return read(dir);
        for (const name of (await readdir(dir).catch(() => [])).slice(0, 2000)) {
            if (name === 'node_modules' || name === '.git')
                continue;
            const p = path.join(dir, name);
            const st = await lstat(p).catch(() => null);
            if (st?.isDirectory())
                await walk(p, depth + 1);
        }
    };
    for (const d of dirs) {
        const st = await lstat(d).catch(() => null);
        if (st?.isDirectory())
            await walk(d, 0);
    }
    return [...out.values()];
}
//# sourceMappingURL=runtime-heal.js.map