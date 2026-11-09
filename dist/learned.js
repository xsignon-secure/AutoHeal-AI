/**
 * Fingerprints learned from green runs (`autoheal learn`), kept outside the
 * repository: as the newest `autoheal-fingerprints` artifact on GitHub, the
 * newest `autoheal-learn` job's artifacts on GitLab, or a CircleCI cache. The
 * heal job reads them before it starts, so a locator that breaks for the first
 * time can already be fixed without AI tokens.
 *
 * They are hints, never trusted on their own: a fix found from one still has
 * to pass the anti-cheat guard and the stability reruns like any other.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readZip } from './vision.js';
export const LEARNED_DIR = '.autoheal-learned';
export const LEARNED_ARTIFACT = 'autoheal-fingerprints';
export const LEARN_JOB = 'autoheal-learn';
const MAX_ZIP = 20 * 1024 * 1024;
const MAX_ENTRY = 16 * 1024;
const MAX_FILES = 5000;
const NAME = /^[0-9a-f]{16}\.json$/;
function validEntry(e) {
    const x = e;
    return (!!x &&
        typeof x === 'object' &&
        typeof x.selector === 'string' &&
        x.selector.length <= 1000 &&
        typeof x.at === 'string' &&
        !!x.fingerprint &&
        typeof x.fingerprint === 'object' &&
        typeof x.fingerprint.tag === 'string' &&
        Object.values(x.fingerprint).every((v) => typeof v === 'string' && v.length <= 200));
}
/** Fingerprints in a folder of <id>.json files (the learned folder). */
export async function loadLearned(dir) {
    const out = [];
    let names = [];
    try {
        names = (await readdir(dir)).filter((n) => NAME.test(n)).slice(0, MAX_FILES);
    }
    catch {
        return out;
    }
    for (const name of names) {
        try {
            const text = await readFile(path.join(dir, name), 'utf8');
            if (text.length > MAX_ENTRY)
                continue;
            const e = JSON.parse(text);
            if (validEntry(e))
                out.push(e);
        }
        catch {
            // skip a broken file
        }
    }
    return out;
}
/** Writes the <id>.json entries of a downloaded zip into `dir`. Returns how many. */
export async function unpackLearned(zip, dir) {
    if (zip.length > MAX_ZIP)
        return 0;
    const entries = readZip(zip, (n) => NAME.test(path.posix.basename(n)));
    await mkdir(dir, { recursive: true });
    let n = 0;
    for (const [name, buf] of entries) {
        if (n >= MAX_FILES || buf.length > MAX_ENTRY)
            continue;
        try {
            const e = JSON.parse(buf.toString('utf8'));
            if (!validEntry(e))
                continue;
            await writeFile(path.join(dir, path.posix.basename(name)), `${JSON.stringify(e, null, 2)}\n`);
            n++;
        }
        catch {
            // skip
        }
    }
    return n;
}
async function getBuffer(url, headers) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000), redirect: 'follow' });
    if (!res.ok)
        return null;
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_ZIP)
        return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > MAX_ZIP ? null : buf;
}
/**
 * Downloads the newest learned fingerprints into `dir`. Never fails the heal:
 * returns a short note of what happened instead.
 */
export async function fetchLearned(ci, env, dir) {
    try {
        if (ci.forge === 'github' && ci.ci === 'github' && ci.api && ci.repo) {
            const token = env.GITHUB_TOKEN || env.GH_TOKEN;
            if (!token)
                return 'no token to read them';
            const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'autoheal-ai' };
            const res = await fetch(`${ci.api}/repos/${ci.repo}/actions/artifacts?name=${LEARNED_ARTIFACT}&per_page=5`, { headers, signal: AbortSignal.timeout(30_000) });
            if (!res.ok)
                return `could not list artifacts (HTTP ${res.status}; the heal job needs actions: read)`;
            const data = (await res.json());
            const newest = (data.artifacts ?? []).filter((a) => !a.expired).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
            if (!newest)
                return 'none yet (the daily learn job saves them)';
            const zip = await getBuffer(newest.archive_download_url, headers);
            if (!zip)
                return 'could not download them';
            return `${await unpackLearned(zip, dir)} from ${newest.created_at.slice(0, 10)}`;
        }
        if (ci.ci === 'gitlab' && ci.api && (ci.projectId || ci.repo) && env.CI_JOB_TOKEN) {
            const ref = ci.defaultBranch ?? 'main';
            const project = ci.projectId ?? encodeURIComponent(ci.repo ?? '');
            const zip = await getBuffer(`${ci.api}/projects/${project}/jobs/artifacts/${encodeURIComponent(ref)}/download?job=${LEARN_JOB}`, { 'job-token': env.CI_JOB_TOKEN });
            if (!zip)
                return 'none yet (schedule a daily pipeline for the autoheal-learn job)';
            return `${await unpackLearned(zip, dir)} from the latest ${LEARN_JOB} job`;
        }
    }
    catch (error) {
        return `not read (${error instanceof Error ? error.message : String(error)})`;
    }
    return '';
}
//# sourceMappingURL=learned.js.map