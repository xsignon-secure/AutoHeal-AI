/**
 * Find the cause: the app commit that made a test fail.
 *
 * A fixed locator says what changed on the page ("Log in" became "Sign in",
 * #greeting became #welcome-message); an app bug says which value changed
 * ($10 became $12). AutoHeal searches the repository history for the most
 * recent commit, outside the tests, that removed the old text or added the
 * new one (git log -S), and names it in the PR or the issue. One UI change
 * that broke many tests then shows up as one commit.
 *
 * Needs history in the checkout (fetch-depth). With a shallow clone the
 * search simply finds nothing.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
/** No hooks, no fsmonitor, no external diff or text conversion. */
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat'];
/** Test and AutoHeal files never count as the cause. */
const NOT_APP = [
    ':(exclude,glob)**/*.spec.*',
    ':(exclude,glob)**/*.test.*',
    ':(exclude,glob)**/tests/**',
    ':(exclude,glob)**/test/**',
    ':(exclude,glob)**/e2e/**',
    ':(exclude,glob)**/__tests__/**',
    ':(exclude,glob)**/test_*.py',
    ':(exclude,glob)**/*_test.py',
    ':(exclude,glob)**/playwright-quarantine.json',
    ':(exclude,glob).autoheal/**',
    ':(exclude,glob)**/package-lock.json',
    ':(exclude,glob)**/pnpm-lock.yaml',
    ':(exclude,glob)**/yarn.lock',
];
const usable = (t) => {
    const s = t.trim();
    return s.length >= 3 && s.length <= 200 && !/[\0\n\r]/.test(s) && !/^(?:button|link|textbox|heading|checkbox|radio|combobox|listbox|option|img|dialog|region|paragraph|true|false)$/i.test(s);
};
/** String literals in a locator expression, without CSS punctuation (#id → id). */
export function literals(expr) {
    const out = [];
    for (const m of expr.matchAll(/(['"`])((?:\\.|(?!\1).){1,200})\1/g)) {
        let s = m[2].replace(/\\(.)/g, '$1');
        if (/^[#.][\w-]+$/.test(s))
            s = s.slice(1);
        else {
            const attr = /^\[[\w-]+=["']?([^"'\]]+)["']?\]$/.exec(s);
            if (attr)
                s = attr[1];
        }
        out.push(s);
    }
    return out;
}
/** What a locator change removed and added, as search terms. */
export function termsFromLocators(changes) {
    const removed = new Set();
    const added = new Set();
    for (const c of changes) {
        const a = literals(c.before);
        const b = literals(c.after);
        for (const x of a)
            if (!b.includes(x) && usable(x))
                removed.add(x);
        for (const x of b)
            if (!a.includes(x) && usable(x))
                added.add(x);
    }
    return { removed: [...removed].slice(0, 3), added: [...added].slice(0, 3) };
}
async function git(root, args) {
    const { stdout } = await run('git', [...SAFE, ...args], { cwd: root, maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
    return stdout;
}
async function commitsTouching(root, term, depth) {
    try {
        const out = await git(root, ['log', `--max-count=${depth}`, '--format=%H', '--no-ext-diff', '--no-textconv', `-S${term}`, 'HEAD', '--', '.', ...NOT_APP]);
        return out.split('\n').filter((l) => /^[0-9a-f]{40}$/.test(l)).slice(0, 5);
    }
    catch {
        return [];
    }
}
/** The first changed line in the commit (app files only) that has `term` on the given side. */
async function lineWith(root, commit, term, side) {
    try {
        const out = await git(root, ['show', '--format=', '--no-ext-diff', '--no-textconv', '--unified=0', commit, '--', '.', ...NOT_APP]);
        let file = '';
        for (const l of out.split('\n')) {
            if (l.startsWith('+++ '))
                file = l.replace(/^\+\+\+ (?:b\/)?/, '');
            else if (l.startsWith(side) && !l.startsWith(`${side}${side}${side}`) && l.includes(term))
                return { file, line: l.slice(1).trim().slice(0, 160) };
        }
    }
    catch {
        // ignore
    }
    return null;
}
/** The most recent app commit that removed the old text and/or added the new one. */
export async function findCause(root, query, depth = 200) {
    const removed = query.removed.filter(usable);
    const added = query.added.filter(usable);
    if (!removed.length && !added.length)
        return null;
    const score = new Map();
    for (const t of removed)
        for (const c of await commitsTouching(root, t, depth))
            score.set(c, (score.get(c) ?? 0) + 1);
    for (const t of added)
        for (const c of await commitsTouching(root, t, depth))
            score.set(c, (score.get(c) ?? 0) + 1);
    if (!score.size)
        return null;
    // Check the direction: the commit must really remove the old text or add the new one.
    let best = null;
    let order = 0;
    for (const [commit] of score) {
        order++;
        let points = 0;
        const gone = removed.length ? await lineWith(root, commit, removed[0], '-') : null;
        const fresh = added.length ? await lineWith(root, commit, added[0], '+') : null;
        if (gone)
            points += 2;
        if (fresh)
            points += 2;
        if (!points)
            continue;
        const where = (fresh ?? gone)?.file ?? '';
        const evidence = gone && fresh
            ? `"${removed[0]}" → "${added[0]}" in \`${where}\``
            : gone
                ? `removed "${removed[0]}" in \`${where}\``
                : `added "${added[0]}" in \`${where}\``;
        // Most points wins; ties go to the most recent commit (git log order).
        if (!best || points > best.points)
            best = { commit, points, evidence };
        if (order > 8)
            break;
    }
    if (!best)
        return null;
    try {
        const meta = (await git(root, ['show', '-s', '--format=%h%x1f%s%x1f%an%x1f%aI', best.commit])).trim().split('\x1f');
        const files = (await git(root, ['show', '--format=', '--name-only', best.commit, '--', '.', ...NOT_APP])).split('\n').filter(Boolean).slice(0, 5);
        const cause = { commit: best.commit, short: meta[0] ?? best.commit.slice(0, 7), subject: (meta[1] ?? '').slice(0, 200), files, evidence: best.evidence };
        if (meta[2])
            cause.author = meta[2].slice(0, 100);
        if (meta[3])
            cause.date = meta[3].slice(0, 10);
        return cause;
    }
    catch {
        return null;
    }
}
/** Search terms for an app bug: the expected value is gone, the actual one is new. */
export function termsFromValues(expected, actual) {
    const clean = (v) => (v ?? '').replace(/^"(.*)"$/, '$1').replace(/^\/(.*)\/[a-z]*$/, '$1').trim();
    const e = clean(expected);
    const a = clean(actual);
    if (!e || !a || e === a)
        return { removed: [], added: [] };
    return { removed: usable(e) ? [e] : [], added: usable(a) ? [a] : [] };
}
//# sourceMappingURL=cause.js.map