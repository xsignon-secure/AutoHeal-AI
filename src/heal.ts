/**
 * The heal job: load the failed run, triage every failure, fix only test
 * bugs, prove each fix, and write nothing that did not pass every check.
 *
 *   1. load-report (local report or a CI run URL) and read each failure
 *   2. ask the engine for a deterministic fix (suggest-fix, diff only)
 *   3. per failure: mock drift check, flaky verdict, triage (+ AI refinement)
 *   4. TEST_BUG: rules fix first (no tokens), then the AI agent
 *      every proposal: local anti-cheat scan + engine heal guard, write,
 *      stability rerun (repeat-each), file rerun (no new failures), else revert
 *   5. FLAKY: quarantine with an expiry; APP_BUG: issue; ENV: report
 *   6. whole-tree heal guard on the result, repo memory, summary
 */

import { execFile } from 'node:child_process';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { aiFix, aiTriage, safePath, type VerifyOutcome } from './agent.js';
import { Budget, EMPTY_SNAPSHOT, priceFor, type BudgetLimits, type BudgetSnapshot } from './budget.js';
import { scanChange, type Verdict } from './cheat.js';
import { shortDiff } from './evidence.js';
import { McpTools, type ToolCaller } from './mcp.js';
import { loadMemory, memoryText, MEMORY_PATH, relevantMemory, remember } from './memory.js';
import type { Provider } from './providers/types.js';
import { triage as triageFailure, type Triage } from './triage.js';
import { MINUTES_SAVED, type FailureInfo, type FailureResult, type FixInfo, type GuardInfo, type HealSummary, type Mode, type Outcome, type Status } from './types.js';
import { VERSION } from './version.js';

const run = promisify(execFile);

export interface HealOptions {
  projectRoot: string;
  /** JSON report, blob-report folder, or a GitHub Actions / GitLab run URL. */
  report: string;
  traceDirs?: string[];
  mode: Mode;
  maxFailures: number;
  repeatEach: number;
  quarantineDays: number;
  allowWarn: boolean;
  checkFlaky: boolean;
  flakyRuns: number;
  mocksBaseUrl?: string;
  appUrl?: string;
  /** Who owns quarantined tests (e.g. the author of the failing commit). */
  owner?: string;
  budget: BudgetLimits;
  provider: Provider | null;
  run?: HealSummary['run'];
  /** Injected engine (tests); default: start playwright-e2e-mcp. */
  mcp?: ToolCaller;
  log?: (line: string) => void;
}

interface DryFix {
  file: string;
  line: number;
  before: string;
  after: string;
  kind: string;
  why: string;
}

