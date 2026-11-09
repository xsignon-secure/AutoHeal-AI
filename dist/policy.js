/**
 * The policy file: `.autoheal.yml` at the root of the repository.
 *
 * It lets a team say, in the repo, what AutoHeal may do: which folders it
 * must never change, which tests it leaves alone, which kinds of fixes it may
 * propose, and tighter limits. It is read from the commit being healed,
 * before any test runs, by both the heal job and the publish job.
 *
 * A policy can only make AutoHeal stricter than the workflow: limits take the
 * lower (or, for repeat-each and min-confidence, the higher) of the two, and
 * a switch the workflow turned off stays off. A broken policy file stops the
 * job instead of being ignored, so a typo never silently loosens anything.
 *
 * The parser reads a small, safe part of YAML: maps, lists of plain values,
 * inline lists, quoted strings, numbers, booleans and comments. No anchors,
 * tags, multi-line strings or documents.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
export const POLICY_FILE = '.autoheal.yml';
const MAX_BYTES = 20_000;
export const FIX_SOURCES = ['rules', 'fingerprint', 'same-change', 'ai', 'baseline'];
const STRENGTHS = ['strong', 'good', 'fair', 'weak'];
export class PolicyError extends Error {
}
export function defaultPolicy() {
    return { protect: [], skip: { files: [], titles: [] }, fixes: { allow: [...FIX_SOURCES] }, quarantine: { enabled: true }, issues: { enabled: true }, limits: {} };
}
function stripComment(line) {
    let quote = '';
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            if (c === quote)
                quote = '';
        }
        else if (c === '"' || c === "'")
            quote = c;
        else if (c === '#' && (i === 0 || /\s/.test(line[i - 1])))
            return line.slice(0, i);
    }
    return line;
}
function scalar(raw, where) {
    const s = raw.trim();
    if (s === '')
        throw new PolicyError(`${where}: missing value`);
    if (/^[&*!|>%@`]/.test(s))
        throw new PolicyError(`${where}: "${s.slice(0, 20)}" is not supported here (use plain values)`);
    if (s.startsWith('[')) {
        if (!s.endsWith(']'))
            throw new PolicyError(`${where}: unclosed [ list`);
        const body = s.slice(1, -1).trim();
        if (!body)
            return [];
        const items = [];
        let cur = '';
        let quote = '';
        for (const c of body) {
            if (quote) {
                cur += c;
                if (c === quote)
                    quote = '';
            }
            else if (c === '"' || c === "'") {
                quote = c;
                cur += c;
            }
            else if (c === ',') {
                items.push(cur);
                cur = '';
            }
            else if (c === '[' || c === '{')
                throw new PolicyError(`${where}: nested lists and maps are not supported`);
            else
                cur += c;
        }
        items.push(cur);
        return items.map((x) => scalar(x, where));
    }
    if (s.startsWith('{'))
        throw new PolicyError(`${where}: inline maps are not supported; use indented keys`);
    const q = /^(["'])(.*)\1$/.exec(s);
    if (q) {
        const body = q[2];
        if (q[1] === "'")
            return body.replace(/''/g, "'");
        try {
            return JSON.parse(`"${body}"`);
        }
        catch {
            throw new PolicyError(`${where}: bad quoted string`);
        }
    }
    if (/^(?:true|yes|on)$/i.test(s))
        return true;
    if (/^(?:false|no|off)$/i.test(s))
        return false;
    if (/^-?\d+(?:\.\d+)?$/.test(s))
        return Number(s);
    return s;
}
/** Parses the YAML subset described above. */
export function parsePolicyYaml(text) {
    if (text.length > MAX_BYTES)
        throw new PolicyError(`${POLICY_FILE} is larger than ${MAX_BYTES} bytes`);
    const lines = [];
    text.split(/\r?\n/).forEach((raw, i) => {
        if (raw.includes('\t'))
            throw new PolicyError(`line ${i + 1}: use spaces, not tabs`);
        const t = stripComment(raw).trimEnd();
        if (!t.trim())
            return;
        if (/^(?:---|\.\.\.)\s*$/.test(t)) {
            if (lines.length)
                throw new PolicyError(`line ${i + 1}: only one document is supported`);
            return;
        }
        lines.push({ indent: t.length - t.trimStart().length, text: t.trim(), n: i + 1 });
    });
    let pos = 0;
    const block = (indent, depth) => {
        if (depth > 4)
            throw new PolicyError(`line ${lines[pos]?.n}: nested too deeply`);
        const first = lines[pos];
        if (!first || first.indent !== indent)
            throw new PolicyError(`line ${first?.n ?? '?'}: unexpected indentation`);
        if (first.text.startsWith('- ') || first.text === '-') {
            const list = [];
            while (pos < lines.length && lines[pos].indent === indent) {
                const l = lines[pos];
                if (!(l.text.startsWith('- ') || l.text === '-'))
                    throw new PolicyError(`line ${l.n}: expected a "- " list item`);
                const item = l.text.slice(1).trim();
                if (/^[\w-]+:(?:\s|$)/.test(item))
                    throw new PolicyError(`line ${l.n}: lists of maps are not supported`);
                list.push(scalar(item, `line ${l.n}`));
                pos++;
                if (list.length > 200)
                    throw new PolicyError(`line ${l.n}: list longer than 200 items`);
            }
            return list;
        }
        const map = {};
        while (pos < lines.length && lines[pos].indent === indent) {
            const l = lines[pos];
            const m = /^([A-Za-z][\w-]{0,40}):(?:\s+(.*))?$/.exec(l.text);
            if (!m)
                throw new PolicyError(`line ${l.n}: expected "key: value"`);
            const key = m[1];
            if (Object.prototype.hasOwnProperty.call(map, key))
                throw new PolicyError(`line ${l.n}: "${key}" appears twice`);
            pos++;
            if (m[2] !== undefined && m[2].trim() !== '')
                map[key] = scalar(m[2], `line ${l.n}`);
            else {
                const next = lines[pos];
                if (!next || next.indent <= indent)
                    throw new PolicyError(`line ${l.n}: "${key}" has no value`);
                map[key] = block(next.indent, depth + 1);
            }
        }
        return map;
    };
    if (!lines.length)
        return {};
    const root = block(lines[0]?.indent ?? 0, 0);
    if (pos < lines.length)
        throw new PolicyError(`line ${lines[pos]?.n}: unexpected indentation`);
    if (Array.isArray(root) || typeof root !== 'object')
        throw new PolicyError(`${POLICY_FILE} must be a map of settings`);
    return root;
}
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
function only(o, keys, where) {
    for (const k of Object.keys(o))
        if (!keys.includes(k))
            throw new PolicyError(`${where}: unknown setting "${k}" (known: ${keys.join(', ')})`);
}
function section(o, key, keys) {
    const v = o[key];
    if (v === undefined)
        return {};
    if (!isObj(v))
        throw new PolicyError(`${key} must be a map`);
    only(v, keys, key);
    return v;
}
function strings(v, where, max = 300) {
    if (v === undefined)
        return [];
    const list = Array.isArray(v) ? v : [v];
    return list.map((x) => {
        if (typeof x !== 'string' || !x.trim() || x.length > max)
            throw new PolicyError(`${where}: each entry must be text up to ${max} characters`);
        return x.trim();
    });
}
function num(v, where, min, max, int = false) {
    if (v === undefined)
        return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v)))
        throw new PolicyError(`${where} must be a${int ? ' whole' : ''} number from ${min} to ${max}`);
    return v;
}
function bool(v, where, fallback) {
    if (v === undefined)
        return fallback;
    if (typeof v !== 'boolean')
        throw new PolicyError(`${where} must be true or false`);
    return v;
}
function glob(g, where) {
    const s = g.replace(/^\.\//, '');
    if (s.startsWith('/') || s.split('/').includes('..'))
        throw new PolicyError(`${where}: "${g}" must be a path inside the repository`);
    return s;
}
/** Checks a parsed policy and fills in defaults. Unknown settings are errors. */
export function readPolicy(raw) {
    const o = raw;
    only(o, ['version', 'protect', 'skip', 'fixes', 'quarantine', 'limits', 'issues'], POLICY_FILE);
    if (o.version !== undefined && o.version !== 1)
        throw new PolicyError('version must be 1');
    const p = defaultPolicy();
    p.protect = strings(o.protect, 'protect').map((g) => glob(g, 'protect'));
    const skip = section(o, 'skip', ['files', 'titles']);
    p.skip = { files: strings(skip.files, 'skip.files').map((g) => glob(g, 'skip.files')), titles: strings(skip.titles, 'skip.titles', 200) };
    const fixes = section(o, 'fixes', ['allow', 'min-strength', 'max-per-pr']);
    if (fixes.allow !== undefined) {
        const allow = strings(fixes.allow, 'fixes.allow');
        for (const a of allow)
            if (!FIX_SOURCES.includes(a))
                throw new PolicyError(`fixes.allow: "${a}" is not one of ${FIX_SOURCES.join(', ')}`);
        p.fixes.allow = FIX_SOURCES.filter((s) => allow.includes(s));
    }
    if (fixes['min-strength'] !== undefined) {
        const s = fixes['min-strength'];
        if (typeof s !== 'string' || !STRENGTHS.includes(s))
            throw new PolicyError(`fixes.min-strength must be one of ${STRENGTHS.join(', ')}`);
        p.fixes.minStrength = s;
    }
    const maxPerPr = num(fixes['max-per-pr'], 'fixes.max-per-pr', 1, 100, true);
    if (maxPerPr !== undefined)
        p.fixes.maxPerPr = maxPerPr;
    const q = section(o, 'quarantine', ['enabled', 'max-days']);
    p.quarantine.enabled = bool(q.enabled, 'quarantine.enabled', true);
    const maxDays = num(q['max-days'], 'quarantine.max-days', 1, 90, true);
    if (maxDays !== undefined)
        p.quarantine.maxDays = maxDays;
    const lim = section(o, 'limits', ['max-usd', 'max-failures', 'repeat-each']);
    const maxUsd = num(lim['max-usd'], 'limits.max-usd', 0, 1000);
    const maxFailures = num(lim['max-failures'], 'limits.max-failures', 1, 50, true);
    const repeatEach = num(lim['repeat-each'], 'limits.repeat-each', 2, 50, true);
    if (maxUsd !== undefined)
        p.limits.maxUsd = maxUsd;
    if (maxFailures !== undefined)
        p.limits.maxFailures = maxFailures;
    if (repeatEach !== undefined)
        p.limits.repeatEach = repeatEach;
    const iss = section(o, 'issues', ['enabled', 'min-confidence']);
    p.issues.enabled = bool(iss.enabled, 'issues.enabled', true);
    const minConfidence = num(iss['min-confidence'], 'issues.min-confidence', 0, 1);
    if (minConfidence !== undefined)
        p.issues.minConfidence = minConfidence;
    return p;
}
/**
 * Loads `.autoheal.yml` from the repository root. Null when there is none.
 * Throws PolicyError when it exists but is not valid.
 */
export function loadPolicy(repoRoot) {
    const file = path.join(repoRoot, POLICY_FILE);
    // One open with O_NOFOLLOW, then checks on that same descriptor: no gap
    // between checking the file and reading it, and never through a symlink.
    let fd;
    try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    }
    catch (err) {
        const code = err.code;
        if (code === 'ENOENT')
            return null;
        if (code === 'ELOOP' || code === 'EMLINK')
            throw new PolicyError(`${POLICY_FILE} must be a regular file (not a symlink or folder)`);
        throw err;
    }
    try {
        const st = fstatSync(fd);
        if (!st.isFile())
            throw new PolicyError(`${POLICY_FILE} must be a regular file (not a symlink or folder)`);
        if (st.size > MAX_BYTES)
            throw new PolicyError(`${POLICY_FILE} is larger than ${MAX_BYTES} bytes`);
        const buf = Buffer.alloc(MAX_BYTES + 1);
        let n = 0;
        for (let r; n < buf.length && (r = readSync(fd, buf, n, buf.length - n, null)) > 0;)
            n += r;
        if (n > MAX_BYTES)
            throw new PolicyError(`${POLICY_FILE} is larger than ${MAX_BYTES} bytes`);
        return readPolicy(parsePolicyYaml(buf.subarray(0, n).toString('utf8')));
    }
    catch (err) {
        if (err instanceof PolicyError)
            throw new PolicyError(err.message.startsWith(POLICY_FILE) ? err.message : `${POLICY_FILE}: ${err.message}`);
        throw err;
    }
    finally {
        closeSync(fd);
    }
}
// ---------------------------------------------------------------- matching
/** A path glob (`**`, `*`, `?`) as a matcher, without building a regex from the text. */
export function globMatcher(pattern) {
    const g = pattern.trim().replace(/^\.\//, '');
    const match = (pi, si, s) => {
        for (;;) {
            if (pi === g.length)
                return si === s.length;
            if (g.startsWith('**/', pi)) {
                for (let k = si; k <= s.length; k++)
                    if ((k === si || s[k - 1] === '/') && match(pi + 3, k, s))
                        return true;
                return false;
            }
            if (g.startsWith('**', pi))
                return true;
            const c = g[pi];
            if (c === '*') {
                for (let k = si; k <= s.length; k++) {
                    if (match(pi + 1, k, s))
                        return true;
                    if (s[k] === '/')
                        return false;
                }
                return false;
            }
            if (si >= s.length || (c === '?' ? s[si] === '/' : s[si] !== c))
                return false;
            pi++;
            si++;
        }
    };
    return (file) => g.length > 0 && g.length <= 300 && file.length <= 400 && match(0, 0, file.replace(/\\/g, '/').replace(/^\.\//, ''));
}
/** A glob for a folder ("tests/payments/") also covers everything inside it. */
const expand = (g) => (g.endsWith('/') ? `${g}**` : g);
export function isProtected(policy, repoPath) {
    if (!policy)
        return false;
    return policy.protect.some((g) => globMatcher(expand(g))(repoPath));
}
/** The skip rule that matches this test, if any. */
export function skipRule(policy, repoPath, title) {
    if (!policy)
        return undefined;
    const file = policy.skip.files.find((g) => globMatcher(expand(g))(repoPath));
    if (file)
        return `skip.files "${file}"`;
    const t = title.toLowerCase();
    const byTitle = policy.skip.titles.find((x) => t.includes(x.toLowerCase()));
    return byTitle ? `skip.titles "${byTitle}"` : undefined;
}
const RANK = { strong: 0, good: 1, fair: 2, weak: 3 };
/** True when a locator of this strength is below the policy's minimum. */
export function tooWeak(policy, strength) {
    return !!policy?.fixes.minStrength && RANK[strength] > RANK[policy.fixes.minStrength];
}
/** The workflow's limits, made stricter by the policy (never looser). */
export function tighten(workflow, policy) {
    const out = { ...workflow, changed: [] };
    if (!policy)
        return out;
    const lower = (key, v, name) => {
        if (v !== undefined && v < out[key]) {
            out[key] = v;
            out.changed.push(`${name} ${v}`);
        }
    };
    lower('maxFailures', policy.limits.maxFailures, 'max-failures');
    lower('quarantineDays', policy.quarantine.maxDays, 'quarantine max-days');
    lower('maxUsd', policy.limits.maxUsd, 'max-usd');
    if (policy.limits.repeatEach !== undefined && policy.limits.repeatEach > out.repeatEach) {
        out.repeatEach = policy.limits.repeatEach;
        out.changed.push(`repeat-each ${policy.limits.repeatEach}`);
    }
    return out;
}
/** One line for the PR saying what the policy changed. */
export function policyText(policy, changed = []) {
    const parts = [];
    if (policy.protect.length)
        parts.push(`${policy.protect.length} protected path${policy.protect.length > 1 ? 's' : ''}`);
    const skips = policy.skip.files.length + policy.skip.titles.length;
    if (skips)
        parts.push(`${skips} skip rule${skips > 1 ? 's' : ''}`);
    if (policy.fixes.allow.length < FIX_SOURCES.length)
        parts.push(`fixes allowed: ${policy.fixes.allow.join(', ') || 'none'}`);
    if (policy.fixes.minStrength)
        parts.push(`locators at least ${policy.fixes.minStrength}`);
    if (policy.fixes.maxPerPr)
        parts.push(`at most ${policy.fixes.maxPerPr} fixes per PR`);
    if (!policy.quarantine.enabled)
        parts.push('no quarantine');
    if (!policy.issues.enabled)
        parts.push('no issues');
    parts.push(...changed);
    return `Policy (${POLICY_FILE}): ${parts.length ? parts.join('; ') : 'defaults'}.`;
}
//# sourceMappingURL=policy.js.map