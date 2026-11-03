/**
 * Dashboard storage on Node's built-in SQLite (node:sqlite, Node 22.13+):
 * one file, no database server, no extra dependency.
 */
import { DatabaseSync } from 'node:sqlite';
export const STATUSES = ['FIXED', 'QUARANTINED', 'FLAKY', 'BLOCKED_CHEATING', 'APP_BUG', 'ENV', 'UNFIXED'];
export const CATEGORIES = ['TEST_BUG', 'APP_BUG', 'FLAKY', 'ENV'];
export const ROOT_CAUSES = ['LOCATOR_DRIFT', 'HYDRATION_RACE', 'MOCK_DRIFT', 'REGRESSION', 'TIMING', 'INFRA', 'UNKNOWN'];
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS heal_events (
  id            TEXT PRIMARY KEY,
  repo          TEXT NOT NULL,
  run_id        TEXT,
  run_url       TEXT,
  commit_sha    TEXT,
  branch        TEXT,
  test_title    TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  status        TEXT NOT NULL,
  category      TEXT NOT NULL,
  root_cause    TEXT NOT NULL,
  confidence    REAL NOT NULL,
  fix_by        TEXT,
  pr_url        TEXT,
  issue_url     TEXT,
  tokens        INTEGER NOT NULL DEFAULT 0,
  usd           REAL NOT NULL DEFAULT 0,
  minutes_saved INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  received_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS heal_events_repo_created ON heal_events (repo, created_at DESC);
CREATE INDEX IF NOT EXISTS heal_events_repo_title ON heal_events (repo, test_title);
CREATE INDEX IF NOT EXISTS heal_events_status ON heal_events (status);
`;
export class Store {
    maxEvents;
    db;
    /**
     * @param maxEvents rows kept; the oldest received are dropped beyond it, so
     *   even a leaked upload secret cannot grow the database without bound.
     */
    constructor(file, maxEvents = 100_000) {
        this.maxEvents = maxEvents;
        this.db = new DatabaseSync(file);
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec(SCHEMA);
    }
    upsert(events) {
        const stmt = this.db.prepare(`
      INSERT INTO heal_events (id, repo, run_id, run_url, commit_sha, branch, test_title, file_path, status, category, root_cause,
        confidence, fix_by, pr_url, issue_url, tokens, usd, minutes_saved, created_at, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status, category = excluded.category, root_cause = excluded.root_cause,
        confidence = excluded.confidence, fix_by = excluded.fix_by,
        pr_url = COALESCE(excluded.pr_url, heal_events.pr_url),
        issue_url = COALESCE(excluded.issue_url, heal_events.issue_url),
        tokens = excluded.tokens, usd = excluded.usd, minutes_saved = excluded.minutes_saved,
        received_at = excluded.received_at`);
        const now = new Date().toISOString();
        this.db.exec('BEGIN');
        try {
            for (const e of events) {
                stmt.run(e.id, e.repo, e.run_id ?? null, e.run_url ?? null, e.commit_sha ?? null, e.branch ?? null, e.test_title, e.file_path, e.status, e.category, e.root_cause, e.confidence, e.fix_by ?? null, e.pr_url ?? null, e.issue_url ?? null, e.tokens, e.usd, e.minutes_saved, e.created_at, now);
            }
            this.db.exec(`DELETE FROM heal_events WHERE id IN (SELECT id FROM heal_events ORDER BY received_at DESC, id DESC LIMIT -1 OFFSET ${Math.max(1, Math.floor(this.maxEvents))})`);
            this.db.exec('COMMIT');
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
        return events.length;
    }
    stats(repo) {
        const where = repo ? 'WHERE repo = ?' : '';
        const args = repo ? [repo] : [];
        const row = this.db
            .prepare(`SELECT
          COUNT(DISTINCT repo) AS repos,
          COUNT(*) AS events,
          COALESCE(SUM(status = 'FIXED'), 0) AS fixed,
          COUNT(DISTINCT CASE WHEN status = 'FIXED' THEN pr_url END) AS fixPrs,
          COALESCE(SUM(status = 'QUARANTINED'), 0) AS quarantined,
          COALESCE(SUM(status = 'BLOCKED_CHEATING'), 0) AS blocked,
          COALESCE(SUM(status = 'APP_BUG'), 0) AS appBugs,
          COALESCE(SUM(status = 'ENV'), 0) AS env,
          COALESCE(SUM(status IN ('UNFIXED', 'FLAKY')), 0) AS unfixed,
          COALESCE(SUM(tokens), 0) AS tokens,
          COALESCE(SUM(usd), 0) AS usd,
          COALESCE(SUM(minutes_saved), 0) AS minutesSaved
        FROM heal_events ${where}`)
            .get(...args);
        return {
            repos: Number(row.repos ?? 0),
            events: Number(row.events ?? 0),
            fixed: Number(row.fixed ?? 0),
            fixPrs: Number(row.fixPrs ?? 0),
            quarantined: Number(row.quarantined ?? 0),
            blocked: Number(row.blocked ?? 0),
            appBugs: Number(row.appBugs ?? 0),
            env: Number(row.env ?? 0),
            unfixed: Number(row.unfixed ?? 0),
            tokens: Number(row.tokens ?? 0),
            usd: Math.round(Number(row.usd ?? 0) * 10_000) / 10_000,
            minutesSaved: Number(row.minutesSaved ?? 0),
        };
    }
    events(filter = {}) {
        const clauses = [];
        const args = [];
        if (filter.repo) {
            clauses.push('repo = ?');
            args.push(filter.repo);
        }
        if (filter.status) {
            clauses.push('status = ?');
            args.push(filter.status);
        }
        const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? 100)), 500);
        const sql = `SELECT * FROM heal_events ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC, id LIMIT ${limit}`;
        return this.db.prepare(sql).all(...args);
    }
    repos() {
        return this.db.prepare('SELECT DISTINCT repo FROM heal_events ORDER BY repo').all().map((r) => r.repo);
    }
    close() {
        this.db.close();
    }
}
//# sourceMappingURL=store.js.map