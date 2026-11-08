#!/usr/bin/env node
/**
 * autoheal: command line for the heal job, the dashboard upload and the
 * self-hosted dashboard.
 */

import { realpathSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { commentBody, issueBody, issueTitle, jobSummary, prBody } from './evidence.js';
import { heal } from './heal.js';
import { priceFor } from './budget.js';
import { ConfigError, providerFromEnv } from './providers/index.js';
import { redactDeep } from './redact.js';
import { findReport } from './report-files.js';
import type { HealSummary, Mode } from './types.js';
import { eventsFrom, uploadEvents } from './upload.js';
import { chooseSandbox, sandboxMode } from './sandbox.js';
import { checkAppUrl, startApp, type StartedApp } from './app.js';
import { saveFingerprints } from './fingerprints.js';
import { reviewHistory, type ReviewHistory } from './reviews.js';
import { loadPolicy, policyText, PolicyError, POLICY_FILE, tighten, type Policy } from './policy.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { checksText, doctor, init, type SetupCi } from './setup.js';
import { fingerprintsFromCypress, fingerprintsFromTraces, runTests, testRun, writeLearned } from './local.js';
import { isPytestProject } from './heal.js';
import { VERSION } from './version.js';
import { collectMetrics, metricsMarkdown } from './metrics.js';
import { frameworkSetting, isCypressProject } from './cypress.js';
import { ciInfo, ciLabel, isAutohealBranch } from './ci.js';
import { prepareSandbox } from './sandbox.js';
import { fetchLearned, LEARNED_DIR } from './learned.js';

export const USAGE = `autoheal ${VERSION}: free, self-hosted AI agent that fixes failing Playwright,
pytest-playwright and Cypress tests, in GitHub Actions, GitLab CI, CircleCI or on your machine.
(npm package: xsignon-autoheal · command: autoheal · npx xsignon-autoheal <command> works too)

Start here:
  autoheal init [--ci github|gitlab|circleci] [--force] [--dry-run]
                         write the AutoHeal workflow for your CI and check your setup
  autoheal doctor        check this project and machine, with a fix for each problem
  autoheal fix [--report <dir>] [--allow-dirty]
                         on your machine: run the tests, fix what broke, leave the
                         changes in your working tree for you to review (no commit)
  autoheal learn [--out .autoheal-learned] [--traces <dir>]
                         run the tests once with traces on and save element
                         fingerprints, so a broken locator is fixed without AI

In CI (the templates call these):
  autoheal heal --report <path|run URL> [options]
  autoheal package <heal-out-dir> <result-dir>
  autoheal publish [--result autoheal-result]
                         open the fix PR (GitHub) or merge request (GitLab); needs
                         AUTOHEAL_GITHUB_TOKEN / GH_TOKEN or AUTOHEAL_GITLAB_TOKEN

Other:
  autoheal fingerprint --traces <dir> [--project <dir>]
  autoheal upload --summary <summary.json> [--pr-url URL] [--issues issues.json]
  autoheal metrics [--repo owner/name] [--days 30] [--project <dir>] [--json <file>]
  autoheal dashboard [--port 8080] [--host 0.0.0.0] [--db autoheal.db]
  autoheal --version

heal options (each also reads the AUTOHEAL_* variable in brackets):
  --report <p>           JSON report, blob-report folder, artifacts folder, or a
                         GitHub Actions / GitLab run URL (needs GITHUB_TOKEN)
  --project <dir>        project root (default: current directory)
  --framework <f>        auto | playwright | pytest | cypress (default auto: from the
                         config files) [AUTOHEAL_FRAMEWORK]. Cypress reads JUnit XML,
                         mochawesome or cypress.run() results from --report
  --mode <m>             comment | draft-pr | pr (default draft-pr) [AUTOHEAL_MODE]
  --out <dir>            where summary.json and the Markdown go (default .autoheal-out)
  --max-failures <n>     failures to work on per run (default 3) [AUTOHEAL_MAX_FAILURES]
  --repeat-each <n>      stability runs a fix must pass (default 5) [AUTOHEAL_REPEAT_EACH]
  --quarantine-days <n>  quarantine length for flaky tests (default 14) [AUTOHEAL_QUARANTINE_DAYS]
  --max-usd <x>          AI cost limit per job (default 1.00) [AUTOHEAL_MAX_USD]
  --max-steps <n>        AI calls per job (default 30) [AUTOHEAL_MAX_STEPS]
  --max-tokens <n>       AI tokens per job (default 400000) [AUTOHEAL_MAX_TOKENS]
  --app-url <url>        running app for live locator checks [AUTOHEAL_APP_URL]
  --start-command <cmd>  start the app first (e.g. "npm run start"); it runs like the
                         tests (sandbox, no secrets) and stops at the end [AUTOHEAL_START_COMMAND]
  --start-url <url>      address to wait for (default --app-url; localhost only) [AUTOHEAL_START_URL]
  --start-timeout <s>    seconds to wait for it (default 120) [AUTOHEAL_START_TIMEOUT]
  --mocks-base-url <u>   live API to compare mocks with [AUTOHEAL_MOCKS_BASE_URL]
  --no-flaky-check       skip the flaky rerun
  --allow-warn           accept anti-cheat WARN findings (default: block them)
  --setup-sandbox        prepare the sandbox user first (automatic on GitLab and CircleCI)

metrics: a Markdown report of AutoHeal's PRs, fixes, spend, issues and quarantined
tests (needs GITHUB_TOKEN or GH_TOKEN with pull-requests and issues read; repo from
GITHUB_REPOSITORY by default). In GitHub Actions it also goes to the job summary.

Policy: a .autoheal.yml at the repository root can protect paths, skip tests, limit
fix kinds and tighten limits (never loosen them). See the README.

Also read: AUTOHEAL_PRICE_IN, AUTOHEAL_PRICE_OUT (USD per million tokens; required
for models with no built-in price), AUTOHEAL_OPEN_ISSUES, AUTOHEAL_ISSUE_MIN_CONFIDENCE,
AUTOHEAL_VISION (auto | true | false: show the AI the failure screenshot).

AI provider (bring your own key; none = deterministic fixes only):
  ANTHROPIC_API_KEY (default model claude-opus-5-5), or OPENAI_API_KEY + AUTOHEAL_MODEL,
  or AUTOHEAL_BASE_URL + AUTOHEAL_MODEL for a local OpenAI-compatible server.

fingerprint: saves element fingerprints from the traces of a green run
(trace: 'on') into .autoheal/fingerprints/ to commit. learn does the same into a
folder that the daily CI job keeps as an artifact or cache, and heal reads it.

Exit codes: 0 done, 1 error, 2 bad usage, 3 a fix was blocked by the anti-cheat guard.
`;

function intOption(value: string | undefined, env: string | undefined, fallback: number, name: string, min = 1, max = 1000): number {
  const raw = value ?? env;
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

function numOption(value: string | undefined, env: string | undefined, fallback: number, name: string): number {
  const raw = value ?? env;
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${name} must be a positive number.`);
  return n;
}

async function writeGithubOutputs(values: Record<string, string>): Promise<void> {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  let text = '';
  for (const [key, value] of Object.entries(values)) {
    const marker = `AUTOHEAL_EOF_${Math.random().toString(36).slice(2)}`;
    text += `${key}<<${marker}\n${value}\n${marker}\n`;
  }
  await appendFile(file, text);
}

function runInfo(): HealSummary['run'] {
  const ci = ciInfo(process.env);
  const info: NonNullable<HealSummary['run']> = {};
  if (ci.runUrl) info.url = ci.runUrl;
  if (ci.runId) info.id = ci.runId;
  if (ci.commit) info.commit = ci.commit;
  if (ci.branch) info.branch = ci.branch;
  if (ci.repo) info.repo = ci.repo;
  return info;
}

/** The repository root, or null outside a git repository. */
function gitTop(dir: string): string | null {
  try {
    const out = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    return out ? path.resolve(out) : null;
  } catch {
    return null;
  }
}

async function cmdHeal(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      report: { type: 'string' },
      framework: { type: 'string' },
      project: { type: 'string' },
      mode: { type: 'string' },
      out: { type: 'string' },
      'max-failures': { type: 'string' },
      'repeat-each': { type: 'string' },
      'quarantine-days': { type: 'string' },
      'max-usd': { type: 'string' },
      'max-steps': { type: 'string' },
      'max-tokens': { type: 'string' },
      'app-url': { type: 'string' },
      'start-command': { type: 'string' },
      'start-url': { type: 'string' },
      'start-timeout': { type: 'string' },
      'mocks-base-url': { type: 'string' },
      'no-flaky-check': { type: 'boolean' },
      'allow-warn': { type: 'boolean' },
      'setup-sandbox': { type: 'boolean' },
    },
    strict: true,
  });
  const env = process.env;
  const projectRoot = path.resolve(values.project ?? '.');
  const log = (line: string) => process.stderr.write(`[autoheal] ${line}\n`);
  const ci = ciInfo(env);
  if (isAutohealBranch(ci.branch)) {
    log(`The failed run is on ${ci.branch}, an AutoHeal branch: nothing to do (no loops).`);
    return 0;
  }
  if (ci.ci !== 'github' && ci.ci !== 'local') log(`CI: ${ciLabel(ci.ci)}${ci.repo ? ` · ${ci.repo}` : ''}${ci.runId ? ` · run ${ci.runId}` : ''}`);
  // The policy file is read first, before any project code (tests, the app) runs.
  const repoRoot = gitTop(projectRoot) ?? projectRoot;
  let policy: Policy | null;
  try {
    policy = loadPolicy(repoRoot);
  } catch (error) {
    if (error instanceof PolicyError) throw new ConfigError(`${error.message}. Fix the file, or remove it to use the workflow settings alone.`);
    throw error;
  }
  if (policy) log(`Policy: ${POLICY_FILE} found at the repository root`);
  const mode = (values.mode ?? env.AUTOHEAL_MODE ?? 'draft-pr') as Mode;
  if (!['comment', 'draft-pr', 'pr'].includes(mode)) throw new ConfigError('--mode must be comment, draft-pr or pr.');
  let report = values.report ?? env.AUTOHEAL_REPORT;
  if (!report) throw new ConfigError('--report is required (a report file, artifacts folder, or run URL).');
  let setting: ReturnType<typeof frameworkSetting>;
  try {
    setting = frameworkSetting(values.framework ?? env.AUTOHEAL_FRAMEWORK);
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }
  const cypress = setting === 'cypress' || (setting === 'auto' && (await isCypressProject(projectRoot)));
  let traceDirs: string[] | undefined;
  if (cypress) {
    // Cypress results (JUnit XML, mochawesome or cypress.run() JSON) are found by the Cypress tools.
    if (/^https?:\/\//.test(report)) throw new ConfigError('For Cypress, download the run\'s artifacts into the project and pass the folder as --report.');
    const abs = path.resolve(projectRoot, report);
    if (!(await stat(abs).catch(() => null))) throw new ConfigError(`Report not found: ${report}`);
    const rel = path.relative(projectRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ConfigError('The report must be inside the project folder (download artifacts into it).');
    report = rel || '.';
  } else if (!/^https?:\/\//.test(report)) {
    const abs = path.resolve(projectRoot, report);
    const info = await stat(abs).catch(() => null);
    if (!info) throw new ConfigError(`Report not found: ${report}`);
    if (info.isDirectory() && !(await readFile(path.join(abs, 'report.jsonl')).then(() => true, () => false))) {
      const found = await findReport(abs);
      if (!found) throw new ConfigError(`No Playwright JSON or blob report found under ${report}. Add the json or blob reporter and upload it as an artifact.`);
      report = found.report;
      traceDirs = [path.relative(projectRoot, abs) || '.', ...found.traceDirs.map((d) => path.relative(projectRoot, d))];
    } else {
      report = abs;
    }
    // Traces usually sit in test-results/ next to the report or in the project.
    for (const candidate of [path.join(path.dirname(report), 'test-results'), path.join(path.dirname(path.dirname(report)), 'test-results'), path.join(projectRoot, 'test-results')]) {
      const rel = path.relative(projectRoot, candidate);
      if (!rel.startsWith('..') && (await stat(candidate).then((s) => s.isDirectory(), () => false))) traceDirs = [...(traceDirs ?? []), rel];
    }
    traceDirs = traceDirs ? [...new Set(traceDirs.filter((d) => d !== ''))] : undefined;
    const rel = path.relative(projectRoot, report);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ConfigError('The report must be inside the project folder (download artifacts into it).');
    report = rel;
  }

  const provider = providerFromEnv(env);
  // Fail closed: without a price the dollar limit cannot work.
  if (provider && provider.name !== 'scripted' && !priceFor(provider.model, env)) {
    throw new ConfigError(
      `AutoHeal has no price for model "${provider.model}", so the cost limit cannot work. Set AUTOHEAL_PRICE_IN and AUTOHEAL_PRICE_OUT (US dollars per million input and output tokens; 0 and 0 for a local model).`,
    );
  }
  const outDir = path.resolve(values.out ?? env.AUTOHEAL_OUT ?? '.autoheal-out');
  log(`AutoHeal ${VERSION} · mode ${mode} · provider ${provider ? `${provider.name} (${provider.model})` : 'none (deterministic fixes only)'}`);
  const appUrl = values['app-url'] ?? env.AUTOHEAL_APP_URL;
  const mocksBaseUrl = values['mocks-base-url'] ?? env.AUTOHEAL_MOCKS_BASE_URL;
  // Screenshots from an earlier run in the same folder would be mixed up with this run's.
  await rm(path.join(outDir, 'evidence'), { recursive: true, force: true });
  // Outside GitHub Actions there is no "Prepare the sandbox" step: do it here.
  if (values['setup-sandbox'] === true || (ci.ci !== 'github' && ci.ci !== 'local' && !env.AUTOHEAL_SANDBOX_USER && sandboxMode(env.AUTOHEAL_SANDBOX) !== 'off')) {
    const prepared = prepareSandbox(projectRoot, sandboxMode(env.AUTOHEAL_SANDBOX), log);
    for (const [k, v] of Object.entries(prepared)) env[k] = v;
  }
  let sandboxChoice: ReturnType<typeof chooseSandbox>;
  try {
    sandboxChoice = chooseSandbox(sandboxMode(env.AUTOHEAL_SANDBOX));
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }
  log(`Sandbox: ${sandboxChoice.note}`);
  // The live app: started here when there is a start command, so the AI can check locators on the real page.
  const startCommand = values['start-command'] ?? env.AUTOHEAL_START_COMMAND;
  const startUrl = values['start-url'] ?? env.AUTOHEAL_START_URL ?? appUrl;
  let app: StartedApp | null = null;
  let appNote: string | undefined;
  if (startCommand) {
    if (!startUrl) throw new ConfigError('--start-command needs --start-url (or --app-url): the address to wait for.');
    try {
      checkAppUrl(startUrl);
    } catch (error) {
      throw new ConfigError(error instanceof Error ? error.message : String(error));
    }
    try {
      app = await startApp({
        command: startCommand,
        url: startUrl,
        cwd: projectRoot,
        timeoutMs: intOption(values['start-timeout'], env.AUTOHEAL_START_TIMEOUT, 120, '--start-timeout', 5, 1800) * 1000,
        sandbox: sandboxChoice.sandbox,
        log,
      });
      appNote = app.note;
    } catch (error) {
      // The app is a help, not a must: heal from the traces alone and say why.
      appNote = `not started (${error instanceof Error ? error.message : String(error)}); locators were checked against the trace only`;
      log(`Live app: ${appNote}`);
    }
  }
  const liveUrl = app?.url ?? appUrl;
  // Learn from reviews: what happened to earlier AutoHeal PRs (GitHub only, read-only token).
  let reviews: ReviewHistory | undefined;
  let reviewNote: string | undefined;
  if (env.AUTOHEAL_LEARN_REVIEWS !== 'false' && env.GITHUB_REPOSITORY && env.GITHUB_TOKEN) {
    try {
      reviews = await reviewHistory({ repo: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN, ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}) });
      log(`Reviews: ${reviews.prs.merged} merged, ${reviews.prs.edited} edited, ${reviews.prs.closed} closed earlier AutoHeal PR(s)`);
    } catch (error) {
      reviewNote = `could not be read (${error instanceof Error ? error.message : String(error)}); give the heal job \`pull-requests: read\``;
      log(`Reviews: ${reviewNote}`);
    }
  }
  // The policy can only make the workflow's limits stricter.
  const limits = tighten(
    {
      maxFailures: intOption(values['max-failures'], env.AUTOHEAL_MAX_FAILURES, 3, '--max-failures', 1, 50),
      repeatEach: intOption(values['repeat-each'], env.AUTOHEAL_REPEAT_EACH, 5, '--repeat-each', 2, 50),
      quarantineDays: intOption(values['quarantine-days'], env.AUTOHEAL_QUARANTINE_DAYS, 14, '--quarantine-days', 1, 90),
      maxUsd: numOption(values['max-usd'], env.AUTOHEAL_MAX_USD, 1, '--max-usd'),
    },
    policy,
  );
  const policyNote = policy ? policyText(policy, limits.changed) : undefined;
  if (policyNote) log(policyNote);
  // Fingerprints the daily learn job saved (an artifact or a CI cache), as hints.
  const learnedDirs = [path.join(projectRoot, LEARNED_DIR)];
  if (env.AUTOHEAL_LEARNED !== 'false') {
    const fetched = await mkdtemp(path.join(os.tmpdir(), 'autoheal-learned-'));
    const note = await fetchLearned(ci, env, fetched);
    if (note) log(`Learned fingerprints: ${note}`);
    learnedDirs.push(fetched);
  }
  const rawSummary = await heal({
    projectRoot,
    report,
    ...(traceDirs ? { traceDirs } : {}),
    framework: cypress ? 'cypress' : setting,
    learnedDirs,
    mode,
    maxFailures: limits.maxFailures,
    repeatEach: limits.repeatEach,
    quarantineDays: limits.quarantineDays,
    allowWarn: values['allow-warn'] === true || env.AUTOHEAL_ALLOW_WARN === '1',
    checkFlaky: values['no-flaky-check'] !== true && env.AUTOHEAL_NO_FLAKY_CHECK !== '1',
    flakyRuns: 3,
    ...(liveUrl ? { appUrl: liveUrl } : {}),
    ...(mocksBaseUrl ? { mocksBaseUrl } : {}),
    ...(ci.owner ? { owner: ci.owner } : {}),
    budget: {
      maxUsd: limits.maxUsd,
      maxSteps: intOption(values['max-steps'], env.AUTOHEAL_MAX_STEPS, 30, '--max-steps', 1, 500),
      maxTokens: intOption(values['max-tokens'], env.AUTOHEAL_MAX_TOKENS, 400_000, '--max-tokens', 1000, 50_000_000),
    },
    provider,
    run: runInfo(),
    log,
    sandbox: sandboxChoice.sandbox,
    sandboxNote: sandboxChoice.note,
    ...(env.AUTOHEAL_SCREENSHOTS === 'false' ? {} : { evidenceDir: path.join(outDir, 'evidence') }),
    ...(reviews ? { reviews } : {}),
    ...(reviewNote ? { reviewNote } : {}),
    ...(policy ? { policy, repoPrefix: path.relative(repoRoot, projectRoot).split(path.sep).join('/'), ...(policyNote ? { policyNote } : {}) } : {}),
  }).finally(() => app?.stop());
  if (appNote) rawSummary.app = appNote;
  // Belt and braces: scrub every string before anything is written or posted.
  const summary = redactDeep(rawSummary);

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(path.join(outDir, 'job-summary.md'), jobSummary(summary));
  const outputs: Record<string, string> = {
    outcome: summary.outcome,
    changes: String(summary.changes),
    'changed-files': summary.changedFiles.join('\n'),
    fixed: String(summary.results.filter((r) => r.status === 'FIXED').length),
    blocked: String(summary.results.filter((r) => r.status === 'BLOCKED_CHEATING').length),
    'summary-file': path.join(outDir, 'summary.json'),
    'out-dir': outDir,
  };
  if (summary.changes) {
    await writeFile(path.join(outDir, 'pr-body.md'), prBody(summary));
    outputs['pr-body-file'] = path.join(outDir, 'pr-body.md');
  }
  // Issues only for confident app bugs; the rest are listed in the job summary.
  const minConfidence = Math.max(numOption(undefined, env.AUTOHEAL_ISSUE_MIN_CONFIDENCE, 0.6, 'AUTOHEAL_ISSUE_MIN_CONFIDENCE'), policy?.issues.minConfidence ?? 0);
  const appBugs = env.AUTOHEAL_OPEN_ISSUES === 'false' || policy?.issues.enabled === false ? [] : summary.results.filter((r) => r.status === 'APP_BUG' && r.confidence >= minConfidence).slice(0, 10);
  const issues = appBugs.map((r, i) => ({ title: issueTitle(r), test: r.failure.title, file: `issue-${i + 1}.md` }));
  for (const [i, r] of appBugs.entries()) await writeFile(path.join(outDir, `issue-${i + 1}.md`), issueBody(summary, r));
  await writeFile(path.join(outDir, 'issues.json'), `${JSON.stringify(issues, null, 2)}\n`);
  outputs['issues-file'] = path.join(outDir, 'issues.json');
  await writeFile(path.join(outDir, 'comment.md'), commentBody(summary));
  // Dashboard events (labels only), so the publish job can upload them without installing anything.
  await writeFile(path.join(outDir, 'events.json'), `${JSON.stringify(eventsFrom(summary), null, 2)}\n`);
  outputs['comment-file'] = path.join(outDir, 'comment.md');
  await writeGithubOutputs(outputs);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, jobSummary(summary));

  process.stdout.write(jobSummary(summary));
  if (summary.outcome === 'error') {
    log(`Error: ${summary.error ?? 'unknown'}`);
    return 1;
  }
  return summary.outcome === 'blocked' ? 3 : 0;
}

