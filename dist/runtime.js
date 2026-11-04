/**
 * Guard v2, the runtime half: compare what the test actually did before and
 * after a fix, from Playwright traces. The code scan sees only text; this
 * sees which assertions ran, against which values, on which page, and where
 * on the page each action landed.
 *
 * Before = the failed CI run's trace (it stops at the failure).
 * After  = one extra traced run of the fixed test.
 *
 * BLOCK when the fixed run
 *   - skips an assertion the failed run made, or checks another value
 *     (fewer or different checks);
 *   - makes a shared step on another page (origin + path);
 *   - acts on an element somewhere else on the page than the failed run did,
 *     for the steps both runs got through (same app, same commit, so the same
 *     element sits in the same place).
 */
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { readZip } from './vision.js';
const MAX_TRACE_BYTES = 200 * 1024 * 1024;
function lines(buf) {
    const out = [];
    for (const line of buf.toString('utf8').split('\n')) {
        if (!line.startsWith('{'))
            continue;
        try {
            out.push(JSON.parse(line));
        }
        catch {
            // skip a broken line
        }
    }
    return out;
}
function pageOf(url) {
    if (!url || url.startsWith('about:'))
        return undefined;
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
    }
    catch {
        return undefined;
    }
}
const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined);
/** Reads the steps of one test from a trace.zip's entries. */
export function recordFromTrace(entries) {
    const testLines = entries.get('test.trace');
    const steps = [];
    if (!testLines)
        return { steps };
    // Library side: stepId → callId, callId → box and page.
    const callOfStep = new Map();
    const boxOfCall = new Map();
    const pageOfCall = new Map();
    const endOfCall = new Map();
    for (const [name, buf] of entries) {
        if (name === 'test.trace' || !name.endsWith('.trace'))
            continue;
        for (const l of lines(buf)) {
            if (l.type === 'before' && l.callId && l.stepId)
                callOfStep.set(l.stepId, l.callId);
            else if (l.type === 'after' && l.callId && typeof l.endTime === 'number')
                endOfCall.set(l.callId, l.endTime);
            else if (l.type === 'input' && l.callId && l.box)
                boxOfCall.set(l.callId, l.box);
            else if (l.type === 'frame-snapshot' && l.snapshot?.callId && (l.snapshot.phase === 'before' || l.snapshot.snapshotName?.startsWith('before@'))) {
                // Newer Playwright marks the phase in `phase`; older versions in the snapshot name.
                const page = pageOf(l.snapshot.frameUrl);
                if (page)
                    pageOfCall.set(l.snapshot.callId, page);
            }
        }
    }
    const index = new Map();
    let failedAt;
    for (const l of lines(testLines)) {
        if (l.type === 'before' && l.stepId && (l.method === 'expect' || l.method === 'pw:api')) {
            if (l.method === 'pw:api' && /^(?:Launch browser|Create context|Create page|Close context|Close page)$/.test(l.title ?? ''))
                continue;
            const kind = l.method === 'expect' ? 'expect' : l.title === 'Navigate' ? 'navigate' : 'action';
            // An expect nested in another expect (expect.poll, toPass) counts once, at the top.
            if (kind === 'expect' && l.parentId && index.has(l.parentId))
                continue;
            const call = callOfStep.get(l.stepId);
            const step = { kind, title: l.title ?? '', failed: false };
            const target = str(l.params?.locator) ?? str(l.subtitle);
            if (target)
                step.target = target;
            const expected = str(l.params?.expected);
            if (expected !== undefined)
                step.expected = expected;
            const page = call ? pageOfCall.get(call) : undefined;
            if (page)
                step.page = page;
            const box = call ? boxOfCall.get(call) : undefined;
            if (box)
                step.box = box;
            const end = call ? endOfCall.get(call) : undefined;
            if (end !== undefined)
                step.end = end;
            index.set(l.stepId, steps.length);
            steps.push(step);
        }
        else if (l.type === 'after' && l.callId && l.error) {
            const i = index.get(l.callId);
            if (i !== undefined) {
                steps[i].failed = true;
                failedAt ??= i;
            }
        }
    }
    return failedAt === undefined ? { steps } : { steps, failedAt };
}
/** Reads a regular file through one handle (no symlinks, size checked on the open file), or null. */
export async function readTrace(file) {
    let fh;
    try {
        fh = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const st = await fh.stat();
        if (!st.isFile() || st.size > MAX_TRACE_BYTES)
            return null;
        return await fh.readFile();
    }
    catch {
        return null;
    }
    finally {
        await fh?.close();
    }
}
export async function recordFromFile(file) {
    const buf = await readTrace(file);
    if (!buf)
        return null;
    try {
        return recordFromTrace(readZip(buf, (n) => n.endsWith('.trace')));
    }
    catch {
        return null;
    }
}
const key = (s) => `${s.title}\u0000${s.expected ?? ''}`;
function far(a, b) {
    const dx = a.x + a.width / 2 - (b.x + b.width / 2);
    const dy = a.y + a.height / 2 - (b.y + b.height / 2);
    const slack = Math.max(24, Math.max(a.width, a.height, b.width, b.height) / 2);
    return Math.hypot(dx, dy) > slack;
}
/** Compares the failed run with the fixed run. Empty = nothing suspicious. */
export function compareRuns(before, after) {
    const findings = [];
    const oldChecks = before.steps.filter((s) => s.kind === 'expect');
    const newChecks = after.steps.filter((s) => s.kind === 'expect');
    if (oldChecks.length && !newChecks.length) {
        findings.push({ rule: 'runtime-no-checks', message: 'the fixed test ran no assertions at all' });
        return findings;
    }
    // Every check the failed run made (including the one that failed) must run again with the same value.
    const left = new Map();
    for (const s of newChecks)
        left.set(key(s), (left.get(key(s)) ?? 0) + 1);
    const gone = [];
    for (const s of oldChecks) {
        const n = left.get(key(s)) ?? 0;
        if (n > 0)
            left.set(key(s), n - 1);
        else
            gone.push(s);
    }
    if (gone.length) {
        const show = gone.slice(0, 2).map((s) => `${s.title}${s.expected !== undefined ? ` ${JSON.stringify(s.expected.slice(0, 60))}` : ''}`);
        findings.push({ rule: 'runtime-fewer-checks', message: `the fixed run no longer checks ${show.join(', ')}${gone.length > 2 ? ` and ${gone.length - 2} more` : ''}` });
    }
    // Steps both runs share, in order: same page, and actions on the same spot.
    const end = before.failedAt ?? before.steps.length - 1;
    let j = 0;
    for (let i = 0; i <= end && i < before.steps.length; i++) {
        const old = before.steps[i];
        while (j < after.steps.length && after.steps[j].title !== old.title)
            j++;
        const now = after.steps[j];
        if (!now)
            break;
        j++;
        if (old.page && now.page && old.page !== now.page) {
            findings.push({ rule: 'runtime-other-page', message: `"${old.title}" now runs on ${now.page} instead of ${old.page}` });
        }
        if (!old.failed && old.kind === 'action' && old.box && now.box && far(old.box, now.box)) {
            findings.push({
                rule: 'runtime-other-element',
                message: `"${old.title}${old.target ? ` ${old.target}` : ''}" now acts at (${Math.round(now.box.x)}, ${Math.round(now.box.y)}) instead of (${Math.round(old.box.x)}, ${Math.round(old.box.y)}), so it targets another element`,
            });
        }
    }
    const seen = new Set();
    return findings.filter((f) => !seen.has(f.message) && seen.add(f.message));
}
/** The newest trace.zip under `dir` written after `since` whose title ends with `title`. */
export async function findTrace(root, dirs, since, title) {
    const realRoot = await realpath(root).catch(() => root);
    let best = null;
    const want = title.split(' › ').pop()?.trim() ?? title;
    async function walk(dir, depth) {
        if (depth > 4)
            return;
        let names;
        try {
            names = await readdir(dir);
        }
        catch {
            return;
        }
        for (const name of names.slice(0, 2000)) {
            const p = path.join(dir, name);
            const st = await lstat(p).catch(() => null);
            if (!st || st.isSymbolicLink() || name === 'node_modules' || name.startsWith('.'))
                continue;
            if (st.isDirectory())
                await walk(p, depth + 1);
            else if (name === 'trace.zip' && st.mtimeMs >= since && st.size <= MAX_TRACE_BYTES && (!best || st.mtimeMs > best.mtime)) {
                const buf = await readTrace(p);
                if (!buf)
                    continue;
                const entries = readZip(buf, (n) => n === '0-trace.trace' || n === 'test.trace');
                const head = entries.get('0-trace.trace')?.toString('utf8').split('\n', 1)[0] ?? '';
                let t = '';
                try {
                    t = String(JSON.parse(head).title ?? '');
                }
                catch {
                    t = '';
                }
                if (!t || t.endsWith(want))
                    best = { file: p, mtime: st.mtimeMs };
            }
        }
    }
    for (const d of dirs) {
        const abs = path.resolve(realRoot, d);
        if (abs === realRoot || abs.startsWith(realRoot + path.sep))
            await walk(abs, 0);
    }
    return best ? best.file : null;
}
//# sourceMappingURL=runtime.js.map