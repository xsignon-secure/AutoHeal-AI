/**
 * Failure history: how often each test failed across AutoHeal's runs. Kept
 * outside the repository, as the newest `autoheal-history` artifact on GitHub
 * (or a file you pass with AUTOHEAL_HISTORY_FILE, e.g. a CI cache). Each heal
 * run reads it, adds this run's results, and saves it again, so a flaky test's
 * PR and issue say how long it has been flaky.
 */
import { readFile } from 'node:fs/promises';
import { readZip } from './vision.js';
export const HISTORY_ARTIFACT = 'autoheal-history';
export const HISTORY_FILE = 'history.json';
const MAX_TESTS = 1000;
const MAX_RUNS = 30;
const MAX_BYTES = 2 * 1024 * 1024;
export const emptyHistory = () => ({ version: 1, tests: {} });
const key = (file, title) => `${file}\n${title}`;
/** Parses history JSON, keeping only well-formed entries. */
export function parseHistory(text) {
    const out = emptyHistory();
    if (text.length > MAX_BYTES)
        return out;
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        return out;
    }
    const tests = raw?.tests;
    if (!tests || typeof tests !== 'object')
        return out;
    for (const v of Object.values(tests).slice(0, MAX_TESTS)) {
        const t = v;
        if (typeof t?.file !== 'string' || typeof t.title !== 'string' || !Array.isArray(t.runs) || t.file.length > 400 || t.title.length > 1000)
            continue;
        const runs = t.runs
            .filter((r) => !!r && typeof r.at === 'string' && typeof r.status === 'string' && r.status.length <= 40)
            .slice(-MAX_RUNS)
            .map((r) => ({ at: r.at.slice(0, 30), status: r.status }));
        out.tests[key(t.file, t.title)] = { file: t.file, title: t.title, runs };
    }
    return out;
}
/** Adds this run's results; drops the tests seen least recently past the cap. */
export function recordRun(history, results, at) {
    const next = { version: 1, tests: { ...history.tests } };
    for (const r of results) {
        if (r.healed || r.skipped)
            continue;
        const k = key(r.failure.file, r.failure.title);
        const t = next.tests[k] ?? { file: r.failure.file, title: r.failure.title, runs: [] };
        next.tests[k] = { ...t, runs: [...t.runs, { at, status: r.status }].slice(-MAX_RUNS) };
    }
    const entries = Object.entries(next.tests);
    if (entries.length > MAX_TESTS) {
        entries.sort((a, b) => (b[1].runs.at(-1)?.at ?? '').localeCompare(a[1].runs.at(-1)?.at ?? ''));
        next.tests = Object.fromEntries(entries.slice(0, MAX_TESTS));
    }
    return next;
}
/** How often this test failed before this run. */
export function historyOf(history, file, title) {
    const t = history?.tests[key(file, title)];
    if (!t?.runs.length)
        return null;
    return { failures: t.runs.length, flaky: t.runs.filter((r) => ['FLAKY', 'QUARANTINED'].includes(r.status)).length, since: t.runs[0]?.at.slice(0, 10) ?? '' };
}
/** The newest history: a local file, or the newest autoheal-history artifact on GitHub. */
export async function fetchHistory(ci, env) {
    try {
        if (env.AUTOHEAL_HISTORY_FILE) {
            const text = await readFile(env.AUTOHEAL_HISTORY_FILE, 'utf8').catch(() => null);
            return text ? { history: parseHistory(text), note: `from ${env.AUTOHEAL_HISTORY_FILE}` } : { history: emptyHistory(), note: 'none yet' };
        }
        if (ci.forge === 'github' && ci.ci === 'github' && ci.api && ci.repo) {
            const token = env.GITHUB_TOKEN || env.GH_TOKEN;
            if (!token)
                return { history: emptyHistory(), note: 'no token to read it' };
            const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'autoheal-ai' };
            const res = await fetch(`${ci.api}/repos/${ci.repo}/actions/artifacts?name=${HISTORY_ARTIFACT}&per_page=5`, { headers, signal: AbortSignal.timeout(30_000) });
            if (!res.ok)
                return { history: emptyHistory(), note: `could not list artifacts (HTTP ${res.status})` };
            const data = (await res.json());
            const newest = (data.artifacts ?? []).filter((a) => !a.expired).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
            if (!newest)
                return { history: emptyHistory(), note: 'none yet' };
            const zipRes = await fetch(newest.archive_download_url, { headers, signal: AbortSignal.timeout(60_000), redirect: 'follow' });
            if (!zipRes.ok)
                return { history: emptyHistory(), note: 'could not download it' };
            const zip = Buffer.from(await zipRes.arrayBuffer());
            if (zip.length > MAX_BYTES * 2)
                return { history: emptyHistory(), note: 'too large' };
            const file = [...readZip(zip, (n) => n.endsWith(HISTORY_FILE)).values()][0];
            return file ? { history: parseHistory(file.toString('utf8')), note: `from ${newest.created_at.slice(0, 10)}` } : { history: emptyHistory(), note: 'empty' };
        }
    }
    catch (error) {
        return { history: emptyHistory(), note: `not read (${error instanceof Error ? error.message : String(error)})` };
    }
    return { history: emptyHistory(), note: '' };
}
//# sourceMappingURL=history.js.map