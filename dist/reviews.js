/**
 * Learn from reviews: what happened to earlier AutoHeal PRs in this repo.
 *
 * Each AutoHeal PR body carries a hidden list of its fixes. The heal job
 * reads the last closed AutoHeal PRs (read-only token, pull-requests: read)
 * and sorts each fix into:
 *   merged  kept as AutoHeal wrote it
 *   edited  merged after someone pushed changes on top (their edit is read)
 *   closed  closed without merging: the fix was not wanted
 * The AI sees this as repo memory, and a deterministic fix that reviewers
 * already closed once is not proposed again.
 */
const MARKER = /<!-- autoheal-fixes:([A-Za-z0-9+/=]{1,40000}) -->/;
const MAX_PRS = 20;
const clip = (s, n) => (typeof s === 'string' && s ? s.slice(0, n) : undefined);
/** The hidden marker for a PR body. */
export function fixesMarker(fixes) {
    const clean = fixes.slice(0, 30).map((f) => {
        const out = { file: f.file.slice(0, 300), test: f.test.slice(0, 300), by: f.by.slice(0, 20) };
        const before = clip(f.before, 300);
        const after = clip(f.after, 300);
        if (before)
            out.before = before;
        if (after)
            out.after = after;
        return out;
    });
    return `<!-- autoheal-fixes:${Buffer.from(JSON.stringify(clean)).toString('base64')} -->`;
}
export function readMarker(body) {
    const m = MARKER.exec(body ?? '');
    if (!m)
        return [];
    try {
        const list = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
        if (!Array.isArray(list))
            return [];
        const out = [];
        for (const x of list.slice(0, 30)) {
            const file = clip(x?.file, 300);
            const test = clip(x?.test, 300);
            const by = clip(x?.by, 20);
            if (!file || !test || !by)
                continue;
            const f = { file, test, by };
            const before = clip(x.before, 300);
            const after = clip(x.after, 300);
            if (before)
                f.before = before;
            if (after)
                f.after = after;
            out.push(f);
        }
        return out;
    }
    catch {
        return [];
    }
}
/** Reads the last closed AutoHeal PRs. Throws on an API error (the caller reports it). */
export async function reviewHistory(options) {
    if (!/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(options.repo) || options.repo.includes('..'))
        throw new Error(`bad repository name ${options.repo}`);
    let api = (options.apiUrl ?? 'https://api.github.com').slice(0, 500);
    while (api.endsWith('/'))
        api = api.slice(0, -1);
    if (!/^https?:\/\//.test(api))
        throw new Error('bad API URL');
    const fetchFn = options.fetchFn ?? fetch;
    const get = async (path) => {
        const res = await fetchFn(`${api}/repos/${options.repo}${path}`, {
            headers: { authorization: `Bearer ${options.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'autoheal-ai' },
            signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok)
            throw new Error(`GitHub API ${res.status} for ${path.split('?')[0]}`);
        return res.json();
    };
    const pulls = (await get('/pulls?state=closed&sort=updated&direction=desc&per_page=50'));
    const ours = (Array.isArray(pulls) ? pulls : [])
        .filter((p) => typeof p?.head?.ref === 'string' && p.head.ref.startsWith('autoheal/') && p.head?.repo?.full_name === options.repo && p.base?.repo?.full_name === options.repo)
        .slice(0, options.max ?? MAX_PRS);
    const history = { fixes: [], prs: { merged: 0, edited: 0, closed: 0 } };
    for (const p of ours) {
        const marked = readMarker(p.body);
        if (!marked.length || typeof p.number !== 'number')
            continue;
        let outcome = p.merged_at ? 'merged' : 'closed';
        const edits = new Map();
        if (outcome === 'merged') {
            const commits = (await get(`/pulls/${p.number}/commits?per_page=50`));
            const list = Array.isArray(commits) ? commits : [];
            const first = list.findIndex((c) => String(c?.commit?.message ?? '').startsWith('test: AutoHeal fixes'));
            const human = first >= 0 ? list.slice(first + 1).filter((c) => !String(c?.commit?.message ?? '').startsWith('test: AutoHeal fixes')) : [];
            if (first >= 0 && human.length) {
                outcome = 'edited';
                const from = String(list[first]?.sha ?? '');
                const to = String(list[list.length - 1]?.sha ?? '');
                if (/^[0-9a-f]{40}$/.test(from) && /^[0-9a-f]{40}$/.test(to)) {
                    const cmp = (await get(`/compare/${from}...${to}`));
                    for (const f of cmp.files ?? [])
                        if (f.filename && f.patch && marked.some((m) => m.file === f.filename))
                            edits.set(f.filename, f.patch.slice(0, 600));
                }
            }
        }
        history.prs[outcome]++;
        const at = String(p.closed_at ?? p.merged_at ?? '').slice(0, 10);
        for (const m of marked) {
            const fix = { ...m, pr: p.number, outcome, at };
            const edit = edits.get(m.file);
            if (edit)
                fix.edit = edit;
            history.fixes.push(fix);
        }
    }
    return history;
}
/** Lines for the AI's repo memory. */
export function reviewText(history, file, limit = 10) {
    const same = history.fixes.filter((f) => f.file === file);
    const other = history.fixes.filter((f) => f.file !== file && f.outcome !== 'merged');
    const pick = [...same, ...other].slice(0, limit);
    if (!pick.length)
        return '';
    return [
        'Reviews of earlier AutoHeal PRs (what people kept, changed or rejected):',
        ...pick.map((f) => {
            const change = f.before && f.after ? ` (${f.before} → ${f.after})` : '';
            if (f.outcome === 'closed')
                return `- PR #${f.pr} was closed without merging: ${f.file} › ${f.test}${change}. Do not propose that change again.`;
            if (f.outcome === 'edited')
                return `- PR #${f.pr} was merged after a reviewer edited it: ${f.file} › ${f.test}${change}.${f.edit ? ` Their edit:\n${f.edit}` : ''}`;
            return `- PR #${f.pr} was merged as written: ${f.file} › ${f.test}${change}.`;
        }),
    ].join('\n');
}
/** A deterministic change reviewers already closed once. */
export function rejected(history, file, before, after) {
    if (!history || before === undefined || after === undefined)
        return undefined;
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    return history.fixes.find((f) => f.outcome === 'closed' && f.file === file && f.before !== undefined && f.after !== undefined && norm(f.before) === norm(before) && norm(f.after) === norm(after));
}
//# sourceMappingURL=reviews.js.map