/** Saves fingerprints from every trace.zip under --traces (a green run with trace: 'on'). */
async function cmdFingerprint(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { traces: { type: 'string' }, project: { type: 'string' } }, strict: true });
  if (!values.traces) throw new ConfigError('--traces is required (a folder with trace.zip files, e.g. test-results).');
  const projectRoot = path.resolve(values.project ?? '.');
  const { entries, traces } = await fingerprintsFromTraces(path.resolve(projectRoot, values.traces));
  const written = await saveFingerprints(projectRoot, entries);
  process.stderr.write(`[autoheal] Read ${traces} trace(s); saved ${written.length} element fingerprint(s) in .autoheal/fingerprints/. Commit them.\n`);
  return 0;
}

async function detectFramework(projectRoot: string, value: string | undefined): Promise<'playwright' | 'pytest' | 'cypress'> {
  let setting: ReturnType<typeof frameworkSetting>;
  try {
    setting = frameworkSetting(value ?? process.env.AUTOHEAL_FRAMEWORK);
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }
  if (setting !== 'auto') return setting;
  if (await isCypressProject(projectRoot)) return 'cypress';
  return (await isPytestProject(projectRoot)) ? 'pytest' : 'playwright';
}

/** Runs the tests once with traces on and saves fingerprints into a flat folder (no AI, no secrets). */
async function cmdLearn(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { project: { type: 'string' }, framework: { type: 'string' }, out: { type: 'string' }, traces: { type: 'string' } }, strict: true });
  const projectRoot = path.resolve(values.project ?? '.');
  const framework = await detectFramework(projectRoot, values.framework);
  const out = path.resolve(projectRoot, values.out ?? LEARNED_DIR);
  const log = (line: string) => process.stderr.write(`[autoheal] ${line}\n`);
  let source = values.traces ? path.resolve(projectRoot, values.traces) : '';
  if (!source) {
    const rel = path.join('.autoheal-local', 'learn');
    await rm(path.join(projectRoot, rel), { recursive: true, force: true });
    await mkdir(path.join(projectRoot, rel), { recursive: true });
    log(`Running your ${framework} tests once with traces on…`);
    const code = runTests(projectRoot, testRun(framework, 'learn', rel));
    if (code !== 0) log(`Some tests failed (exit ${code}); learning from the ones that passed.`);
    source = path.join(projectRoot, rel);
  }
  const found = framework === 'cypress' ? await fingerprintsFromCypress(projectRoot, path.relative(projectRoot, source) || '.') : await fingerprintsFromTraces(source);
  const n = await writeLearned(out, found.entries);
  log(`Saved ${n} element fingerprint(s) in ${path.relative(projectRoot, out) || out}. ${n ? 'The heal job reads them.' : framework === 'cypress' ? 'None found: add the xsignon-autoheal/cypress plugin.' : 'None found: are there passing tests?'}`);
  return 0;
}

