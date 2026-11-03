/**
 * The dashboard page: server-rendered HTML, no scripts, no external assets,
 * light and dark themes from the system setting.
 */
import type { EventRow, Stats } from './store.js';
export declare function escapeHtml(value: unknown): string;
export declare function renderPage(stats: Stats, events: EventRow[], repos: string[], selected: string | undefined): string;
