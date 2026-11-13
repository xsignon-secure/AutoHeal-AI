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
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { aiFix, aiTriage, relativeImports, safePath, type VerifyOutcome } from './agent.js';
import { ensureSession, type LoginConfig } from './login.js';
import { Budget, EMPTY_SNAPSHOT, priceFor, type BudgetLimits, type BudgetSnapshot } from './budget.js';
import { scanChange, type Verdict } from './cheat.js';
import { redact } from './redact.js';
import { shortDiff } from './evidence.js';
import { McpTools, type ToolCaller } from './mcp.js';
import { ciInfo } from './ci.js';
import { loadLearned } from './learned.js';
import { CYPRESS_DOM_DIR, cypressPattern, cypressSelectorFor, domFor, loadCypressDoms, replaceCypressSelector } from './cypress-dom.js';
import { CypressTools, isCypressProject, type Framework } from './cypress.js';
import { isWdioProject, WdioTools } from './wdio.js';
import { findReport } from './report-files.js';
import { loadMemory, memoryEntryPath, memoryText, relevantMemory, remember } from './memory.js';
import type { Provider } from './providers/types.js';
import { triage as triageFailure, type Triage } from './triage.js';
import { MINUTES_SAVED, type FailureInfo, type FailureResult, type FixInfo, type GuardInfo, type HealSummary, type Mode, type Outcome, type RuntimeInfo, type Status } from './types.js';
import { VERSION } from './version.js';
import { failureScreenshot, frameFromFile, screenshotFile, visionEnabled, type Screenshot } from './vision.js';
import type { Sandbox } from './sandbox.js';
import { compareRuns, findTrace, readTrace, recordFromFile, type RuntimeFinding } from './runtime.js';
import { domFromZip, fingerprintPath, learn, loadFingerprints, lookup, saveFingerprints, type FingerprintEntry, type TraceDom } from './fingerprints.js';
import { bestMatch, elements, type Match } from './snapshot.js';
import { findCause, termsFromLocators, termsFromValues, type Cause, type CauseQuery } from './cause.js';
import { rejected, reviewText, type ReviewHistory } from './reviews.js';
import { isProtected, skipRule, tooWeak, POLICY_FILE, type Policy } from './policy.js';
import { locatorChanges, locatorFor, parseSelector, rankOf, renderLocator, sourcePattern, type ParsedLocator } from './locators.js';
import { HEALED_DIR, loadHealed, type HealedEntry } from './runtime-heal.js';
import { historyOf, type History } from './history.js';

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
  /** Sign in to the live app before the AI looks at it (needs appUrl; Playwright and pytest). */
  login?: LoginConfig;
  /** Who owns quarantined tests (e.g. the author of the failing commit). */
  owner?: string;
  budget: BudgetLimits;
  provider: Provider | null;
  run?: HealSummary['run'];
  /** Injected engine (tests); default: start playwright-e2e-mcp (or the Cypress tools for a Cypress project). */
  mcp?: ToolCaller;
  /** Folders of fingerprints learned from green runs (`autoheal learn`), read as hints. */
  learnedDirs?: string[];
  /** playwright, pytest or cypress; detected from the project when left out or 'auto'. */
  framework?: Framework | 'auto';
  log?: (line: string) => void;
  /** Run the engine (tests and every proposed fix) as this user; see sandbox.ts. */
  sandbox?: Sandbox | null;
  /** What the PR says about the sandbox. */
  sandboxNote?: string;
  /** Where to save before/after screenshots of kept fixes (the CLI uses <out>/evidence). */
  evidenceDir?: string;
  /** What happened to earlier AutoHeal PRs (see reviews.ts). */
  reviews?: ReviewHistory;
  /** Why reviews could not be read, for the PR. */
  reviewNote?: string;
  /** The repository's .autoheal.yml (see policy.ts); its limits are already applied to the options above. */
  policy?: Policy | null;
  /** The project folder inside the repository ('' at the root), for matching policy paths. */
  repoPrefix?: string;
  /** What the policy changed, for the PR. */
  policyNote?: string;
  /** Folders holding heals recorded during the run (autoheal-healed/), turned into code fixes. */
  healedDirs?: string[];
  /** Earlier runs' results per test (see history.ts), shown with flaky tests. */
  history?: History;
  /** Try an AI fix for flaky tests before quarantining them (default true; needs a provider). */
  fixFlaky?: boolean;
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

/** A candidate change to one file, before it is verified. */
interface Proposal {
  by: FixInfo['by'];
  file: string;
  current: string;
  next: string;
  why: string;
  before?: string;
  after?: string;
  match?: { score: number; signals: string[] };
  sameAs?: string;
  /** The new locator, so the same change can be applied to other files. */
  locator?: ParsedLocator;
  /** Cypress: the new CSS selector. */
  cySelector?: string;
}

/** A kept fix for a broken locator, reused for every other test it broke. */
interface Move {
  selector: string;
  title: string;
  file: string;
  diff: string;
  /** Set when the replacement is known as a locator (fingerprint fixes). */
  locator?: ParsedLocator;
  /** Cypress: the new CSS selector. */
  cySelector?: string;
}

/** The publish job accepts up to 60 fingerprint files per PR. */
const MAX_FINGERPRINTS_PER_RUN = 50;

async function traceDom(root: string, tracePath: string | undefined): Promise<TraceDom | null> {
  if (!tracePath) return null;
  const abs = path.resolve(root, tracePath);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const buf = await readTrace(abs);
  if (!buf) return null;
  try {
    return domFromZip(buf);
  } catch {
    return null;
  }
}

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

const SPEC_FILE = /(?:\.(?:spec|test)\.[cm]?[jt]sx?|(?:^|\/)test_[^/]*\.py|_test\.py)$/;