/** On your machine: run the tests, heal what failed, leave the changes in the working tree. */
async function cmdFix(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      report: { type: 'string' },
      project: { type: 'string' },
      framework: { type: 'string' },
      'allow-dirty': { type: 'boolean' },
      'max-failures': { type: 'string' },
      'max-usd': { type: 'string' },
      'no-flaky-check': { type: 'boolean' },
      'allow-warn': { type: 'boolean' },
      'start-command': { type: 'string' },
      'start-url': { type: 'string' },
    },
    strict: true,
  });
  const env = process.env;
  const projectRoot = path.resolve(values.project ?? '.');
  const log = (line: string) => process.stderr.write(`[autoheal] ${line}\n`);
  const top = gitTop(projectRoot);
  if (!top) throw new ConfigError('autoheal fix works in a git repository, so you can review its changes with git diff.');
  const dirty = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'status', '--porcelain', '--untracked-files=no'], { cwd: projectRoot, encoding: 'utf8' }).trim();
  if (dirty && !values['allow-dirty']) throw new ConfigError('You have uncommitted changes. Commit or stash them first, so AutoHeal\'s fixes are easy to review (or pass --allow-dirty).');
  const framework = await detectFramework(projectRoot, values.framework);
  const local = path.join(projectRoot, '.autoheal-local');
  let report = values.report;
  if (!report) {
    const rel = path.join('.autoheal-local', 'run');
    await rm(path.join(projectRoot, rel), { recursive: true, force: true });
    await mkdir(path.join(projectRoot, rel), { recursive: true });
    log(`Running your ${framework} tests…`);
    const code = runTests(projectRoot, testRun(framework, 'fix', rel));
    if (code === 0) {
      log('All tests passed. Nothing to fix.');
      return 0;
    }
    report = rel;
  }
  // Your own machine, your own code: the sandbox is for CI.
  if (!env.AUTOHEAL_SANDBOX) env.AUTOHEAL_SANDBOX = 'off';
  env.AUTOHEAL_LEARN_REVIEWS = env.AUTOHEAL_LEARN_REVIEWS ?? 'false';
  const args = ['--report', report, '--project', projectRoot, '--out', path.join(local, 'out'), '--mode', 'pr', '--framework', framework];
  for (const k of ['max-failures', 'max-usd', 'start-command', 'start-url'] as const) if (values[k]) args.push(`--${k}`, values[k] as string);
  if (values['no-flaky-check']) args.push('--no-flaky-check');
  if (values['allow-warn']) args.push('--allow-warn');
  const code = await cmdHeal(args);
  const stat = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'diff', '--stat'], { cwd: projectRoot, encoding: 'utf8' }).trim();
  process.stderr.write(
    stat
      ? `\n[autoheal] Changes are in your working tree (nothing was committed):\n${stat}\n[autoheal] Review with \`git diff\`; undo with \`git checkout -- .\`. Report: .autoheal-local/out/job-summary.md\n`
      : '\n[autoheal] No files were changed. Report: .autoheal-local/out/job-summary.md\n',
  );
  return code;
}

