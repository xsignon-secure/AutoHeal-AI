/**
 * Scrubs secrets from text before it leaves the runner: the AI prompt, PR
 * and issue bodies, comments, the job summary and summary.json. A failing
 * test can print a token in an error, a console log or the page itself;
 * none of that should land in a PR that the whole org (or the world) reads.
 *
 * Two layers: well-known credential shapes, and the literal values of every
 * secret-looking environment variable on the runner (GitHub masks its own
 * secrets in logs, but not in files AutoHeal writes).
 */
export const REDACTED = '[REDACTED]';
const PATTERNS = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
    /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
    /\bglpat-[A-Za-z0-9_-]{20,}/g,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
    /\bAIza[0-9A-Za-z_-]{35}\b/g,
    /\b[rsp]k_(?:live|test)_[0-9A-Za-z]{16,}/g,
    /\bnpm_[A-Za-z0-9]{36}\b/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
/** Things with a name in front: Bearer xyz, password=xyz, "apiKey": "xyz", https://user:pass@host. */
const LABELLED = [
    [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/-]{12,}=*/g, `$1 ${REDACTED}`],
    [/(\b(?:password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|api[_-]?key|apikey|auth|authorization|cookie|session(?:id)?)["']?\s*[:=]\s*["']?)[^\s"'&,;}]{6,}/gi, `$1${REDACTED}`],
    [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]{3,}@/gi, `$1${REDACTED}@`],
];
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE|AUTH|COOKIE|SESSION|DSN|DATABASE_URL|CONNECTION_STRING/i;
function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** Literal secret values from the environment (8+ characters, longest first). */
export function secretValues(env = process.env) {
    const values = new Set();
    for (const [name, value] of Object.entries(env)) {
        if (!value || value.length < 8 || !SECRET_NAME.test(name))
            continue;
        // PWD/OLDPWD are the shell's working folder, not a password.
        if (/^(OLD)?PWD$/i.test(name))
            continue;
        if (/^(true|false|\d+)$/i.test(value))
            continue;
        values.add(value);
    }
    return [...values].sort((a, b) => b.length - a.length);
}
export function makeRedactor(env = process.env) {
    const literals = secretValues(env).map((v) => new RegExp(escapeRegex(v), 'g'));
    return (text) => {
        if (!text)
            return text;
        let out = text;
        for (const re of literals)
            out = out.replace(re, REDACTED);
        for (const re of PATTERNS)
            out = out.replace(re, REDACTED);
        for (const [re, to] of LABELLED)
            out = out.replace(re, to);
        return out;
    };
}
let defaultRedactor = null;
/** Redacts with the current process environment. */
export function redact(text) {
    defaultRedactor ??= makeRedactor();
    return defaultRedactor(text);
}
/** Redacts every string inside a JSON-like value. */
export function redactDeep(value, fn = redact) {
    if (typeof value === 'string')
        return fn(value);
    if (Array.isArray(value))
        return value.map((v) => redactDeep(v, fn));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, fn)]));
    }
    return value;
}
//# sourceMappingURL=redact.js.map