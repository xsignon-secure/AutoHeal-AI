/**
 * Element fingerprints, kept with the repo (.autoheal/fingerprints/<id>.json,
 * one small file per locator so two AutoHeal PRs never conflict).
 *
 * Every trace AutoHeal reads teaches it what each locator pointed at: the
 * element's role, accessible name, test id, id, label and nearby heading.
 * When that locator stops matching, AutoHeal looks for the element with the
 * same fingerprint on the failed page and writes the strongest locator for
 * it, without AI tokens. Only short labels are stored, never page content
 * beyond an element's own name and text (cut at 120 characters).
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readZip } from './vision.js';
import { fingerprintOf, readSnapshots, targetOf } from './snapshot.js';
import { redact } from './redact.js';
export const FINGERPRINT_DIR = '.autoheal/fingerprints';
const MAX_FILES = 5000;
function pathOf(url) {
    if (!url)
        return undefined;
    try {
        return new URL(url).pathname;
    }
    catch {
        return undefined;
    }
}
export function fingerprintPath(selector, page) {
    const id = createHash('sha256').update(`${selector}\n${page ?? ''}`).digest('hex').slice(0, 16);
    return `${FINGERPRINT_DIR}/${id}.json`;
}
function valid(e) {
    const x = e;
    return !!x && typeof x.selector === 'string' && typeof x.at === 'string' && !!x.fingerprint && typeof x.fingerprint.tag === 'string';
}
export async function loadFingerprints(projectRoot) {
    const out = [];
    try {
        const dir = path.join(projectRoot, FINGERPRINT_DIR);
        for (const name of (await readdir(dir)).filter((n) => n.endsWith('.json')).slice(0, MAX_FILES)) {
            try {
                const entry = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
                if (valid(entry))
                    out.push(entry);
            }
            catch {
                // Skip a broken entry.
            }
        }
    }
    catch {
        // None yet.
    }
    return out;
}
/** The saved fingerprint for a selector, preferring the same page. */
export function lookup(entries, selector, page) {
    const same = entries.filter((e) => e.selector === selector);
    return same.find((e) => page !== undefined && e.page === page) ?? same.sort((a, b) => b.at.localeCompare(a.at))[0];
}
function parse(buf) {
    const out = [];
    for (const line of buf.toString('utf8').split('\n')) {
        if (!line.startsWith('{'))
            continue;
        try {
            out.push(JSON.parse(line));
        }
        catch {
            // skip
        }
    }
    return out;
}
const TARGET_PHASES = new Set(['action', 'input', 'after']);
/** Reads each library call's selector and target element from a trace.zip's entries. */
export function domFromTrace(entries) {
    const calls = [];
    const byId = new Map();
    const all = [];
    for (const [name, buf] of entries) {
        if (name === 'test.trace' || !name.endsWith('.trace'))
            continue;
        const lines = parse(buf);
        all.push(...lines);
        for (const l of lines) {
            if (l.type === 'before' && l.callId) {
                const c = { callId: l.callId, method: String(l.method ?? ''), failed: false };
                if (typeof l.params?.selector === 'string')
                    c.selector = l.params.selector;
                calls.push(c);
                byId.set(l.callId, c);
            }
            else if (l.type === 'after' && l.callId && l.error) {
                const c = byId.get(l.callId);
                if (c)
                    c.failed = true;
            }
        }
    }
    // A call that never got an "after" (the test timed out on it) failed too.
    const ended = new Set(all.filter((l) => l.type === 'after' && l.callId).map((l) => l.callId));
    for (const c of calls)
        if (c.selector && !ended.has(c.callId))
            c.failed = true;
    const failedCall = calls.find((c) => c.failed && c.selector);
    const withSelector = new Set(calls.filter((c) => c.selector).map((c) => c.callId));
    const snaps = readSnapshots(all, (callId, phase) => withSelector.has(callId) && (TARGET_PHASES.has(phase) || (callId === failedCall?.callId && phase === 'before')));
    const done = new Set();
    let failedPage;
    for (const s of snaps) {
        const c = byId.get(s.callId);
        if (!c)
            continue;
        if (c === failedCall && s.phase === 'before')
            failedPage = s;
        if (!TARGET_PHASES.has(s.phase) || done.has(c.callId) || c.failed)
            continue;
        const el = targetOf(s);
        if (!el)
            continue;
        c.target = fingerprintOf(el);
        const page = pathOf(s.frameUrl);
        if (page)
            c.page = page;
        done.add(c.callId);
    }
    if (failedCall && failedPage) {
        const page = pathOf(failedPage.frameUrl);
        if (page)
            failedCall.page = page;
    }
    return { calls, ...(failedPage ? { failedPage } : {}), ...(failedCall ? { failedCall } : {}) };
}
export function domFromZip(buf) {
    return domFromTrace(readZip(buf, (n) => n.endsWith('.trace')));
}
function scrub(fp) {
    const out = { tag: fp.tag };
    for (const [k, v] of Object.entries(fp))
        if (typeof v === 'string')
            out[k] = redact(v);
    return out;
}
/** Entries learned from a trace: one per selector that found its element. */
export function learn(dom, file, at = new Date().toISOString()) {
    const seen = new Set();
    const out = [];
    for (const c of dom.calls) {
        if (!c.selector || !c.target || c.failed)
            continue;
        const k = `${c.selector}\n${c.page ?? ''}`;
        if (seen.has(k))
            continue;
        seen.add(k);
        out.push({ at, selector: c.selector, ...(c.page ? { page: c.page } : {}), ...(file ? { file } : {}), fingerprint: scrub(c.target) });
    }
    return out;
}
/** Writes entries; returns the paths written (relative, forward slashes). */
export async function saveFingerprints(projectRoot, entries) {
    if (!entries.length)
        return [];
    await mkdir(path.join(projectRoot, FINGERPRINT_DIR), { recursive: true });
    const written = [];
    for (const e of entries) {
        const rel = fingerprintPath(e.selector, e.page);
        await writeFile(path.join(projectRoot, rel), `${JSON.stringify(e, null, 2)}\n`);
        written.push(rel);
    }
    return written;
}
//# sourceMappingURL=fingerprints.js.map