/** autoheal init: writes the workflow for your CI and checks the setup. */
async function cmdInit(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { ci: { type: 'string' }, project: { type: 'string' }, force: { type: 'boolean' }, 'dry-run': { type: 'boolean' } }, strict: true });
  const ci = values.ci;
  if (ci !== undefined && !['github', 'gitlab', 'circleci'].includes(ci)) throw new ConfigError('--ci must be github, gitlab or circleci.');
  const root = path.resolve(values.project ?? '.');
  const r = await init(root, { ...(ci ? { ci: ci as SetupCi } : {}), force: values.force === true, dryRun: values['dry-run'] === true });
  const out: string[] = [`AutoHeal ${VERSION} for ${r.project.framework} on ${ciLabel(r.project.ci)}${r.project.workflow ? ` (test workflow "${r.project.workflow.name}")` : ''}`, ''];
  for (const w of r.written) out.push(`${values['dry-run'] ? 'would write' : 'wrote'}   ${w}`);
  for (const w of r.skipped) out.push(`kept    ${w} (exists; --force to overwrite)`);
  out.push('', 'Checks:', checksText(r.checks), '', 'Only you can do these:');
  r.steps.forEach((step, i) => out.push(`  ${i + 1}. ${step}`));
  out.push('', 'Then run `npx xsignon-autoheal doctor` any time to check again.', '');
  process.stdout.write(out.join('\n'));
  return 0;
}

