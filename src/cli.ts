#!/usr/bin/env node
/**
 * autoheal: command line for the heal job, the dashboard upload and the
 * self-hosted dashboard.
 */

import { realpathSync } from 'node:fs';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { commentBody, issueBody, issueTitle, jobSummary, prBody } from './evidence.js';
import { heal } from './heal.js';
import { ConfigError, providerFromEnv } from './providers/index.js';
import { redactDeep } from './redact.js';
import { findReport } from './report-files.js';
import type { HealSummary, Mode } from './types.js';
import { eventsFrom, uploadEvents } from './upload.js';
import { VERSION } from './version.js';

export const USAGE = `autoheal ${VERSION}: free, self-hosted AI agent that fixes failing Playwright tests

Usage:
  autoheal heal --report <path|run URL> [options]
  autoheal upload --summary <summary.json> [--pr-url URL] [--issues issues.json]
  autoheal dashboard [--port 8080] [--host 0.0.0.0] [--db autoheal.db]
  autoheal --version

heal options (each also reads the AUTOHEAL_* variable in brackets):
  --report <p>           JSON report, blob-report folder, artifacts folder, or a
                         GitHub Actions / GitLab run URL (needs GITHUB_TOKEN)
  --project <dir>        project root (default: current directory)
  --mode <m>             comment | draft-pr | pr (default draft-pr) [AUTOHEAL_MODE]
  --out <dir>            where summary.json and the Markdown go (default .autoheal-out)
  --max-failures <n>     failures to work on per run (default 3) [AUTOHEAL_MAX_FAILURES]
  --repeat-each <n>      stability runs a fix must pass (default 5) [AUTOHEAL_REPEAT_EACH]
  --quarantine-days <n>  quarantine length for flaky tests (default 14) [AUTOHEAL_QUARANTINE_DAYS]
  --max-usd <x>          AI cost limit per job (default 1.00) [AUTOHEAL_MAX_USD]
  --max-steps <n>        AI calls per job (default 30) [AUTOHEAL_MAX_STEPS]
  --max-tokens <n>       AI tokens per job (default 400000) [AUTOHEAL_MAX_TOKENS]
  --app-url <url>        running app for live locator checks [AUTOHEAL_APP_URL]
  --mocks-base-url <u>   live API to compare mocks with [AUTOHEAL_MOCKS_BASE_URL]
  --no-flaky-check       skip the flaky rerun
  --allow-warn           accept anti-cheat WARN findings (default: block them)

AI provider (bring your own key; none = deterministic fixes only):
  ANTHROPIC_API_KEY (default model claude-opus-5-5), or OPENAI_API_KEY + AUTOHEAL_MODEL,
  or AUTOHEAL_BASE_URL + AUTOHEAL_MODEL for a local OpenAI-compatible server.

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
  const env = process.env;
  const info: NonNullable<HealSummary['run']> = {};
  if (env.AUTOHEAL_RUN_URL) info.url = env.AUTOHEAL_RUN_URL;
  if (env.AUTOHEAL_RUN_ID) info.id = env.AUTOHEAL_RUN_ID;
  if (env.AUTOHEAL_COMMIT) info.commit = env.AUTOHEAL_COMMIT;
  if (env.AUTOHEAL_BRANCH) info.branch = env.AUTOHEAL_BRANCH;
  if (env.GITHUB_REPOSITORY) info.repo = env.GITHUB_REPOSITORY;
  return info;
}

async function cmdHeal(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      report: { type: 'string' },
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
      'mocks-base-url': { type: 'string' },
      'no-flaky-check': { type: 'boolean' },
      'allow-warn': { type: 'boolean' },
    },
    strict: true,
  });
  const env = process.env;
  const projectRoot = path.resolve(values.project ?? '.');
  const mode = (values.mode ?? env.AUTOHEAL_MODE ?? 'draft-pr') as Mode;
  if (!['comment', 'draft-pr', 'pr'].includes(mode)) throw new ConfigError('--mode must be comment, draft-pr or pr.');
  let report = values.report ?? env.AUTOHEAL_REPORT;
  if (!report) throw new ConfigError('--report is required (a report file, artifacts folder, or run URL).');
  let traceDirs: string[] | undefined;
  if (!/^https?:\/\//.test(report)) {
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
  const outDir = path.resolve(values.out ?? env.AUTOHEAL_OUT ?? '.autoheal-out');
  const log = (line: string) => process.stderr.write(`[autoheal] ${line}\n`);
  log(`AutoHeal ${VERSION} · mode ${mode} · provider ${provider ? `${provider.name} (${provider.model})` : 'none (deterministic fixes only)'}`);
  const appUrl = values['app-url'] ?? env.AUTOHEAL_APP_URL;
  const mocksBaseUrl = values['mocks-base-url'] ?? env.AUTOHEAL_MOCKS_BASE_URL;
  const rawSummary = await heal({
    projectRoot,
    report,
    ...(traceDirs ? { traceDirs } : {}),
    mode,
    maxFailures: intOption(values['max-failures'], env.AUTOHEAL_MAX_FAILURES, 3, '--max-failures', 1, 50),
    repeatEach: intOption(values['repeat-each'], env.AUTOHEAL_REPEAT_EACH, 5, '--repeat-each', 2, 50),
    quarantineDays: intOption(values['quarantine-days'], env.AUTOHEAL_QUARANTINE_DAYS, 14, '--quarantine-days', 1, 90),
    allowWarn: values['allow-warn'] === true || env.AUTOHEAL_ALLOW_WARN === '1',
    checkFlaky: values['no-flaky-check'] !== true && env.AUTOHEAL_NO_FLAKY_CHECK !== '1',
    flakyRuns: 3,
    ...(appUrl ? { appUrl } : {}),
    ...(mocksBaseUrl ? { mocksBaseUrl } : {}),
    ...(env.AUTOHEAL_OWNER ? { owner: env.AUTOHEAL_OWNER } : {}),
    budget: {
      maxUsd: numOption(values['max-usd'], env.AUTOHEAL_MAX_USD, 1, '--max-usd'),
      maxSteps: intOption(values['max-steps'], env.AUTOHEAL_MAX_STEPS, 30, '--max-steps', 1, 500),
      maxTokens: intOption(values['max-tokens'], env.AUTOHEAL_MAX_TOKENS, 400_000, '--max-tokens', 1000, 50_000_000),
    },
    provider,
    run: runInfo(),
    log,
  });
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
  const appBugs = summary.results.filter((r) => r.status === 'APP_BUG');
  const issues = appBugs.map((r, i) => ({ title: issueTitle(r), test: r.failure.title, file: `issue-${i + 1}.md` }));
  for (const [i, r] of appBugs.entries()) await writeFile(path.join(outDir, `issue-${i + 1}.md`), issueBody(summary, r));
  await writeFile(path.join(outDir, 'issues.json'), `${JSON.stringify(issues, null, 2)}\n`);
  outputs['issues-file'] = path.join(outDir, 'issues.json');
  await writeFile(path.join(outDir, 'comment.md'), commentBody(summary));
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
    if (command === 'upload') return await cmdUpload(rest);
    if (command === 'dashboard') return await cmdDashboard(rest);
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
