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
import http from 'node:http';
import { Store } from './store.js';
export declare const MAX_BODY_BYTES: number;
/** Failed sign-ins or bad signatures allowed per client address per window. */
export declare const MAX_FAILURES = 20;
export interface DashboardOptions {
    store: Store;
    /** Use the X-Forwarded-For address (only behind your own reverse proxy). */
    trustProxy?: boolean;
    secret: string;
    viewToken?: string;
    repos?: string[];
}
/** The cookie holds a value derived from the view token, never the token itself. */
export declare function viewCookieValue(viewToken: string): string;
export declare function createDashboard(options: DashboardOptions): http.RequestListener;
export declare function startDashboard(options: DashboardOptions & {
    port: number;
    host: string;
}): Promise<http.Server>;