async function cmdDoctor(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { ci: { type: 'string' }, project: { type: 'string' } }, strict: true });
  const ci = values.ci;
  if (ci !== undefined && !['github', 'gitlab', 'circleci'].includes(ci)) throw new ConfigError('--ci must be github, gitlab or circleci.');
  const checks = await doctor(path.resolve(values.project ?? '.'), process.env, ci ? { ci: ci as SetupCi } : {});
  process.stdout.write(`AutoHeal ${VERSION} doctor\n\n${checksText(checks)}\n`);
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}

/** Packs the heal output for the publish job (scripts/package.mjs). */
async function cmdPackage(argv: string[]): Promise<number> {
  const [outDir, resultDir] = argv;
  if (!outDir || !resultDir) throw new ConfigError('usage: autoheal package <heal-out-dir> <result-dir>');
  const script = fileURLToPath(new URL('../scripts/package.mjs', import.meta.url));
  const res = spawnSync(process.execPath, [script, outDir, resultDir], { stdio: 'inherit' });
  return res.status ?? 1;
}

/** The publish job outside GitHub Actions (scripts/publish.mjs, with AUTOHEAL_* settings). */
async function cmdPublish(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { result: { type: 'string' }, mode: { type: 'string' } }, strict: true });
  const env = process.env;
  const map: Record<string, string | undefined> = {
    RESULT_DIR: values.result ?? env.AUTOHEAL_RESULT_DIR,
    MODE: values.mode ?? env.AUTOHEAL_MODE,
    ALLOWED_PATHS: env.AUTOHEAL_ALLOWED_PATHS,
    ALLOW_WARN: env.AUTOHEAL_ALLOW_WARN === '1' || env.AUTOHEAL_ALLOW_WARN === 'true' ? 'true' : undefined,
    QUARANTINE_DAYS: env.AUTOHEAL_QUARANTINE_DAYS,
    DASHBOARD_URL: env.AUTOHEAL_DASHBOARD_URL,
    DASHBOARD_SECRET: env.AUTOHEAL_DASHBOARD_SECRET,
    OPEN_ISSUES: env.AUTOHEAL_OPEN_ISSUES,
  };
  for (const [k, v] of Object.entries(map)) if (v !== undefined && env[k] === undefined) env[k] = v;
  const mod = (await import(new URL('../scripts/publish.mjs', import.meta.url).href)) as { main: (e: NodeJS.ProcessEnv) => Promise<number>; report: (p: Promise<number>) => Promise<number> };
  return mod.report(mod.main(env));
}

