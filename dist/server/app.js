/**
 * Self-hosted AutoHeal dashboard (optional, Phase 3).
 *
 *   POST /api/heal     signed upload from the AutoHeal action (HMAC-SHA256)
 *   GET  /api/stats    totals (?repo=owner/name)
 *   GET  /api/events   recent results (?repo=&status=&limit=)
 *   GET  /             the dashboard page
 *   GET  /healthz      liveness
 *
 * AUTOHEAL_DASHBOARD_SECRET (32+ chars) signs uploads. When
 * AUTOHEAL_DASHBOARD_VIEW_TOKEN is set, reading needs it once as ?token=
 * (an HttpOnly cookie then holds an HMAC of it, not the token) or as a Bearer token. AUTOHEAL_DASHBOARD_REPOS
 * (comma separated owner/name) limits which repos may upload.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { MIN_SECRET_LENGTH, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from '../signing.js';
import { renderPage } from './page.js';
import { validateBatch } from './validate.js';
export const MAX_BODY_BYTES = 256 * 1024;
/** Failed sign-ins or bad signatures allowed per client address per window. */
export const MAX_FAILURES = 20;
const MAX_TRACKED = 10_000;
const FAILURE_WINDOW_MS = 10 * 60_000;
const SECURITY_HEADERS = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...SECURITY_HEADERS, ...extra });
    res.end(body);
}
function json(res, status, value) {
    send(res, status, JSON.stringify(value));
}
function sameSecret(a, b) {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}
/** The cookie holds a value derived from the view token, never the token itself. */
export function viewCookieValue(viewToken) {
    return createHmac('sha256', viewToken).update('autoheal-view-cookie-v1').digest('base64url');
}
function cookie(req, name) {
    for (const part of (req.headers.cookie ?? '').split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === name)
            return decodeURIComponent(v.join('='));
    }
    return undefined;
}
async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buf = chunk;
        size += buf.length;
        if (size > MAX_BODY_BYTES)
            throw Object.assign(new Error('body too large'), { status: 413 });
        chunks.push(buf);
    }
    return Buffer.concat(chunks).toString('utf8');
}
export function createDashboard(options) {
    if (options.secret.length < MIN_SECRET_LENGTH)
        throw new Error(`AUTOHEAL_DASHBOARD_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
    const allowedRepos = options.repos?.length ? new Set(options.repos.map((r) => r.toLowerCase())) : null;
    const failures = new Map();
    function clientOf(req) {
        if (options.trustProxy) {
            // The LAST entry is the one your proxy added; earlier ones are whatever
            // the client sent, so they cannot be used to dodge the lockout.
            const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean).pop();
            if (forwarded)
                return forwarded;
        }
        return req.socket.remoteAddress ?? 'unknown';
    }
    function lockedOut(client) {
        const f = failures.get(client);
        if (!f)
            return false;
        if (Date.now() - f.since > FAILURE_WINDOW_MS) {
            failures.delete(client);
            return false;
        }
        return f.count >= MAX_FAILURES;
    }
    function recordFailure(client) {
        const f = failures.get(client);
        if (!f || Date.now() - f.since > FAILURE_WINDOW_MS)
            failures.set(client, { count: 1, since: Date.now() });
        else
            f.count++;
        if (failures.size > MAX_TRACKED)
            evictFailures();
    }
    /** Bounds memory under a flood without lifting any active lockout. */
    function evictFailures() {
        const now = Date.now();
        for (const [k, v] of failures)
            if (now - v.since > FAILURE_WINDOW_MS)
                failures.delete(k);
        // Then the oldest clients that are not locked out (Map keeps insertion order).
        for (const [k, v] of failures) {
            if (failures.size <= MAX_TRACKED * 0.9)
                break;
            if (v.count < MAX_FAILURES)
                failures.delete(k);
        }
    }
    function canView(req, url) {
        if (!options.viewToken)
            return 'yes';
        const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
        if (bearer && sameSecret(bearer, options.viewToken))
            return 'yes';
        const fromCookie = cookie(req, 'autoheal_view');
        if (fromCookie && sameSecret(fromCookie, viewCookieValue(options.viewToken)))
            return 'yes';
        const fromQuery = url.searchParams.get('token');
        if (fromQuery && sameSecret(fromQuery, options.viewToken))
            return 'set-cookie';
        return 'no';
    }
    return (req, res) => {
        void (async () => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            try {
                if (url.pathname === '/healthz')
                    return json(res, 200, { ok: true });
                const client = clientOf(req);
                if (lockedOut(client))
                    return json(res, 429, { ok: false, error: 'too many failed attempts; try again later' });
                if (url.pathname === '/api/heal') {
                    if (req.method !== 'POST')
                        return json(res, 405, { ok: false, error: 'POST only' });
                    const body = await readBody(req);
                    const failure = verifySignature(options.secret, body, req.headers[SIGNATURE_HEADER], req.headers[TIMESTAMP_HEADER]);
                    if (failure) {
                        recordFailure(client);
                        return json(res, 401, { ok: false, error: `signature ${failure}` });
                    }
                    let events;
                    try {
                        events = validateBatch(JSON.parse(body));
                    }
                    catch (error) {
                        return json(res, 400, { ok: false, error: error instanceof Error ? error.message : 'invalid body' });
                    }
                    if (allowedRepos) {
                        const denied = events.find((e) => !allowedRepos.has(e.repo.toLowerCase()));
                        if (denied)
                            return json(res, 403, { ok: false, error: `repo ${denied.repo} may not upload here` });
                    }
                    const saved = options.store.upsert(events);
                    return json(res, 200, { ok: true, saved });
                }
                if (req.method !== 'GET' && req.method !== 'HEAD')
                    return json(res, 405, { ok: false, error: 'GET only' });
                const view = canView(req, url);
                if (view === 'no') {
                    recordFailure(client);
                    return url.pathname.startsWith('/api/')
                        ? json(res, 401, { ok: false, error: 'view token required' })
                        : send(res, 401, '<!doctype html><title>AutoHeal</title><p>Open this page with ?token=YOUR_VIEW_TOKEN once.</p>', 'text/html; charset=utf-8');
                }
                if (view === 'set-cookie') {
                    url.searchParams.delete('token');
                    const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '');
                    const secure = forwardedProto === 'https' ? '; Secure' : '';
                    res.writeHead(303, {
                        location: `${url.pathname}${url.search}`,
                        'set-cookie': `autoheal_view=${viewCookieValue(options.viewToken ?? '')}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}`,
                        ...SECURITY_HEADERS,
                    });
                    return res.end();
                }
                const repo = url.searchParams.get('repo') || undefined;
                if (url.pathname === '/api/stats')
                    return json(res, 200, { ok: true, stats: options.store.stats(repo) });
                if (url.pathname === '/api/events') {
                    const status = url.searchParams.get('status') || undefined;
                    const limit = Number(url.searchParams.get('limit') ?? '100');
                    return json(res, 200, { ok: true, events: options.store.events({ ...(repo ? { repo } : {}), ...(status ? { status } : {}), limit: Number.isFinite(limit) ? limit : 100 }) });
                }
                if (url.pathname === '/') {
                    return send(res, 200, renderPage(options.store.stats(repo), options.store.events({ ...(repo ? { repo } : {}), limit: 200 }), options.store.repos(), repo), 'text/html; charset=utf-8');
                }
                return json(res, 404, { ok: false, error: 'not found' });
            }
            catch (error) {
                const status = error.status ?? 500;
                return json(res, status, { ok: false, error: status === 500 ? 'internal error' : error.message });
            }
        })();
    };
}
export async function startDashboard(options) {
    const server = http.createServer(createDashboard(options));
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, () => resolve(server));
    });
}
//# sourceMappingURL=app.js.map