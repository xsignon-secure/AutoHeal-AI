/**
 * Dashboard storage on Node's built-in SQLite (node:sqlite, Node 22.13+):
 * one file, no database server, no extra dependency.
 */
import type { HealEvent } from '../upload.js';
export declare const STATUSES: readonly ["FIXED", "QUARANTINED", "FLAKY", "BLOCKED_CHEATING", "APP_BUG", "ENV", "UNFIXED"];
export declare const CATEGORIES: readonly ["TEST_BUG", "APP_BUG", "FLAKY", "ENV"];
export declare const ROOT_CAUSES: readonly ["LOCATOR_DRIFT", "HYDRATION_RACE", "MOCK_DRIFT", "REGRESSION", "TIMING", "INFRA", "UNKNOWN"];
export declare const SCHEMA = "\nCREATE TABLE IF NOT EXISTS heal_events (\n  id            TEXT PRIMARY KEY,\n  repo          TEXT NOT NULL,\n  run_id        TEXT,\n  run_url       TEXT,\n  commit_sha    TEXT,\n  branch        TEXT,\n  test_title    TEXT NOT NULL,\n  file_path     TEXT NOT NULL,\n  status        TEXT NOT NULL,\n  category      TEXT NOT NULL,\n  root_cause    TEXT NOT NULL,\n  confidence    REAL NOT NULL,\n  fix_by        TEXT,\n  pr_url        TEXT,\n  issue_url     TEXT,\n  tokens        INTEGER NOT NULL DEFAULT 0,\n  usd           REAL NOT NULL DEFAULT 0,\n  minutes_saved INTEGER NOT NULL DEFAULT 0,\n  created_at    TEXT NOT NULL,\n  received_at   TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS heal_events_repo_created ON heal_events (repo, created_at DESC);\nCREATE INDEX IF NOT EXISTS heal_events_repo_title ON heal_events (repo, test_title);\nCREATE INDEX IF NOT EXISTS heal_events_status ON heal_events (status);\n";
export interface Stats {
    repos: number;
    events: number;
    fixed: number;
    fixPrs: number;
    quarantined: number;
    blocked: number;
    appBugs: number;
    env: number;
    unfixed: number;
    tokens: number;
    usd: number;
    minutesSaved: number;
}
export interface EventRow extends HealEvent {
    received_at: string;
}
export declare class Store {
    private readonly maxEvents;
    private readonly db;
    /**
     * @param maxEvents rows kept; the oldest received are dropped beyond it, so
     *   even a leaked upload secret cannot grow the database without bound.
     */
    constructor(file: string, maxEvents?: number);
    upsert(events: HealEvent[]): number;
    stats(repo?: string): Stats;
    events(filter?: {
        repo?: string;
        status?: string;
        limit?: number;
    }): EventRow[];
    repos(): string[];
    close(): void;
}