async function cmdUpload(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { summary: { type: 'string' }, 'pr-url': { type: 'string' }, issues: { type: 'string' }, url: { type: 'string' } },
    strict: true,
  });
  const url = values.url ?? process.env.AUTOHEAL_DASHBOARD_URL;
  const secret = process.env.AUTOHEAL_DASHBOARD_SECRET;
  if (!url || !secret) {
    process.stderr.write('[autoheal] Dashboard upload skipped: AUTOHEAL_DASHBOARD_URL and AUTOHEAL_DASHBOARD_SECRET are not both set.\n');
    return 0;
  }
  if (!values.summary) throw new ConfigError('--summary is required.');
  const summary = JSON.parse(await readFile(values.summary, 'utf8')) as HealSummary;
  let issueUrls: Record<string, string> | undefined;
  if (values.issues) {
    const list = JSON.parse(await readFile(values.issues, 'utf8')) as Array<{ test: string; url?: string }>;
    issueUrls = Object.fromEntries(list.filter((i) => i.url).map((i) => [i.test, i.url as string]));
  }
  const events = eventsFrom(summary, { ...(values['pr-url'] ? { prUrl: values['pr-url'] } : {}), ...(issueUrls ? { issueUrls } : {}) });
  if (!events.length) return 0;
  const res = await uploadEvents(url, secret, events);
  process.stderr.write(`[autoheal] Dashboard upload: HTTP ${res.status} ${res.text}\n`);
  // The dashboard is optional: a failed upload never fails the job.
  return 0;
}