const NEW_FILE = '\u0000AUTOHEAL_NEW_FILE';

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function deltaSnapshot(after: BudgetSnapshot, before: BudgetSnapshot): BudgetSnapshot {
  return {
    steps: after.steps - before.steps,
    inputTokens: after.inputTokens - before.inputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
    usd: Math.round((after.usd - before.usd) * 10_000) / 10_000,
    priced: after.priced,
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function isPytestProject(root: string): Promise<boolean> {
  for (const name of ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs', 'playwright.config.mts']) {
    if (await exists(path.join(root, name))) return false;
  }
  for (const name of ['pytest.ini', 'pyproject.toml', 'conftest.py', 'setup.cfg', 'requirements.txt']) {
    if (await exists(path.join(root, name))) return true;
  }
  return false;
}

async function isGitRepo(root: string): Promise<boolean> {
  try {
    await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

function failureFrom(index: number, data: Record<string, unknown>, text: string): FailureInfo | null {
  const f = data.failure as Record<string, unknown> | undefined;
  if (!f || typeof f.file !== 'string' || typeof f.title !== 'string') return null;
  const info: FailureInfo = {
    index,
    file: f.file.replace(/\\/g, '/'),
    title: f.title,
    kind: typeof f.kind === 'string' ? f.kind : 'unknown',
    message: typeof f.message === 'string' ? f.message : '',
    detail: text,
  };
  if (typeof f.line === 'number') info.line = f.line;
  if (typeof f.expected === 'string') info.expected = f.expected;
  if (typeof f.actual === 'string') info.actual = f.actual;
  // The engine keeps Expected/Received inside the message; read them from there too.
  if (info.expected === undefined || info.actual === undefined) {
    const expected = /^\s*Expected(?: string| pattern| value)?:\s*(.+)$/m.exec(info.message)?.[1];
    const received = /^\s*Received(?: string| value)?:\s*(.+)$/m.exec(info.message)?.[1];
    if (info.expected === undefined && expected !== undefined) info.expected = expected.trim();
    if (info.actual === undefined && received !== undefined) info.actual = received.trim();
  }
  if (typeof f.project === 'string') info.project = f.project;
  return info;
}

/**
 * The part of the engine's failure report that describes this failure
 * (error, stack, call log, DOM), without the generic advice and run list
 * that follow it, so triage patterns only see real evidence.
 */
export function evidenceText(detail: string): string {
  const cut = detail.search(/^### (Diagnosis|Next steps|All failures in this run|Run context)\b/m);
  return (cut >= 0 ? detail.slice(0, cut) : detail).slice(0, 20_000);
}

function lastTitle(title: string): string {
  const parts = title.split(' › ');
  return parts[parts.length - 1] ?? title;
}

function engineVerdict(data: Record<string, unknown>, ok: boolean): Verdict | 'UNAVAILABLE' {
  const status = typeof data.status === 'string' ? data.status.toUpperCase() : '';
  if (status === 'PASS' || status === 'WARN' || status === 'BLOCK') return status;
  if (!ok && data.error) return 'UNAVAILABLE';
  return ok ? 'PASS' : 'UNAVAILABLE';
}

export async function heal(options: HealOptions): Promise<HealSummary> {
  const log = options.log ?? (() => undefined);
  const startedAt = new Date().toISOString();
  const root = path.resolve(options.projectRoot);
  const provider = options.provider;
  const budget = new Budget(options.budget, provider ? priceFor(provider.model) : null);
  const summary: HealSummary = {
    tool: 'autoheal-ai',
    version: VERSION,
    startedAt,
    finishedAt: startedAt,
    mode: options.mode,
    provider: provider?.name ?? 'none',
    model: provider?.model ?? 'none',
    outcome: 'nothing-to-do',
    changes: false,
    changedFiles: [],
    results: [],
    totalFailures: 0,
    skippedFailures: 0,
    spend: { ...EMPTY_SNAPSHOT, priced: provider ? priceFor(provider.model) !== null : true },
    minutesSaved: 0,
    ...(options.run ? { run: options.run } : {}),
  };

  const mcp = options.mcp ?? (await McpTools.start(root, { keepGithubToken: /^https?:\/\//.test(options.report) }));
  /** Original content of every file this job wrote, to revert on demand. */
  const originals = new Map<string, string>();
  const pytest = await isPytestProject(root);

  async function writeTracked(rel: string, content: string): Promise<void> {
    const abs = path.join(root, rel);
    if (!originals.has(rel)) {
      originals.set(rel, (await exists(abs)) ? await readFile(abs, 'utf8') : NEW_FILE);
    }
    await writeFile(abs, content);
  }

  async function revertAll(only?: (rel: string) => boolean): Promise<void> {
    for (const [rel, original] of [...originals]) {
      if (only && !only(rel)) continue;
      const abs = path.join(root, rel);
      if (original === NEW_FILE) {
        await rm(abs, { force: true });
      } else {
        await writeFile(abs, original);
      }
      originals.delete(rel);
    }
  }

  try {
    // 1. Load the failed run.
    log(`Loading report ${options.report}`);
    const loaded = await mcp.call(
      'load-report',
      { report: options.report, ...(options.traceDirs?.length ? { traceDirs: options.traceDirs } : {}), record: false },
      300_000,
    );
    if (!loaded.ok) {
      summary.outcome = 'error';
      summary.error = `Could not load the report: ${loaded.text.split('\n').slice(0, 3).join(' ')}`;
      return summary;
    }

    const failures: FailureInfo[] = [];
    for (let index = 1; index <= 200; index++) {
      const res = await mcp.call('get-failure', { index }, 120_000);
      const info = res.ok || res.data.failure ? failureFrom(index, res.data, res.text) : null;
      if (!info) break;
      failures.push(info);
      const total = typeof res.data.total === 'number' ? res.data.total : undefined;
      if (total !== undefined && index >= total) break;
    }
    summary.totalFailures = failures.length;
    if (!failures.length) {
      summary.outcome = 'nothing-to-do';
      return summary;
    }
    const work = failures.slice(0, Math.max(1, options.maxFailures));
    summary.skippedFailures = failures.length - work.length;
    const failingTitlesByFile = new Map<string, Set<string>>();
    for (const f of failures) {
      const set = failingTitlesByFile.get(f.file) ?? new Set<string>();
      set.add(f.title);
      failingTitlesByFile.set(f.file, set);
    }

    // 2. Deterministic fixes, read before any rerun changes the engine's "last run".
    const dryFixes = new Map<number, DryFix>();
    for (const f of work) {
      const res = await mcp.call('suggest-fix', { index: f.index }, 300_000);
      const fix = res.data.fix as Record<string, unknown> | undefined;
      if (
        fix &&
        typeof fix.file === 'string' &&
        typeof fix.line === 'number' &&
        typeof fix.before === 'string' &&
        typeof fix.after === 'string' &&
        fix.before !== fix.after // the engine can return a no-op "fix"; that is no fix
      ) {
        dryFixes.set(f.index, {
          file: fix.file.replace(/\\/g, '/'),
          line: fix.line,
          before: fix.before,
          after: fix.after,
          kind: typeof fix.kind === 'string' ? fix.kind : 'locator',
          why: typeof fix.why === 'string' ? fix.why : '',
        });
      }
    }

    const memory = await loadMemory(root);
    const fixedTitles = new Set<string>();

    /** Anti-cheat both ways, write, prove stability, keep or revert. */
    async function verify(failure: FailureInfo, rel: string, content: string): Promise<VerifyOutcome> {
      const abs = safePath(root, rel);
      if (!abs) return { kept: false, blocked: false, message: 'Path not allowed.' };
      const before = await readFile(abs, 'utf8');
      if (before === content) return { kept: false, blocked: false, message: 'The proposed content is identical to the current file.' };
      const local = scanChange(before, content);
      const engine = await mcp.call('check-test-change', { file: rel, after: content }, 180_000);
      const engineStatus = engineVerdict(engine.data, engine.ok);
      const engineFindings = Array.isArray(engine.data.findings)
        ? (engine.data.findings as Array<Record<string, unknown>>).map((f) => ({
            severity: String(f.severity ?? 'WARN').toUpperCase(),
            rule: String(f.rule ?? 'engine'),
            message: String(f.message ?? ''),
          }))
        : [];
      const guard: GuardInfo = { engine: engineStatus, local: local.verdict, findings: [...local.findings, ...engineFindings] };
      const strict = engineStatus === 'UNAVAILABLE';
      const blocked =
        local.verdict === 'BLOCK' ||
        engineStatus === 'BLOCK' ||
        (!options.allowWarn && (local.verdict === 'WARN' || engineStatus === 'WARN')) ||
        (strict && local.verdict !== 'PASS');
      if (blocked) {
        const reasons = guard.findings.map((f) => `${f.severity} ${f.rule}: ${f.message}`).join('; ') || 'the engine heal guard could not confirm the change';
        log(`  anti-cheat rejected a change to ${rel}: ${reasons}`);
        return { kept: false, blocked: true, guard, message: `Anti-cheat: ${reasons}` };
      }

      await writeTracked(rel, content);
      const grep = escapeRegex(lastTitle(failure.title));
      let passed = false;
      let detail = '';
      const runs = pytest ? Math.min(3, options.repeatEach) : options.repeatEach;
      if (pytest) {
        passed = true;
        for (let i = 0; i < runs && passed; i++) {
          const r = await mcp.call('run-test', { testFiles: [failure.file], grep, retries: 0, retryOnFailure: false, timeoutMs: 600_000 }, 660_000);
          const stats = r.data.run as { passed?: number; failed?: number } | undefined;
          passed = r.ok && (stats?.failed ?? 1) === 0 && (stats?.passed ?? 0) > 0;
          if (!passed) detail = r.text.split('\n').slice(0, 20).join('\n');
        }
      } else {
        const r = await mcp.call(
          'run-test',
          { testFiles: [failure.file], grep, args: [`--repeat-each=${runs}`], retries: 0, retryOnFailure: false, timeoutMs: 900_000 },
          960_000,
        );
        const stats = r.data.run as { passed?: number; failed?: number; flaky?: number } | undefined;
        passed = r.ok && (stats?.failed ?? 1) === 0 && (stats?.flaky ?? 0) === 0 && (stats?.passed ?? 0) >= runs;
        if (!passed) detail = r.text.split('\n').slice(0, 25).join('\n');
      }
      if (!passed) {
        await writeFile(abs, before);
        if (originals.get(rel) === before) originals.delete(rel);
        return { kept: false, blocked: false, guard, stability: { runs, passed: false, detail }, message: `The test still fails with this change:\n${detail}` };
      }

      // The rest of the file must not get worse: only tests that were already failing may fail.
      const whole = await mcp.call('run-test', { testFiles: [failure.file], retries: 0, retryOnFailure: false, timeoutMs: 600_000 }, 660_000);
      const wholeFailures = ((whole.data.run as { failures?: Array<{ title?: string }> } | undefined)?.failures ?? []).map((f) => String(f.title ?? ''));
      const allowedFailing = failingTitlesByFile.get(failure.file) ?? new Set<string>();
      const broken = wholeFailures.filter((t) => t === failure.title || !allowedFailing.has(t) || fixedTitles.has(t));
      if (broken.length) {
        await writeFile(abs, before);
        if (originals.get(rel) === before) originals.delete(rel);
        return {
          kept: false,
          blocked: false,
          guard,
          stability: { runs, passed: true, detail: `broke: ${broken.join(', ')}` },
          message: `The change makes other tests in the file fail: ${broken.join(', ')}`,
        };
      }
      return { kept: true, blocked: false, guard, stability: { runs, passed: true, detail: `passed ${runs}× and the rest of the file did not get worse` }, message: 'kept' };
    }

    // 3–5. One failure at a time.
    for (const failure of work) {
      const spentBefore = budget.snapshot();
      log(`Failure ${failure.index}: ${failure.file} › ${failure.title}`);

      let mockDrift = false;
      if (options.mocksBaseUrl) {
        const mocks = await mcp.call('check-mocks', { baseUrl: options.mocksBaseUrl, filter: failure.file }, 180_000);
        const status = typeof mocks.data.status === 'string' ? mocks.data.status.toUpperCase() : '';
        mockDrift = Array.isArray(mocks.data.findings) && mocks.data.findings.length > 0 && status !== 'PASS';
      }
      let flakyVerdict: string | undefined;
      if (options.checkFlaky && !['browser-crash', 'server-unreachable', 'config', 'syntax'].includes(failure.kind)) {
        const target = failure.line ? `${failure.file}:${failure.line}` : failure.file;
        const flaky = await mcp.call('diagnose-flaky', { testFiles: [target], runs: options.flakyRuns }, 900_000);
        if (typeof flaky.data.verdict === 'string') flakyVerdict = flaky.data.verdict;
      }
      const dry = dryFixes.get(failure.index);
      const triageInput: Parameters<typeof triageFailure>[0] = {
        kind: failure.kind,
        message: `${failure.message}\n${evidenceText(failure.detail)}`,
        mockDrift,
        locatorFix: dry?.kind === 'locator',
      };
      if (failure.expected !== undefined) triageInput.expected = failure.expected;
      if (failure.actual !== undefined) triageInput.actual = failure.actual;
      if (flakyVerdict !== undefined) triageInput.flakyVerdict = flakyVerdict;
      let t: Triage = triageFailure(triageInput);
      if (provider && t.confidence < 0.6 && t.category !== 'FLAKY') t = await aiTriage(provider, budget, failure, t);
      log(`  triage: ${t.category}/${t.rootCause} ${(t.confidence * 100).toFixed(0)}%`);

      const { detail: _detail, ...failureLite } = failure;
      const result: FailureResult = {
        failure: failureLite,
        category: t.category,
        rootCause: t.rootCause,
        confidence: t.confidence,
        reasons: t.reasons,
        status: 'UNFIXED',
        summary: '',
        spend: EMPTY_SNAPSHOT,
      };

      if (t.category === 'TEST_BUG') {
        let fixed = false;
        // 4a. Deterministic fix from the engine: no AI tokens.
        if (dry && dry.kind === 'locator') {
          const abs = safePath(root, dry.file);
          if (abs) {
            const current = await readFile(abs, 'utf8');
            const lines = current.split('\n');
            const idx = dry.line - 1;
            const line = lines[idx];
            const cr = line?.endsWith('\r') ? '\r' : '';
            if (line !== undefined && line.slice(0, line.length - cr.length) === dry.before.replace(/\r$/, '')) {
              lines[idx] = `${dry.after.replace(/\r$/, '')}${cr}`;
              const next = lines.join('\n');
              const outcome = await verify(failure, dry.file, next);
              if (outcome.guard) result.guard = outcome.guard;
              if (outcome.stability) result.stability = outcome.stability;
              if (outcome.kept) {
                fixed = true;
                result.status = 'FIXED';
                result.fix = { by: 'rules', file: dry.file, explanation: dry.why || 'Replaced the locator with one verified against the page in the trace.', diff: shortDiff(dry.file, current, next), before: dry.before.trim(), after: dry.after.trim() };
                result.summary = 'Fixed with the engine\'s verified locator; no AI tokens used.';
              } else if (outcome.blocked) {
                result.status = 'BLOCKED_CHEATING';
                result.summary = outcome.message;
              }
            }
          }
        }
        // 4b. The AI agent.
        if (!fixed && provider) {
          const agent = await aiFix({
            mcp,
            provider,
            projectRoot: root,
            failure,
            triage: t,
            memory: memoryText(relevantMemory(memory, failure.file)),
            budget,
            ...(options.appUrl ? { appUrl: options.appUrl } : {}),
            verify: (file, content) => verify(failure, file, content),
          });
          if (agent.guard) result.guard = agent.guard;
          if (agent.stability) result.stability = agent.stability;
          if (agent.result === 'fixed' && agent.file && agent.before !== undefined && agent.after !== undefined) {
            fixed = true;
            result.status = 'FIXED';
            const fix: FixInfo = { by: 'ai', file: agent.file, explanation: agent.explanation, diff: shortDiff(agent.file, agent.before, agent.after) };
            result.fix = fix;
            result.summary = 'Fixed by the AI agent and proven by the stability rerun.';
          } else if (agent.result === 'blocked' || (agent.blockedAttempts > 0 && agent.result !== 'gave-up')) {
            result.status = 'BLOCKED_CHEATING';
            result.summary = `Every proposed fix tried to weaken the test, so none was kept. ${agent.explanation}`;
          } else if (agent.result === 'gave-up') {
            result.status = 'APP_BUG';
            result.category = 'APP_BUG';
            result.rootCause = 'REGRESSION';
            result.reasons = [...result.reasons, `AI agent: ${agent.explanation}`];
            result.summary = `The agent found that the app, not the test, is wrong: ${agent.explanation}`;
          } else {
            result.status = result.status === 'BLOCKED_CHEATING' ? 'BLOCKED_CHEATING' : 'UNFIXED';
            result.summary = result.summary || `No fix was kept: ${agent.explanation}`;
          }
        } else if (!fixed && result.status !== 'BLOCKED_CHEATING') {
          result.summary = 'This looks like a test problem, but no deterministic fix applied and no AI key is set (ANTHROPIC_API_KEY, OPENAI_API_KEY or AUTOHEAL_BASE_URL).';
        }
        if (fixed) fixedTitles.add(failure.title);
      } else if (t.category === 'FLAKY') {
        if (options.mode === 'comment') {
          result.status = 'FLAKY';
          result.summary = 'Flaky: passes and fails on the same code. Comment mode, so it was not quarantined.';
        } else {
          const before = (await exists(path.join(root, 'playwright-quarantine.json'))) ? await readFile(path.join(root, 'playwright-quarantine.json'), 'utf8') : null;
          const q = await mcp.call('quarantine', {
            action: 'add',
            file: failure.file,
            title: failure.title,
            days: options.quarantineDays,
            owner: options.owner ?? 'AutoHeal AI (unassigned)',
            reason: `AutoHeal: ${t.reasons.join('; ')}`.slice(0, 300),
          });
          if (q.ok) {
            if (!originals.has('playwright-quarantine.json')) originals.set('playwright-quarantine.json', before ?? NEW_FILE);
            result.status = 'QUARANTINED';
            result.quarantine = { days: options.quarantineDays };
            result.summary = `Flaky, so it was quarantined for ${options.quarantineDays} days: it still runs, but its failures do not fail the build until the entry expires.`;
          } else {
            result.status = 'FLAKY';
            result.summary = `Flaky, but quarantining failed: ${q.text.split('\n')[0]}`;
          }
        }
      } else if (t.category === 'APP_BUG') {
        result.status = 'APP_BUG';
        result.summary = 'The test looks right and the app looks wrong, so the test was not changed. An issue with the evidence is opened instead.';
      } else {
        result.status = 'ENV';
        result.summary = 'The failure comes from the environment (browser, server, network or config), not the test. Nothing was changed.';
      }

      result.spend = deltaSnapshot(budget.snapshot(), spentBefore);
      summary.results.push(result);
    }

    // 6. Whole-tree heal guard over everything this job changed.
    const specFiles = [...originals.keys()].filter((f) => f !== 'playwright-quarantine.json');
    if (specFiles.length && (await isGitRepo(root))) {
      const final = await mcp.call('check-test-change', { base: 'HEAD', files: specFiles, runtime: !pytest }, 900_000);
      const verdict = engineVerdict(final.data, final.ok);
      if (verdict === 'BLOCK' || (!options.allowWarn && verdict === 'WARN')) {
        log(`Final heal guard: ${verdict}; reverting every test change.`);
        await revertAll((rel) => specFiles.includes(rel));
        for (const r of summary.results) {
          if (r.status === 'FIXED') {
            r.status = 'BLOCKED_CHEATING';
            r.summary = `The final heal guard over all changes said ${verdict}; every test change was reverted.`;
          }
        }
      }
    }

    // Repo memory for kept fixes.
    if (options.mode !== 'comment') {
      const kept = summary.results.filter((r) => r.status === 'FIXED');
      const memRel = MEMORY_PATH.split(path.sep).join('/');
      if (kept.length && !originals.has(memRel)) {
        const memAbs = path.join(root, memRel);
        originals.set(memRel, (await exists(memAbs)) ? await readFile(memAbs, 'utf8') : NEW_FILE);
      }
      for (const r of kept) {
        const before = r.fix?.before;
        const after = r.fix?.after;
        await remember(root, {
          file: r.failure.file,
          test: r.failure.title,
          rootCause: r.rootCause,
          ...(before !== undefined ? { before } : {}),
          ...(after !== undefined ? { after } : {}),
          note: r.fix?.explanation ?? '',
        });
      }
    }

    // Comment mode never leaves changes behind; the diffs are in the comment.
    if (options.mode === 'comment') await revertAll();

    summary.changedFiles = [...originals.keys()].sort();
    summary.changes = options.mode !== 'comment' && summary.changedFiles.length > 0;
    summary.outcome = outcomeOf(summary.results);
  } catch (error) {
    await revertAll().catch(() => undefined);
    summary.outcome = 'error';
    summary.error = error instanceof Error ? error.message : String(error);
    summary.changes = false;
    summary.changedFiles = [];
  } finally {
    summary.spend = budget.snapshot();
    summary.minutesSaved = summary.results.reduce((sum, r) => sum + (MINUTES_SAVED[r.status] ?? 0), 0);
    summary.finishedAt = new Date().toISOString();
    if (!options.mcp) await mcp.close();
  }
  return summary;
}

export function outcomeOf(results: FailureResult[]): Outcome {
  if (!results.length) return 'nothing-to-do';
  const has = (s: Status) => results.some((r) => r.status === s);
  if (has('BLOCKED_CHEATING')) return 'blocked';
  if (has('FIXED')) return 'fixed';
  if (has('QUARANTINED')) return 'quarantined';
  if (has('APP_BUG')) return 'app-bug';
  return 'unfixed';
}
