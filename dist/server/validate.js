/**
 * Strict validation of uploaded heal events. Unknown fields are rejected, so
 * a misconfigured client cannot start sending code, diffs or error text.
 */
import { CATEGORIES, ROOT_CAUSES, STATUSES } from './store.js';
const ALLOWED = new Set([
    'id', 'repo', 'run_id', 'run_url', 'commit_sha', 'branch', 'test_title', 'file_path', 'status', 'category', 'root_cause',
    'confidence', 'fix_by', 'pr_url', 'issue_url', 'tokens', 'usd', 'minutes_saved', 'created_at',
]);
export const MAX_EVENTS = 200;
function str(value, field, max, required) {
    if (value === undefined || value === null) {
        if (required)
            throw new Error(`${field} is required`);
        return undefined;
    }
    if (typeof value !== 'string')
        throw new Error(`${field} must be a string`);
    if (value.length > max)
        throw new Error(`${field} is longer than ${max} characters`);
    if (required && value.trim() === '')
        throw new Error(`${field} is empty`);
    return value;
}
function url(value, field) {
    const s = str(value, field, 1000, false);
    if (s === undefined)
        return undefined;
    let parsed;
    try {
        parsed = new URL(s);
    }
    catch {
        throw new Error(`${field} is not a URL`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
        throw new Error(`${field} must be http(s)`);
    return parsed.toString();
}
function num(value, field, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
        throw new Error(`${field} must be a number from ${min} to ${max}`);
    return value;
}
function oneOf(value, field, options) {
    if (typeof value !== 'string' || !options.includes(value))
        throw new Error(`${field} must be one of ${options.join(', ')}`);
    return value;
}
export function validateEvent(raw, index) {
    const at = `events[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error(`${at} must be an object`);
    const o = raw;
    for (const key of Object.keys(o))
        if (!ALLOWED.has(key))
            throw new Error(`${at}.${key} is not an accepted field`);
    const id = str(o.id, `${at}.id`, 64, true);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id))
        throw new Error(`${at}.id has invalid characters`);
    const repo = str(o.repo, `${at}.repo`, 200, true);
    if (!/^[\w.-]+(\/[\w.-]+)?$/.test(repo))
        throw new Error(`${at}.repo must look like owner/name`);
    const created = str(o.created_at, `${at}.created_at`, 40, true);
    if (Number.isNaN(Date.parse(created)))
        throw new Error(`${at}.created_at is not a date`);
    const event = {
        id,
        repo,
        test_title: str(o.test_title, `${at}.test_title`, 500, true),
        file_path: str(o.file_path, `${at}.file_path`, 500, true),
        status: oneOf(o.status, `${at}.status`, STATUSES),
        category: oneOf(o.category, `${at}.category`, CATEGORIES),
        root_cause: oneOf(o.root_cause, `${at}.root_cause`, ROOT_CAUSES),
        confidence: num(o.confidence, `${at}.confidence`, 0, 1),
        tokens: Math.round(num(o.tokens, `${at}.tokens`, 0, 1e9)),
        usd: num(o.usd, `${at}.usd`, 0, 1e6),
        minutes_saved: Math.round(num(o.minutes_saved, `${at}.minutes_saved`, 0, 1e5)),
        created_at: new Date(created).toISOString(),
    };
    const runId = str(o.run_id, `${at}.run_id`, 100, false);
    const runUrl = url(o.run_url, `${at}.run_url`);
    const commit = str(o.commit_sha, `${at}.commit_sha`, 64, false);
    const branch = str(o.branch, `${at}.branch`, 255, false);
    const prUrl = url(o.pr_url, `${at}.pr_url`);
    const issueUrl = url(o.issue_url, `${at}.issue_url`);
    if (o.fix_by !== undefined && o.fix_by !== null)
        event.fix_by = oneOf(o.fix_by, `${at}.fix_by`, ['rules', 'ai']);
    if (commit !== undefined && !/^[0-9a-f]{7,64}$/i.test(commit))
        throw new Error(`${at}.commit_sha is not a commit id`);
    if (runId !== undefined)
        event.run_id = runId;
    if (runUrl !== undefined)
        event.run_url = runUrl;
    if (commit !== undefined)
        event.commit_sha = commit;
    if (branch !== undefined)
        event.branch = branch;
    if (prUrl !== undefined)
        event.pr_url = prUrl;
    if (issueUrl !== undefined)
        event.issue_url = issueUrl;
    return event;
}
export function validateBatch(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('body must be an object');
    const o = raw;
    if (o.version !== 1)
        throw new Error('version must be 1');
    if (!Array.isArray(o.events))
        throw new Error('events must be an array');
    if (o.events.length > MAX_EVENTS)
        throw new Error(`at most ${MAX_EVENTS} events per request`);
    for (const key of Object.keys(o))
        if (key !== 'version' && key !== 'events')
            throw new Error(`${key} is not an accepted field`);
    return o.events.map(validateEvent);
}
//# sourceMappingURL=validate.js.map