/** Spec files that import `rel` (relative imports, or Python module imports). */
export async function findImporters(root: string, rel: string, maxFiles = 3000): Promise<string[]> {
  const found: string[] = [];
  const module = rel.endsWith('.py') ? rel.slice(0, -3).replace(/\//g, '.') : null;
  const escaped = module?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const moduleRe = escaped ? new RegExp(`(?:^|\\n)\\s*(?:from\\s+${escaped}\\s+import|import\\s+${escaped}\\b)`) : null;
  let seen = 0;
  async function walk(dir: string): Promise<void> {
    if (seen > maxFiles) return;
    let entries;
    try {
      entries = await readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__' || e.name === 'dist') continue;
      const child = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(child);
      else if (e.isFile() && SPEC_FILE.test(child) && ++seen <= maxFiles) {
        const source = await readFile(path.join(root, child), 'utf8').catch(() => '');
        if (relativeImports(child, source).includes(rel) || moduleRe?.test(source)) found.push(child);
      }
    }
  }
  await walk('');
  return found.sort();
}

/** Where the engine stores a downloaded CI run (playwright-e2e-mcp 0.15). */
export function ciDownloadDir(root: string, url: string): string | null {
  const gh = /\/actions\/runs\/(\d+)/.exec(url);
  if (gh) return path.join(root, '.playwright-e2e-mcp', 'ci', `github-${gh[1]}`);
  const gl = /\/-\/jobs\/(\d+)/.exec(url);
  if (gl) return path.join(root, '.playwright-e2e-mcp', 'ci', `gitlab-${gl[1]}`);
  return null;
}

async function downloadRun(root: string, url: string, log: (line: string) => void): Promise<{ report: string; traceDirs: string[] } | { error: string }> {
  log(`Downloading ${url} (in a separate engine that runs no tests)`);
  const downloader = await McpTools.start(root, { keepGithubToken: true });
  try {
    const res = await downloader.call('load-report', { report: url, record: false }, 600_000);
    if (!res.ok) return { error: `Could not load the report: ${res.text.split('\n').slice(0, 3).join(' ')}` };
  } finally {
    await downloader.close();
  }
  const dir = ciDownloadDir(root, url);
  const found = dir ? await findReport(dir) : null;
  if (!dir || !found) return { error: `Downloaded ${url}, but found no Playwright report in it.` };
  return {
    report: path.relative(root, found.report),
    traceDirs: [path.relative(root, dir), ...found.traceDirs.map((d) => path.relative(root, d))],
  };
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
    // Redacted on the way in, so no secret printed by a test reaches the AI or a PR.
    message: typeof f.message === 'string' ? redact(f.message) : '',
    detail: redact(text),
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
  if (typeof f.tracePath === 'string') info.tracePath = f.tracePath;
  if (typeof f.screenshotPath === 'string') info.screenshotPath = f.screenshotPath;
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

/** A Playwright screenshot comparison failure (toHaveScreenshot / toMatchSnapshot on an image). */
export function isVisualFailure(f: Pick<FailureInfo, 'message'>): boolean {
  return /toHaveScreenshot|Screenshot comparison failed|\b\d{1,12} pixels? \(ratio [\d.]{1,20} of all image pixels\) (?:are|is) different/i.test(f.message.slice(0, 50_000));
}

const TEST_PATH = /(?:^|\/)(?:tests?|e2e|__tests__|playwright|cypress|spec)\/|\.(?:spec|test|cy)\.[cm]?[jt]sx?$|-snapshots\/|^\.autoheal|\.md$|^\.github\/|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;

/** Did app files change since the baseline was last committed? Then the visual change was intended. */
export async function visualIntent(root: string, snapDir: string): Promise<{ intended: boolean; commits: string[]; note: string }> {
  try {
    const { stdout: base } = await run('git', ['-c', 'core.hooksPath=/dev/null', 'log', '-1', '--format=%H', '--', snapDir], { cwd: root });
    const commit = base.trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) return { intended: false, commits: [], note: 'the baseline is not in git history, so no app change can explain the difference' };
    const { stdout: files } = await run('git', ['-c', 'core.hooksPath=/dev/null', 'diff', '--name-only', `${commit}..HEAD`, '--', '.'], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    const app = files.split('\n').filter((f) => f && !TEST_PATH.test(f));
    if (!app.length) return { intended: false, commits: [], note: `no app file changed since the baseline (${commit.slice(0, 7)})` };
    const { stdout: log } = await run('git', ['-c', 'core.hooksPath=/dev/null', 'log', '--format=%h %s', '-n', '5', `${commit}..HEAD`, '--', ...app.slice(0, 200)], { cwd: root });
    const commits = log.split('\n').filter(Boolean).map((l) => l.slice(0, 120));
    return { intended: commits.length > 0, commits, note: commits.length ? `${app.length} app file(s) changed since the baseline` : 'no app commit since the baseline' };
  } catch {
    return { intended: false, commits: [], note: 'git history is not available, so no app change can explain the difference' };
  }
}

/** The folders that may hold heals from the run: next to the report, the project, and any given. */
export function healedFolders(root: string, report: string, extra: string[] = []): string[] {
  const out = [path.join(root, HEALED_DIR), ...extra.map((d) => path.resolve(root, d))];
  if (report && !/^https?:\/\//.test(report)) {
    // A report folder (downloaded artifacts) is searched for autoheal-healed/ inside it.
    const abs = path.resolve(root, report);
    out.push(path.join(path.dirname(abs), HEALED_DIR), abs === root ? path.join(abs, HEALED_DIR) : abs);
  }
  return [...new Set(out)];
}

/** What makes two failures one problem: the same broken locator, or the same wrong value. */
export function failureGroup(f: Pick<FailureInfo, 'index' | 'expected' | 'actual' | 'kind'>, brokenSelector?: string): string {
  if (brokenSelector) return `locator:${brokenSelector}`;
  if (f.expected !== undefined && f.actual !== undefined && f.kind !== 'timeout') return `value:${f.expected}\u0000${f.actual}`;
  return `one:${f.index}`;
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
    ...(options.sandboxNote ? { sandbox: options.sandboxNote } : {}),
    ...(options.policyNote ? { policy: options.policyNote } : {}),
    ...(options.reviews || options.reviewNote ? { reviews: { ...(options.reviews?.prs ?? { merged: 0, edited: 0, closed: 0 }), ...(options.reviewNote ? { note: options.reviewNote } : {}) } } : {}),
  };

  // A CI run URL is downloaded by a short-lived engine that holds the token
  // and runs nothing else. The engine that runs tests and proposed fixes
  // never sees a GitHub token.
  let reportRef = options.report;
  let traceDirs = options.traceDirs;
  const framework: Framework =
    options.framework && options.framework !== 'auto'
      ? options.framework
      : (await isWdioProject(root))
        ? 'webdriverio'
        : (await isCypressProject(root))
        ? 'cypress'
        : (await isPytestProject(root))
          ? 'pytest'
          : 'playwright';
  summary.framework = framework;
  if (framework !== 'playwright') log(`Framework: ${framework}`);
  if (!options.mcp && framework !== 'cypress' && /^https?:\/\//.test(options.report)) {
    const local = await downloadRun(root, options.report, log);
    if ('error' in local) {
      summary.outcome = 'error';
      summary.error = local.error;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }
    reportRef = local.report;
    traceDirs = local.traceDirs;
  }
  const mcp =
    options.mcp ??
    (framework === 'cypress'
      ? new CypressTools(root, { sandbox: options.sandbox ?? null, log })
      : framework === 'webdriverio'
        ? new WdioTools(root, { sandbox: options.sandbox ?? null, log })
        : await McpTools.start(root, { sandbox: options.sandbox ?? null }));
  /** Original content of every file this job wrote, to revert on demand. */
  const originals = new Map<string, string>();
  /** Binary files (screenshot baselines) this job rewrote: their original bytes. */
  const binaryOriginals = new Map<string, Buffer>();
  /** pytest and Cypress: no Playwright traces and no --repeat-each, so stability is separate runs and the runtime guard is off. */
  const traceless = framework !== 'playwright';

  async function writeTracked(rel: string, content: string): Promise<void> {
    const abs = path.join(root, rel);
    if (!originals.has(rel)) {
      originals.set(rel, (await exists(abs)) ? await readFile(abs, 'utf8') : NEW_FILE);
    }
    await writeFile(abs, content);
  }

  async function revertAll(only?: (rel: string) => boolean): Promise<void> {
    for (const [rel, bytes] of [...binaryOriginals]) {
      if (only && !only(rel)) continue;
      await writeFile(path.join(root, rel), bytes);
      binaryOriginals.delete(rel);
    }
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

  // Signed-in pages for the AI: log in once through the engine. Like the live app
  // itself, this is a help, not a must: without it the AI uses the traces.
  let session: string | undefined;
  let sessionMade = false;
  if (options.login && options.appUrl && (framework === 'playwright' || framework === 'pytest')) {
    const existed = await access(path.join(root, options.login.session)).then(() => true, () => false);
    try {
      session = await ensureSession(mcp, options.login, { projectRoot: root, appUrl: options.appUrl, log });
      sessionMade = !existed;
      summary.signedIn = session;
    } catch (error) {
      log(`Sign-in: ${error instanceof Error ? error.message : String(error)}; the AI sees the pages signed out`);
    }
  }

  try {
    // 1. Load the failed run.
    log(`Loading report ${reportRef}`);
    const loaded = await mcp.call(
      'load-report',
      { report: reportRef, ...(traceDirs?.length ? { traceDirs } : {}), record: false },
      300_000,
    );
    // Heals the runtime fixture made during the run: the run may be green, but the code is still stale.
    const healedEntries = framework === 'playwright' ? await loadHealed(healedFolders(root, reportRef, options.healedDirs)) : [];
    if (healedEntries.length) log(`Healed during the run: ${healedEntries.length} locator(s)`);
    if (!loaded.ok && !healedEntries.length) {
      summary.outcome = 'error';
      summary.error = `Could not load the report: ${loaded.text.split('\n').slice(0, 3).join(' ')}`;
      return summary;
    }

    const failures: FailureInfo[] = [];
    for (let index = 1; loaded.ok && index <= 200; index++) {
      const res = await mcp.call('get-failure', { index }, 120_000);
      const info = res.ok || res.data.failure ? failureFrom(index, res.data, res.text) : null;
      if (!info) break;
      failures.push(info);
      const total = typeof res.data.total === 'number' ? res.data.total : undefined;
      if (total !== undefined && index >= total) break;
    }
    summary.totalFailures = failures.length;
    if (!failures.length && !healedEntries.length) {
      summary.outcome = 'nothing-to-do';
      return summary;
    }
    // The policy file can leave some tests alone entirely: they are listed, never touched.
    const policy = options.policy ?? null;
    const repoPath = (rel: string) => path.posix.join(options.repoPrefix ?? '', rel.replace(/\\/g, '/'));
    const eligible = failures.filter((f) => {
      const rule = skipRule(policy, repoPath(f.file), f.title);
      if (!rule) return true;
      log(`Failure ${f.index}: ${f.file} › ${f.title} (left alone: ${rule} in ${POLICY_FILE})`);
      const { detail: _detail, ...lite } = f;
      summary.results.push({
        failure: lite,
        category: 'TEST_BUG',
        rootCause: 'UNKNOWN',
        confidence: 0,
        reasons: [`${POLICY_FILE}: ${rule}`],
        status: 'UNFIXED',
        summary: `Left alone: ${POLICY_FILE} says AutoHeal should not work on this test (${rule}).`,
        spend: EMPTY_SNAPSHOT,
        skipped: true,
      });
      return false;
    });
    const failingTitlesByFile = new Map<string, Set<string>>();
    for (const f of failures) {
      const set = failingTitlesByFile.get(f.file) ?? new Set<string>();
      set.add(f.title);
      failingTitlesByFile.set(f.file, set);
    }

    // Element fingerprints: what each locator pointed at, from the repo and from this run's traces.
    const savedFingerprints = await loadFingerprints(root);
    for (const dir of options.learnedDirs ?? []) savedFingerprints.push(...(await loadLearned(dir)));
    const learned = new Map<string, FingerprintEntry>();
    const addLearned = (entries: FingerprintEntry[]) => {
      for (const e of entries) if (learned.size < MAX_FINGERPRINTS_PER_RUN || learned.has(fingerprintPath(e.selector, e.page))) learned.set(fingerprintPath(e.selector, e.page), e);
    };
    const doms = new Map<number, TraceDom>();
    for (const f of failures) {
      const dom = await traceDom(root, f.tracePath);
      if (!dom) continue;
      doms.set(f.index, dom);
      addLearned(learn(dom, f.file));
    }
    // Cypress: what the xsignon-autoheal/cypress plugin saw (from the artifacts or the project).
    if (framework === 'cypress') {
      const cyDoms = await loadCypressDoms(root, [options.report, CYPRESS_DOM_DIR]);
      for (const d of cyDoms) addLearned(learn(d.dom, d.spec));
      for (const f of failures) {
        const dom = domFor(cyDoms, f.file, f.title);
        if (dom) doms.set(f.index, dom);
      }
      log(cyDoms.length ? `Cypress page snapshots: ${cyDoms.length} test(s)` : 'Cypress page snapshots: none (add the xsignon-autoheal/cypress plugin for fixes without AI)');
    }
    const moves = new Map<string, Move>();

    // One cause, one group: failures with the same broken locator, or the same
    // wrong value, are one problem. The first of each group goes first, so
    // max-failures counts problems, not tests.
    const groupOf = (f: FailureInfo): string => failureGroup(f, doms.get(f.index)?.failedCall?.selector);
    const leaders = new Map<string, FailureInfo>();
    for (const f of eligible) if (!leaders.has(groupOf(f))) leaders.set(groupOf(f), f);
    const ordered = [...leaders.values(), ...eligible.filter((f) => leaders.get(groupOf(f)) !== f)];
    const work = ordered.slice(0, Math.max(1, options.maxFailures));
    summary.skippedFailures = ordered.length - work.length;
    if (eligible.length) summary.groups = leaders.size;
    if (leaders.size < eligible.length) log(`${eligible.length} failure(s) in ${leaders.size} group(s) by cause`);

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
    /** Runs the fixed test once with a trace and compares it with the failed run's trace. */
    async function runtimeCheck(failure: FailureInfo, grep: string): Promise<{ findings?: RuntimeFinding[]; info: RuntimeInfo }> {
      const oldTrace = failure.tracePath ? path.resolve(root, failure.tracePath) : '';
      const old = oldTrace ? await recordFromFile(oldTrace) : null;
      if (!old || !old.steps.length) return { info: { checked: false, note: 'no trace from the failed run, so only the code was checked' } };
      const since = Date.now() - 2000;
      const r = await mcp.call('run-test', { testFiles: [failure.file], grep, args: ['--trace=on'], retries: 0, retryOnFailure: false, timeoutMs: 600_000 }, 660_000);
      const file = r.ok ? await findTrace(root, ['.'], since, failure.title) : null;
      const now = file ? await recordFromFile(file) : null;
      if (!now || !now.steps.length) return { info: { checked: false, note: 'the traced rerun left no readable trace, so only the code was checked' } };
      const findings = compareRuns(old, now);
      const checks = now.steps.filter((x) => x.kind === 'expect').length;
      const repeated = old.steps.filter((x) => x.kind === 'expect').length;
      const failedStep = old.failedAt !== undefined ? old.steps[old.failedAt] : undefined;
      const same = failedStep ? now.steps.filter((x) => x.title === failedStep.title && x.expected === failedStep.expected) : [];
      const match = same.find((x) => x.box);
      const info: RuntimeInfo = { checked: true, checks, repeated, ...(match?.box ? { box: match.box } : {}) };
      if (!findings.length) {
        // The fixed run found every element: remember them.
        const buf = await readTrace(file as string);
        if (buf) {
          try {
            addLearned(learn(domFromZip(buf), failure.file));
          } catch {
            // An unreadable snapshot only means nothing is learned.
          }
        }
      }
      if (!findings.length && options.evidenceDir) {
        const shots = await saveEvidence(oldTrace, file as string, same[0]?.end ?? now.steps.at(-1)?.end).catch(() => null);
        if (shots) info.evidence = shots;
      }
      log(`  runtime guard: ${findings.length ? `${findings.length} problem(s)` : `ok (${checks} assertion(s) ran, all ${repeated} from the failed run repeated)`}`);
      return { findings, info };
    }

    /** More stability runs while proving a flaky test's fix. */
    let repeatOverride: number | undefined;
    let shotCount = 0;
    /** Saves the failed run's screenshot and the fixed run's screenshot at the same step. */
    async function saveEvidence(oldTrace: string, newTrace: string, end: number | undefined): Promise<RuntimeInfo['evidence'] | null> {
      const dir = options.evidenceDir;
      if (!dir || shotCount >= 20) return null;
      const before = await failureScreenshot(root, path.relative(root, oldTrace));
      const after = await frameFromFile(newTrace, end);
      if (!before && !after) return null;
      const n = ++shotCount;
      await mkdir(dir, { recursive: true });
      const save = async (shot: Screenshot | null, label: string): Promise<string | undefined> => {
        if (!shot) return undefined;
        const name = `${n}-${label}.${shot.mediaType === 'image/png' ? 'png' : 'jpeg'}`;
        await writeFile(path.join(dir, name), Buffer.from(shot.data, 'base64'), { flag: 'wx' });
        return name;
      };
      const out: NonNullable<RuntimeInfo['evidence']> = {};
      const b = await save(before, 'before');
      const a = await save(after, 'after');
      if (b) out.before = b;
      if (a) out.after = a;
      const env = process.env;
      if (env.AUTOHEAL_EVIDENCE_ARTIFACT && /^[\w.-]{1,100}$/.test(env.AUTOHEAL_EVIDENCE_ARTIFACT)) out.artifact = env.AUTOHEAL_EVIDENCE_ARTIFACT;
      const own = ciInfo(env).selfUrl;
      if (own) out.url = own;
      return out;
    }

    async function verify(failure: FailureInfo, rel: string, content: string): Promise<VerifyOutcome> {
      const abs = safePath(root, rel);
      if (!abs) return { kept: false, blocked: false, message: 'Path not allowed.' };
      if (isProtected(policy, repoPath(rel))) return { kept: false, blocked: false, message: `${rel} is protected by ${POLICY_FILE}, so AutoHeal may not change it.` };
      const before = await readFile(abs, 'utf8');
      if (before === content) return { kept: false, blocked: false, message: 'The proposed content is identical to the current file.' };
      const weak = locatorChanges(before, content).find((c) => tooWeak(policy, c.to));
      if (weak) return { kept: false, blocked: false, message: `${POLICY_FILE} asks for locators that are at least ${policy?.fixes.minStrength}; \`${weak.after}\` is ${weak.to}.` };
      const local = scanChange(before, content, rel);
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
      const { runs, passed, detail } = await stableRuns(failure, grep);
      if (!passed) {
        await writeFile(abs, before);
        if (originals.get(rel) === before) originals.delete(rel);
        return { kept: false, blocked: false, guard, stability: { runs, passed: false, detail }, message: `The test still fails with this change:\n${detail}` };
      }
      return await afterStable(failure, rel, abs, before, guard, runs, grep);
    }

    /** The test passes `repeatEach` times in a row (pytest: up to 3 separate runs). */
    async function stableRuns(failure: FailureInfo, grep: string): Promise<{ runs: number; passed: boolean; detail: string }> {
      let passed = false;
      let detail = '';
      const want = repeatOverride ?? options.repeatEach;
      const runs = traceless ? Math.min(repeatOverride ? 5 : 3, want) : want;
      if (traceless) {
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
      return { runs, passed, detail };
    }

    /** After the stability rerun: the runtime guard, then the rest of the file and its importers. */
    async function afterStable(failure: FailureInfo, rel: string, abs: string, before: string, guard: GuardInfo, runs: number, grep: string): Promise<VerifyOutcome> {

      // Guard v2: one traced run of the fixed test, compared with the failed run's trace.
      const runtime: { findings?: RuntimeFinding[]; info: RuntimeInfo } = traceless
        ? { info: { checked: false, note: `the runtime check reads Playwright Test traces; ${framework} fixes are checked by code and reruns` } }
        : await runtimeCheck(failure, grep);
      if (runtime.findings?.length) {
        await writeFile(abs, before);
        if (originals.get(rel) === before) originals.delete(rel);
        const reasons = runtime.findings.map((f) => `BLOCK ${f.rule}: ${f.message}`).join('; ');
        log(`  runtime guard rejected a change to ${rel}: ${reasons}`);
        const blockedGuard: GuardInfo = { ...guard, findings: [...guard.findings, ...runtime.findings.map((f) => ({ severity: 'BLOCK' as const, rule: f.rule, message: f.message }))] };
        return { kept: false, blocked: true, guard: blockedGuard, stability: { runs, passed: true, detail: `passed ${runs}×` }, message: `Runtime guard: ${reasons}` };
      }
      const runtimeInfo = runtime.info;

      // The rest of the file must not get worse: only tests that were already
      // failing may fail. A change to a shared file (a page object or helper)
      // also reruns every spec that imports it.
      const importers = rel === failure.file ? [] : (await findImporters(root, rel)).filter((f) => f !== failure.file).slice(0, 50);
      const files = [failure.file, ...importers];
      const wholeMs = importers.length ? 1_200_000 : 600_000;
      const whole = await mcp.call('run-test', { testFiles: files, retries: 0, retryOnFailure: false, timeoutMs: wholeMs }, wholeMs + 60_000);
      const wholeRun = whole.data.run as { passed?: number; failures?: Array<{ title?: string }> } | undefined;
      const wholeFailures = (wholeRun?.failures ?? []).map((f) => String(f.title ?? ''));
      const allowedFailing = new Set(files.flatMap((f) => [...(failingTitlesByFile.get(f) ?? [])]));
      let broken = wholeFailures.filter((t) => t === failure.title || !allowedFailing.has(t) || fixedTitles.has(t));
      // A crash, or a run that lists no results, proves nothing: reject.
      if (!whole.ok && !wholeFailures.length) broken = [`the rerun failed without a test result (${whole.text.split('\n')[0]?.slice(0, 200) ?? 'no output'})`];
      else if (whole.ok && wholeRun && (wholeRun.passed ?? 0) === 0) broken = ['the rerun ran no tests'];
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
      const scope = importers.length ? `the rest of the file and ${importers.length} other spec(s) using ${rel}` : 'the rest of the file';
      return { kept: true, blocked: false, guard, stability: { runs, passed: true, detail: `passed ${runs}× and ${scope} did not get worse` }, runtime: runtimeInfo, message: 'kept' };
    }

    /** Where a locator is written: the failing spec, or one file it imports. Null when not exactly one file. */
    async function findLocator(failure: FailureInfo, loc: ParsedLocator): Promise<{ file: string; source: string; matches: RegExpMatchArray[]; pattern: RegExp } | null> {
      const spec = safePath(root, failure.file);
      if (!spec) return null;
      const specSource = await readFile(spec, 'utf8').catch(() => null);
      if (specSource === null) return null;
      const files = [failure.file, ...relativeImports(failure.file, specSource)];
      const found: Array<{ file: string; source: string; matches: RegExpMatchArray[]; pattern: RegExp }> = [];
      for (const file of [...new Set(files)]) {
        const abs = safePath(root, file);
        if (!abs) continue;
        const source = file === failure.file ? specSource : await readFile(abs, 'utf8').catch(() => null);
        if (source === null) continue;
        const pattern = sourcePattern(loc, file.endsWith('.py'));
        const matches = [...source.matchAll(pattern)];
        if (matches.length) found.push({ file, source, matches, pattern });
      }
      return found.length === 1 ? (found[0] as (typeof found)[number]) : null;
    }

    /** Replaces every copy of the old locator in that one file with the new one. */
    function replaceLocator(at: { file: string; source: string; matches: RegExpMatchArray[]; pattern: RegExp }, loc: ParsedLocator): { next: string; before: string; after: string } | null {
      const first = at.matches[0] as RegExpMatchArray;
      const quote = first[1] ?? "'";
      const after = renderLocator(loc, at.file.endsWith('.py'), quote);
      if (after === first[0]) return null;
      const next = at.source.replace(at.pattern, after);
      return next === at.source ? null : { next, before: first[0], after };
    }

    function savedFor(dom: TraceDom | undefined): FingerprintEntry | undefined {
      const call = dom?.failedCall;
      if (!call?.selector) return undefined;
      return lookup([...savedFingerprints, ...learned.values()], call.selector, call.page);
    }

    function matchFor(failure: FailureInfo, dom: TraceDom | undefined): { saved: FingerprintEntry; match: Match } | null {
      const saved = savedFor(dom);
      if (!saved || !dom?.failedPage || !dom.failedCall) return null;
      const match = bestMatch(saved.fingerprint, elements(dom.failedPage.root), {
        action: dom.failedCall.method !== 'expect',
        ...(dom.failedCall.method === 'expect' && failure.expected !== undefined ? { expected: failure.expected.replace(/^"|"$/g, '') } : {}),
      });
      return match ? { saved, match } : null;
    }

    /** The one file (spec or a page object it imports) that uses this Cypress selector. */
    async function cypressFind(failure: FailureInfo, selector: string): Promise<{ file: string; source: string } | null> {
      const spec = safePath(root, failure.file);
      if (!spec) return null;
      const specSource = await readFile(spec, 'utf8').catch(() => null);
      if (specSource === null) return null;
      const found: Array<{ file: string; source: string }> = [];
      for (const file of [...new Set([failure.file, ...relativeImports(failure.file, specSource)])]) {
        const abs = safePath(root, file);
        if (!abs) continue;
        const source = file === failure.file ? specSource : await readFile(abs, 'utf8').catch(() => null);
        if (source !== null && cypressPattern(selector).test(source)) found.push({ file, source });
      }
      return found.length === 1 ? (found[0] as { file: string; source: string }) : null;
    }

    /** Cypress: the element found again from its fingerprint, as a cy.get selector. */
    async function cypressProposal(failure: FailureInfo, dom: TraceDom | undefined): Promise<Proposal | null> {
      const found = matchFor(failure, dom);
      const old = dom?.failedCall?.selector;
      if (!found || !dom?.failedPage || !old) return null;
      const sel = cypressSelectorFor(found.match.element, dom.failedPage.root);
      if (!sel || sel === old) return null;
      const at = await cypressFind(failure, old);
      const change = at ? replaceCypressSelector(at.source, old, sel) : null;
      if (!at || !change) return null;
      const signals = found.match.signals.join(', ') || 'role and position';
      log(`  fingerprint: ${change.before} → ${change.after} (match ${Math.round(found.match.score * 100)}%: ${signals})`);
      const p: Proposal = {
        by: 'fingerprint',
        file: at.file,
        current: at.source,
        next: change.next,
        before: change.before,
        after: change.after,
        why: `The element this selector found before (saved ${found.saved.at.slice(0, 10)}) is still on the page with the same ${signals}; the new selector finds it again.`,
        match: { score: found.match.score, signals: found.match.signals },
        cySelector: sel,
      };
      proposals.set(failure.index, p);
      return p;
    }

    /** A fix from the element's saved fingerprint, found again on the failed page. */
    async function fingerprintProposal(failure: FailureInfo, dom: TraceDom | undefined): Promise<Proposal | null> {
      if (framework === 'cypress') return cypressProposal(failure, dom);
      const found = matchFor(failure, dom);
      if (!found || !dom?.failedPage || !dom.failedCall?.selector) return null;
      const old = parseSelector(dom.failedCall.selector);
      const loc = locatorFor(found.match.element, dom.failedPage.root);
      if (!old || !loc) return null;
      const at = await findLocator(failure, old);
      const change = at ? replaceLocator(at, loc) : null;
      if (!at || !change) return null;
      const signals = found.match.signals.join(', ') || 'role and position';
      log(`  fingerprint: ${change.before} → ${change.after} (match ${Math.round(found.match.score * 100)}%: ${signals})`);
      const p: Proposal = {
        by: 'fingerprint',
        file: at.file,
        current: at.source,
        next: change.next,
        before: change.before,
        after: change.after,
        why: `The element this locator found before (saved ${found.saved.at.slice(0, 10)}) is still on the page with the same ${signals}; the new locator finds it again.`,
        match: { score: found.match.score, signals: found.match.signals },
        locator: loc,
      };
      proposals.set(failure.index, p);
      return p;
    }

    /** What the fingerprint says, for the AI when no deterministic fix was kept. */
    function fingerprintHint(failure: FailureInfo, dom: TraceDom | undefined): string {
      const saved = savedFor(dom);
      if (!saved) return '';
      const found = matchFor(failure, dom);
      const loc = found && dom?.failedPage ? locatorFor(found.match.element, dom.failedPage.root) : null;
      const what = JSON.stringify(saved.fingerprint);
      if (framework === 'cypress') {
        const sel = found && dom?.failedPage ? cypressSelectorFor(found.match.element, dom.failedPage.root) : null;
        return sel
          ? `- Element fingerprint for the broken selector (saved ${saved.at.slice(0, 10)}): ${what}. Best match on the failed page: cy.get('${sel}').`
          : `- Element fingerprint for the broken selector (saved ${saved.at.slice(0, 10)}): ${what}. No element on the failed page matched it clearly.`;
      }
      return loc
        ? `- Element fingerprint for the broken locator (saved ${saved.at.slice(0, 10)}): ${what}. Best match on the failed page: ${renderLocator(loc, failure.file.endsWith('.py'))}.`
        : `- Element fingerprint for the broken locator (saved ${saved.at.slice(0, 10)}): ${what}. No element on the failed page matched it clearly.`;
    }

    /** The engine's one-line locator fix, as a proposal. */
    async function engineProposal(fix: DryFix): Promise<Proposal | null> {
      const abs = safePath(root, fix.file);
      if (!abs) return null;
      const current = await readFile(abs, 'utf8').catch(() => null);
      if (current === null) return null;
      const lines = current.split('\n');
      const idx = fix.line - 1;
      const line = lines[idx];
      const cr = line?.endsWith('\r') ? '\r' : '';
      if (line === undefined || line.slice(0, line.length - cr.length) !== fix.before.replace(/\r$/, '')) return null;
      lines[idx] = `${fix.after.replace(/\r$/, '')}${cr}`;
      const after = locatorChanges(fix.before, fix.after)[0]?.after ?? fix.after.trim();
      return { by: 'rules', file: fix.file, current, next: lines.join('\n'), before: fix.before.trim(), after, why: fix.why || 'Replaced the locator with one verified against the page in the trace.' };
    }

    const SUMMARY: Record<FixInfo['by'], string> = {
      rules: "Fixed with the engine's verified locator; no AI tokens used.",
      fingerprint: "Fixed by finding the element again from its saved fingerprint; no AI tokens used.",
      'same-change': 'Fixed by the same change as another test that this UI change broke; no AI tokens used.',
      ai: 'Fixed by the AI agent and proven by the stability rerun.',
      baseline: 'Screenshot baseline updated after an intended UI change; no AI tokens used.',
    };

    /** Verifies one proposal and fills in the result. True when it was kept. */
    /** Why the policy does not allow another fix of this kind, if it doesn't. */
    function notAllowed(by: FixInfo['by']): string | undefined {
      if (!policy) return undefined;
      if (!policy.fixes.allow.includes(by)) return `${POLICY_FILE} does not allow ${by === 'ai' ? 'AI' : by} fixes (fixes.allow)`;
      const max = policy.fixes.maxPerPr;
      if (max !== undefined && summary.results.filter((r) => r.status === 'FIXED').length >= max) return `${POLICY_FILE} allows at most ${max} fix${max === 1 ? '' : 'es'} per PR (fixes.max-per-pr)`;
      return undefined;
    }

    async function attempt(failure: FailureInfo, result: FailureResult, p: Proposal): Promise<boolean> {
      const denied = notAllowed(p.by);
      if (denied) {
        log(`  skipped a ${p.by} fix: ${denied}`);
        if (!result.reasons.includes(denied)) result.reasons = [...result.reasons, denied];
        return false;
      }
      const no = rejected(options.reviews, p.file, p.before, p.after);
      if (no) {
        log(`  skipped: reviewers closed the same change in PR #${no.pr}`);
        result.reasons = [...result.reasons, `the same change (${p.before} → ${p.after}) was closed without merging in PR #${no.pr}, so it was not proposed again`];
        return false;
      }
      const outcome = await verify(failure, p.file, p.next);
      if (outcome.guard) result.guard = outcome.guard;
      if (outcome.stability) result.stability = outcome.stability;
      if (outcome.runtime) result.runtime = outcome.runtime;
      if (outcome.kept) {
        result.status = 'FIXED';
        const fix: FixInfo = { by: p.by, file: p.file, explanation: p.why, diff: shortDiff(p.file, p.current, p.next) };
        if (p.before !== undefined) fix.before = p.before;
        if (p.after !== undefined) fix.after = p.after;
        const locs = locatorChanges(p.current, p.next);
        if (locs.length) fix.locators = locs;
        if (p.match) fix.match = p.match;
        if (p.sameAs) fix.sameAs = p.sameAs;
        result.fix = fix;
        result.summary = SUMMARY[p.by];
        proposals.set(failure.index, p);
        return true;
      }
      if (outcome.blocked) {
        result.status = 'BLOCKED_CHEATING';
        result.summary = outcome.message;
      }
      return false;
    }

    /**
     * Another test with the same broken locator was already fixed. If that fix
     * was in a shared file, this test may pass already: prove it. Otherwise
     * make the same locator change in this test's file.
     */
    async function sameChange(failure: FailureInfo, result: FailureResult, move: Move): Promise<boolean> {
      const denied = notAllowed('same-change');
      if (denied) {
        if (!result.reasons.includes(denied)) result.reasons = [...result.reasons, denied];
        return false;
      }
      if (framework === 'cypress') {
        const at = await cypressFind(failure, move.selector);
        if (at && move.cySelector) {
          const change = replaceCypressSelector(at.source, move.selector, move.cySelector);
          if (!change) return false;
          log(`  same UI change as "${move.title}": ${change.before} → ${change.after}`);
          return attempt(failure, result, {
            by: 'same-change',
            file: at.file,
            current: at.source,
            next: change.next,
            before: change.before,
            after: change.after,
            why: `The same UI change broke "${move.title}"; this makes the same selector change.`,
            sameAs: move.title,
            cySelector: move.cySelector,
          });
        }
        if (at) return false;
      }
      const old = framework === 'cypress' ? null : parseSelector(move.selector);
      const at = old ? await findLocator(failure, old) : null;
      if (at && move.locator) {
        const change = replaceLocator(at, move.locator);
        if (!change) return false;
        log(`  same UI change as "${move.title}": ${change.before} → ${change.after}`);
        return attempt(failure, result, {
          by: 'same-change',
          file: at.file,
          current: at.source,
          next: change.next,
          before: change.before,
          after: change.after,
          why: `The same UI change broke "${move.title}"; this makes the same locator change.`,
          sameAs: move.title,
          locator: move.locator,
        });
      }
      if (at) return false; // the old locator is still here and the kept fix cannot be replayed: let the other fixes try
      const grep = escapeRegex(lastTitle(failure.title));
      const st = await stableRuns(failure, grep);
      result.stability = st;
      if (!st.passed) return false;
      const runtime = traceless ? null : await runtimeCheck(failure, grep);
      if (runtime?.info) result.runtime = runtime.info;
      if (runtime?.findings?.length) return false;
      log(`  fixed by the change for "${move.title}" (${move.file})`);
      result.status = 'FIXED';
      result.fix = { by: 'same-change', file: move.file, explanation: `The fix for "${move.title}" in \`${move.file}\` fixes this test too; this test's own files did not change.`, diff: move.diff, sameAs: move.title };
      result.summary = SUMMARY['same-change'];
      return true;
    }

    const proposals = new Map<number, Proposal>();

    /**
     * A screenshot comparison failed. If app files changed since the baseline
     * was last committed, the UI changed on purpose: update the baseline and
     * prove the test now passes repeatedly. Otherwise it is an unexplained
     * visual difference: an app bug, with no change to the test.
     */
    async function visualCheck(failure: FailureInfo, result: FailureResult): Promise<boolean> {
      const snapDir = `${failure.file}-snapshots`;
      const snapAbs = safePath(root, snapDir);
      const names = snapAbs ? (await readdir(snapAbs).catch(() => [] as string[])).filter((n) => n.endsWith('.png')).slice(0, 200) : [];
      const why = await visualIntent(root, snapDir);
      result.visual = { intended: why.intended, commits: why.commits, baselines: [] };
      if (!why.intended || !names.length || !snapAbs) {
        result.category = 'APP_BUG';
        result.rootCause = 'REGRESSION';
        result.status = 'APP_BUG';
        result.reasons = [...result.reasons, why.note];
        result.summary = `The page looks different from the screenshot baseline, and ${why.note}. The baseline was not changed; an issue with the evidence is opened instead.`;
        return false;
      }
      result.category = 'TEST_BUG';
      result.rootCause = 'VISUAL_CHANGE';
      result.reasons = [...result.reasons, `app changes since the baseline: ${why.commits.slice(0, 3).join('; ')}`];
      const denied = notAllowed('baseline');
      if (denied || options.mode === 'comment') {
        result.summary = `The UI changed on purpose (${why.commits[0]}), so the screenshot baseline is out of date. ${denied ? `Not updated: ${denied}.` : 'Comment mode: run `npx playwright test --update-snapshots ' + failure.file + '` to update it.'}`;
        if (denied) result.reasons = [...result.reasons, denied];
        return false;
      }
      const before = new Map<string, Buffer>();
      for (const n of names) {
        const b = await readFile(path.join(snapAbs, n)).catch(() => null);
        if (b) before.set(n, b);
      }
      const grep = escapeRegex(lastTitle(failure.title));
      log(`  visual: intended UI change (${why.commits[0]}); updating the baseline`);
      await mcp.call('run-test', { testFiles: [failure.file], grep, args: ['--update-snapshots'], retries: 0, retryOnFailure: false, timeoutMs: 600_000 }, 660_000);
      const changed: string[] = [];
      for (const n of (await readdir(snapAbs).catch(() => [] as string[])).filter((x) => x.endsWith('.png'))) {
        const now = await readFile(path.join(snapAbs, n)).catch(() => null);
        const old = before.get(n);
        if (!old) {
          await rm(path.join(snapAbs, n), { force: true }); // only existing baselines are updated
          continue;
        }
        if (now && !now.equals(old)) changed.push(n);
      }
      const restore = async () => {
        for (const [n, b] of before) await writeFile(path.join(snapAbs, n), b);
      };
      if (!changed.length) {
        await restore();
        result.summary = 'The UI changed on purpose, but updating the baseline changed nothing, so nothing was kept.';
        return false;
      }
      const st = await stableRuns(failure, grep);
      result.stability = st;
      if (!st.passed) {
        await restore();
        result.summary = `The UI changed on purpose, but the test still fails with an updated baseline:\n${st.detail}`;
        return false;
      }
      for (const n of changed) binaryOriginals.set(`${snapDir}/${n}`, before.get(n) as Buffer);
      result.visual.baselines = changed.map((n) => `${snapDir}/${n}`);
      // The old and new baseline, side by side in the PR.
      if (options.evidenceDir && shotCount < 20) {
        const first = changed[0] as string;
        const now = await readFile(path.join(snapAbs, first)).catch(() => null);
        const old = before.get(first);
        if (now && old && now.length <= 1_500_000 && old.length <= 1_500_000) {
          const n = ++shotCount;
          await mkdir(options.evidenceDir, { recursive: true });
          await writeFile(path.join(options.evidenceDir, `${n}-before.png`), old, { flag: 'wx' });
          await writeFile(path.join(options.evidenceDir, `${n}-after.png`), now, { flag: 'wx' });
          result.visual.evidence = { before: `${n}-before.png`, after: `${n}-after.png` };
        }
      }
      result.status = 'FIXED';
      result.fix = {
        by: 'baseline',
        file: `${snapDir}/${changed[0]}`,
        explanation: `The app changed on purpose since this baseline was saved (${why.commits.slice(0, 3).join('; ')}). The baseline was updated and the test passed ${st.runs} times in a row with it.`,
        diff: changed.map((n) => `Binary: ${snapDir}/${n} (updated)`).join('\n'),
      };
      result.summary = 'Screenshot baseline updated after an intended UI change; proven by the stability rerun. No AI tokens used.';
      return true;
    }

    /**
     * A flaky test: ask the AI for the race and a deterministic fix, proven by
     * twice the usual stability runs (at least 10). Otherwise it is quarantined.
     */
    async function flakyFix(failure: FailureInfo, result: FailureResult, t: Triage): Promise<boolean> {
      if (!provider || options.mode === 'comment' || options.fixFlaky === false || notAllowed('ai')) return false;
      log('  flaky: asking the AI for a deterministic fix before quarantining');
      repeatOverride = Math.max(options.repeatEach * 2, 10);
      try {
        const agent = await aiFix({
          mcp,
          provider,
          projectRoot: root,
          failure,
          triage: t,
          memory: [
            'This test is FLAKY: it passes and fails on the same code. Find the race (an action before the page is ready, timing, animation, test order or shared data) and make the test deterministic by waiting for the right state with web-first assertions. Never add retries, sleeps, longer timeouts or skips, and never loosen an assertion.',
            memoryText(relevantMemory(memory, failure.file)),
            policy?.protect.length ? `${POLICY_FILE} protects these paths (relative to the repository root); never change files there: ${policy.protect.join(', ')}` : '',
          ].filter(Boolean).join('\n'),
          budget,
          ...(options.appUrl ? { appUrl: options.appUrl } : {}),
          ...(session ? { session } : {}),
          screenshot: null,
          framework,
          verify: (file, content) => verify(failure, file, content),
        });
        if (agent.guard) result.guard = agent.guard;
        if (agent.stability) result.stability = agent.stability;
        if (agent.runtime) result.runtime = agent.runtime;
        if (agent.result === 'fixed' && agent.file && agent.before !== undefined && agent.after !== undefined) {
          result.status = 'FIXED';
          result.rootCause = 'TIMING';
          result.fix = { by: 'ai', file: agent.file, explanation: agent.explanation, diff: shortDiff(agent.file, agent.before, agent.after) };
          const locs = locatorChanges(agent.before, agent.after);
          if (locs.length) result.fix.locators = locs;
          result.summary = `Flaky test fixed, not quarantined: the fix passed ${result.stability?.runs ?? repeatOverride} runs in a row and the anti-cheat guard.`;
          return true;
        }
        result.reasons = [...result.reasons, `AI flaky fix: ${agent.explanation || agent.result}`];
        return false;
      } finally {
        repeatOverride = undefined;
      }
    }

    const canFixFlaky = (): boolean => Boolean(provider) && options.mode !== 'comment' && options.fixFlaky !== false && !notAllowed('ai');
    const deferredFlaky: Array<{ failure: FailureInfo; result: FailureResult; t: Triage }> = [];

    /** A flaky test with no deterministic fix: quarantined (or only reported). */
    async function quarantineFlaky(failure: FailureInfo, result: FailureResult, t: Triage): Promise<void> {
      if (options.mode === 'comment') {
        result.status = 'FLAKY';
        result.summary = 'Flaky: passes and fails on the same code. Comment mode, so it was not quarantined.';
      } else if (policy && !policy.quarantine.enabled) {
        result.status = 'FLAKY';
        result.summary = `Flaky: passes and fails on the same code. ${POLICY_FILE} turns quarantine off, so it was not quarantined.`;
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
    }

    /** One heal from the run, as a proven change to the code. */
    async function healedFix(entry: HealedEntry, index: number): Promise<void> {
      const old = parseSelector(entry.selector);
      const failure: FailureInfo = { index, file: entry.file, title: entry.title, kind: 'healed', message: `healed during the run: ${entry.code}`, detail: '' };
      const { detail: _d, ...lite } = failure;
      const result: FailureResult = {
        failure: lite,
        category: 'TEST_BUG',
        rootCause: 'LOCATOR_DRIFT',
        confidence: entry.score,
        reasons: [`healed during the run (${entry.action}, match ${Math.round(entry.score * 100)}%: ${entry.signals.join(', ') || 'role and position'})`],
        status: 'UNFIXED',
        summary: '',
        spend: EMPTY_SNAPSHOT,
        healed: true,
      };
      if (!old || !safePath(root, entry.file)) return;
      const at = await findLocator(failure, old);
      const change = at ? replaceLocator(at, entry.locator) : null;
      if (!at || !change) {
        log(`Healed locator in ${entry.file} › ${entry.title}: the old locator is not written in one place, so no code change`);
        return;
      }
      log(`Healed during the run: ${entry.file} › ${entry.title}: ${change.before} → ${change.after}`);
      const kept = await attempt(failure, result, {
        by: 'fingerprint',
        file: at.file,
        current: at.source,
        next: change.next,
        before: change.before,
        after: change.after,
        why: `The test passed only because AutoHeal found this element again during the run (match ${Math.round(entry.score * 100)}%). This writes the healed locator into the code, so the next run passes without healing.`,
        match: { score: entry.score, signals: entry.signals },
        locator: entry.locator,
      });
      if (kept) {
        result.summary = 'Healed during the run, and now fixed in the code; proven with runtime healing off. No AI tokens used.';
        fixedTitles.add(failure.title);
      } else if (result.status !== 'BLOCKED_CHEATING') {
        result.summary = result.summary || 'Healed during the run, but the healed locator did not pass every check on its own, so the code was not changed.';
      }
      summary.results.push(result);
    }

    // 3–5. One failure at a time.
    for (const [position, failure] of work.entries()) {
      budget.share(work.length - position);
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
      // Visual grounding: the page as it was when the test failed, read from the run's own artifacts.
      const screenshot =
        provider && visionEnabled(provider.name)
          ? failure.tracePath
            ? await failureScreenshot(root, failure.tracePath)
            : await screenshotFile(root, failure.screenshotPath)
          : null;
      if (screenshot) {
        failure.screenshot = screenshot.source;
        log(`  screenshot: ${screenshot.source} (${screenshot.width ?? '?'}×${screenshot.height ?? '?'})`);
      }
      if (provider && t.confidence < 0.6 && t.category !== 'FLAKY') t = await aiTriage(provider, budget, failure, t, screenshot);
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
      const past = historyOf(options.history, failure.file, failure.title);
      if (past) result.history = past;

      if (framework === 'playwright' && isVisualFailure(failure)) {
        if (await visualCheck(failure, result)) fixedTitles.add(failure.title);
      } else if (t.category === 'TEST_BUG') {
        let fixed = false;
        const dom = doms.get(failure.index);
        const broken = dom?.failedCall?.selector;
        // 4a. The same UI change already fixed another test: reuse that fix (no AI tokens).
        const move = broken ? moves.get(broken) : undefined;
        if (move) fixed = await sameChange(failure, result, move);
        // 4b. Deterministic fixes: the element's saved fingerprint, and the engine's
        // verified locator. The stronger locator (Playwright's ranking) goes first.
        if (!fixed && t.rootCause === 'LOCATOR_DRIFT') {
          const candidates: Proposal[] = [];
          const fp = await fingerprintProposal(failure, dom);
          if (fp) candidates.push(fp);
          const ruled = dry && dry.kind === 'locator' ? await engineProposal(dry) : null;
          if (ruled) candidates.push(ruled);
          candidates.sort((a, b) => rankOf(a.after ?? '') - rankOf(b.after ?? ''));
          for (const p of candidates) {
            if (await attempt(failure, result, p)) {
              fixed = true;
              break;
            }
          }
        } else if (!fixed && dry && dry.kind === 'locator') {
          const ruled = await engineProposal(dry);
          if (ruled) fixed = await attempt(failure, result, ruled);
        }
        // 4c. The AI agent.
        const aiDenied = !fixed && provider ? notAllowed('ai') : undefined;
        if (aiDenied) {
          result.reasons = [...result.reasons, aiDenied];
          if (result.status !== 'BLOCKED_CHEATING') result.summary = `No deterministic fix applied, and ${aiDenied}.`;
        } else if (!fixed && provider) {
          const hint = fingerprintHint(failure, dom);
          const agent = await aiFix({
            mcp,
            provider,
            projectRoot: root,
            failure,
            triage: t,
            memory: [memoryText(relevantMemory(memory, failure.file)), hint, options.reviews ? reviewText(options.reviews, failure.file) : '', policy?.protect.length ? `${POLICY_FILE} protects these paths (relative to the repository root); never change files there: ${policy.protect.join(', ')}` : ''].filter(Boolean).join('\n'),
            budget,
            ...(options.appUrl ? { appUrl: options.appUrl } : {}),
          ...(session ? { session } : {}),
            screenshot,
            framework,
            verify: (file, content) => verify(failure, file, content),
          });
          if (agent.guard) result.guard = agent.guard;
          if (agent.stability) result.stability = agent.stability;
          if (agent.runtime) result.runtime = agent.runtime;
          if (agent.result === 'fixed' && agent.file && agent.before !== undefined && agent.after !== undefined) {
            fixed = true;
            result.status = 'FIXED';
            const fix: FixInfo = { by: 'ai', file: agent.file, explanation: agent.explanation, diff: shortDiff(agent.file, agent.before, agent.after) };
            const locs = locatorChanges(agent.before, agent.after);
            if (locs.length) fix.locators = locs;
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
          const declined = result.reasons.find((r) => r.includes('was closed without merging in PR #'));
          result.summary = declined
            ? 'A fix was found, but reviewers already closed the same change once, so it was not proposed again. Fix the test by hand, or reopen that PR if closing it was a mistake.'
            : 'This looks like a test problem, but no deterministic fix applied and no AI key is set (ANTHROPIC_API_KEY, OPENAI_API_KEY or AUTOHEAL_BASE_URL).';
        }
        if (fixed) {
          fixedTitles.add(failure.title);
          if (broken && result.fix && !moves.has(broken)) {
            const lastProposal = proposals.get(failure.index);
            moves.set(broken, {
              selector: broken,
              title: failure.title,
              file: result.fix.file,
              diff: result.fix.diff,
              ...(result.fix.by === 'fingerprint' && lastProposal?.locator ? { locator: lastProposal.locator } : {}),
              ...(lastProposal?.cySelector ? { cySelector: lastProposal.cySelector } : {}),
            });
          }
        }
      } else if (t.category === 'FLAKY' && canFixFlaky()) {
        // Fixed after the other failures, so the AI budget goes to real breaks first.
        deferredFlaky.push({ failure, result, t });
      } else if (t.category === 'FLAKY') {
        await quarantineFlaky(failure, result, t);
      } else if (t.category === 'APP_BUG') {
        result.status = 'APP_BUG';
        result.summary = 'The test looks right and the app looks wrong, so the test was not changed. An issue with the evidence is opened instead.';
      } else if (flakyVerdict === 'NOT REPRODUCING') {
        result.status = 'ENV';
        result.summary =
          "AutoHeal couldn't reproduce this failure: it passed every rerun here. Make the heal job match your test job (Node or Python version, browsers, environment variables, secrets, services and test data). Nothing was changed and nothing was quarantined.";
      } else {
        result.status = 'ENV';
        result.summary = 'The failure comes from the environment (browser, server, network or config), not the test. Nothing was changed.';
      }

      result.spend = deltaSnapshot(budget.snapshot(), spentBefore);
      summary.results.push(result);
    }

    for (const { failure, result, t } of deferredFlaky) {
      log(`Failure ${failure.index}: ${failure.file} › ${failure.title} (flaky)`);
      const spentBefore = budget.snapshot();
      if (await flakyFix(failure, result, t)) fixedTitles.add(failure.title);
      else await quarantineFlaky(failure, result, t);
      result.spend = deltaSnapshot(budget.snapshot(), spentBefore);
    }

    // One UI change, one fix: failures past max-failures that the same broken
    // locator caused get the kept fix too (no AI tokens, still proven by reruns).
    for (const failure of ordered.slice(work.length)) {
      const broken = doms.get(failure.index)?.failedCall?.selector;
      const move = broken ? moves.get(broken) : undefined;
      if (!move) {
        // The same wrong value as an app bug already found: the same bug, no tokens spent.
        const leader = leaders.get(groupOf(failure));
        const led = leader && leader !== failure ? summary.results.find((r) => r.failure.index === leader.index) : undefined;
        if (leader && led?.status === 'APP_BUG' && groupOf(failure).startsWith('value:')) {
          const { detail: _x, ...lite } = failure;
          summary.results.push({
            failure: lite,
            category: 'APP_BUG',
            rootCause: led.rootCause,
            confidence: led.confidence,
            reasons: [`the same wrong value as "${leader.title}"`],
            status: 'APP_BUG',
            summary: `The same app bug as "${leader.title}" (same expected and received values), so it was not looked at again.`,
            spend: EMPTY_SNAPSHOT,
            groupOf: leader.title,
          });
          summary.skippedFailures--;
        }
        continue;
      }
      log(`Failure ${failure.index}: ${failure.file} › ${failure.title} (same broken locator as "${move.title}")`);
      const spentBefore = budget.snapshot();
      const { detail: _d, ...failureLite } = failure;
      const result: FailureResult = {
        failure: failureLite,
        category: 'TEST_BUG',
        rootCause: 'LOCATOR_DRIFT',
        confidence: 0.9,
        reasons: [`the same locator broke as in "${move.title}", which was fixed`],
        status: 'UNFIXED',
        summary: '',
        spend: EMPTY_SNAPSHOT,
      };
      if (await sameChange(failure, result, move)) {
        fixedTitles.add(failure.title);
        result.spend = deltaSnapshot(budget.snapshot(), spentBefore);
        summary.results.push(result);
        summary.skippedFailures--;
      }
    }

    // Heals made during the run become code fixes, proven like any other fix:
    // with runtime healing off, the new locator must pass on its own.
    for (const [i, entry] of healedEntries.slice(0, 50).entries()) {
      if (options.mode === 'comment' && i >= 20) break;
      await healedFix(entry, 1000 + i);
    }

    // 6. Whole-tree heal guard over everything this job changed.
    const specFiles = [...originals.keys()].filter((f) => f !== 'playwright-quarantine.json');
    if (specFiles.length && (await isGitRepo(root))) {
      const final = await mcp.call('check-test-change', { base: 'HEAD', files: specFiles, runtime: !traceless }, 900_000);
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

    // Find the cause: the app commit behind each fix and each app bug.
    if (await isGitRepo(root)) {
      const found = new Map<string, Cause | null>();
      const lookupCause = async (q: CauseQuery): Promise<Cause | null> => {
        if (!q.removed.length && !q.added.length) return null;
        const k = JSON.stringify(q);
        if (!found.has(k)) found.set(k, await findCause(root, q).catch(() => null));
        return found.get(k) ?? null;
      };
      for (const r of summary.results) {
        const q = r.status === 'FIXED' && r.fix?.locators?.length ? termsFromLocators(r.fix.locators) : r.status === 'APP_BUG' ? termsFromValues(r.failure.expected, r.failure.actual) : null;
        const cause = q ? await lookupCause(q) : null;
        if (cause) {
          r.cause = cause;
          log(`Cause of "${r.failure.title}": ${cause.short} ${cause.subject}`);
        }
      }
      // A test fixed by the same change has the same cause.
      for (const r of summary.results) {
        if (r.cause || !r.fix?.sameAs) continue;
        const first = summary.results.find((x) => x.failure.title === r.fix?.sameAs);
        if (first?.cause) r.cause = first.cause;
      }
    }

    // Repo memory for kept fixes.
    if (options.mode !== 'comment') {
      const kept = summary.results.filter((r) => r.status === 'FIXED');
      for (const r of kept) {
        const before = r.fix?.before;
        const after = r.fix?.after;
        const rel = memoryEntryPath({ file: r.failure.file, test: r.failure.title, ...(after !== undefined ? { after } : {}) });
        if (!originals.has(rel)) {
          const abs = path.join(root, rel);
          originals.set(rel, (await exists(abs)) ? await readFile(abs, 'utf8') : NEW_FILE);
        }
        const written = await remember(root, {
          file: r.failure.file,
          test: r.failure.title,
          rootCause: r.rootCause,
          ...(before !== undefined ? { before } : {}),
          ...(after !== undefined ? { after } : {}),
          note: r.fix?.explanation ?? '',
        });
        if (written !== rel) throw new Error(`memory path mismatch: ${written} vs ${rel}`);
      }
    }

    // Element fingerprints learned from this run's traces, saved with the fixes.
    if (options.mode !== 'comment' && summary.results.some((r) => r.status === 'FIXED')) {
      const same = (a: FingerprintEntry, b: FingerprintEntry | undefined) => !!b && JSON.stringify(a.fingerprint) === JSON.stringify(b.fingerprint);
      const byPath = new Map(savedFingerprints.map((e) => [fingerprintPath(e.selector, e.page), e]));
      const fresh = [...learned.entries()].filter(([rel, e]) => !same(e, byPath.get(rel))).map(([, e]) => e);
      for (const e of fresh) {
        const rel = fingerprintPath(e.selector, e.page);
        if (!originals.has(rel)) {
          const abs = path.join(root, rel);
          originals.set(rel, (await exists(abs)) ? await readFile(abs, 'utf8') : NEW_FILE);
        }
      }
      const written = await saveFingerprints(root, fresh);
      if (written.length) summary.fingerprints = written.length;
    }

    // Comment mode never leaves changes behind; the diffs are in the comment.
    if (options.mode === 'comment') await revertAll();

    summary.changedFiles = [...originals.keys(), ...binaryOriginals.keys()].sort();
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
    // The session holds live cookies: never leave one this job made in the checkout.
    if (session && sessionMade) await rm(path.join(root, session), { force: true }).catch(() => undefined);
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