/** A report of how AutoHeal is doing in a repository (no AI, read-only). */
async function cmdMetrics(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { repo: { type: 'string' }, days: { type: 'string' }, project: { type: 'string' }, json: { type: 'string' } }, strict: true });
  const env = process.env;
  const repo = values.repo ?? env.GITHUB_REPOSITORY;
  if (!repo) throw new ConfigError('--repo owner/name is required (or GITHUB_REPOSITORY).');
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) throw new ConfigError('Set GITHUB_TOKEN or GH_TOKEN (read access to pull requests and issues).');
  const metrics = await collectMetrics({
    repo,
    token,
    days: intOption(values.days, undefined, 30, '--days', 1, 365),
    root: path.resolve(values.project ?? '.'),
    ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}),
  });
  const md = metricsMarkdown(metrics);
  process.stdout.write(md);
  if (values.json) await writeFile(path.resolve(values.json), `${JSON.stringify(metrics, null, 2)}\n`);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, md);
  return 0;
}

async function cmdDashboard(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { port: { type: 'string' }, host: { type: 'string' }, db: { type: 'string' } }, strict: true });
  const { startDashboard } = await import('./server/app.js');
  const { Store } = await import('./server/store.js');
  const secret = process.env.AUTOHEAL_DASHBOARD_SECRET ?? '';
  const port = intOption(values.port, process.env.PORT, 8080, '--port', 1, 65535);
  const host = values.host ?? process.env.HOST ?? '0.0.0.0';
  const repos = (process.env.AUTOHEAL_DASHBOARD_REPOS ?? '').split(',').map((r) => r.trim()).filter(Boolean);
  const viewToken = process.env.AUTOHEAL_DASHBOARD_VIEW_TOKEN;
  if (!viewToken && process.env.AUTOHEAL_DASHBOARD_PUBLIC !== '1') {
    throw new ConfigError('Set AUTOHEAL_DASHBOARD_VIEW_TOKEN (16+ characters) so only you can read the dashboard, or AUTOHEAL_DASHBOARD_PUBLIC=1 to make it public on purpose.');
  }
  if (viewToken && viewToken.length < 16) throw new ConfigError('AUTOHEAL_DASHBOARD_VIEW_TOKEN must be at least 16 characters.');
  const { MIN_SECRET_LENGTH } = await import('./signing.js');
  if (secret.length < MIN_SECRET_LENGTH) throw new ConfigError(`AUTOHEAL_DASHBOARD_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  const store = new Store(
    values.db ?? process.env.AUTOHEAL_DB ?? 'autoheal.db',
    intOption(undefined, process.env.AUTOHEAL_DASHBOARD_MAX_EVENTS, 100_000, 'AUTOHEAL_DASHBOARD_MAX_EVENTS', 100, 10_000_000),
  );
  const server = await startDashboard({
    store,
    secret,
    port,
    host,
    ...(viewToken ? { viewToken } : {}),
    ...(process.env.AUTOHEAL_TRUST_PROXY === '1' ? { trustProxy: true } : {}),
    ...(repos.length ? { repos } : {}),
  });
  process.stderr.write(`[autoheal] Dashboard on http://${host}:${port}\n`);
  const stop = () => server.close(() => {
    store.close();
    process.exit(0);
  });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return await new Promise<number>(() => undefined);
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (!command || command === '--help' || command === '-h' || command === 'help') {
      process.stdout.write(USAGE);
      return command ? 0 : 2;
    }
    if (command === '--version' || command === '-v') {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (command === 'heal') return await cmdHeal(rest);
    if (command === 'init') return await cmdInit(rest);
    if (command === 'doctor') return await cmdDoctor(rest);
    if (command === 'fix') return await cmdFix(rest);
    if (command === 'learn') return await cmdLearn(rest);
    if (command === 'package') return await cmdPackage(rest);
    if (command === 'publish') return await cmdPublish(rest);
    if (command === 'upload') return await cmdUpload(rest);
    if (command === 'fingerprint') return await cmdFingerprint(rest);
    if (command === 'dashboard') return await cmdDashboard(rest);
    if (command === 'metrics') return await cmdMetrics(rest);
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  } catch (error) {
    if (error instanceof ConfigError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`[autoheal] ${(error as Error).message}\n`);
      return 2;
    }
    process.stderr.write(`[autoheal] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return 1;
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
