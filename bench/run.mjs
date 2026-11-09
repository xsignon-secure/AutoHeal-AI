#!/usr/bin/env node
/**
 * AutoHeal benchmark: how often does a heal job fix a test broken by a UI
 * change, and how often does it "fix" a test that caught a real app change?
 *
 * For every case in bench/cases.mjs it builds one Playwright project (a page
 * per case and a test per page), records a green run of the old pages with
 * traces, saves element fingerprints, commits the UI changes, runs the suite
 * again (the failed CI run), and runs `autoheal heal` on it in several setups:
 *
 *   rules         no AI key, no fingerprints: the engine's own locator fixes
 *   fingerprints  no AI key, with fingerprints saved from the green run
 *   ai            with fingerprints and your AI key (only when BENCH_AI=1 and
 *                 ANTHROPIC_API_KEY or OPENAI_API_KEY is set; costs money)
 *   external      ANY other fixer, head to head: BENCH_FIXER="<command>" runs
 *                 in a copy of the failed project (the failed run is in
 *                 autoheal-artifacts/, BENCH_REPORT points at it). Afterwards
 *                 the suite runs 3 times and every spec is scored the same way:
 *                 fixed, missed, wrong fix, CHEAT (passes only because the test
 *                 was weakened, judged by AutoHeal's anti-cheat scan) or a trap
 *                 falsely "fixed". Example: BENCH_FIXER="npx some-healer --fix"
 *                 npm run bench -- --setups fingerprints,external
 *
 * Every setup uses the same failed run. The flaky rerun is off (no case is
 * flaky), so the time is spent on healing. Results go to bench/results/
 * (latest.json and latest.md). Usage: npm run bench [-- --setups rules,fingerprints]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CASES } from './cases.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const cli = path.join(repo, 'dist', 'cli.js');
const playwrightModules = path.join(repo, 'simulation', 'fixture', 'node_modules');
const work = path.join(repo, 'simulation', 'work', 'bench');
const port = 4330;

const { values } = parseArgs({ options: { setups: { type: 'string' }, 'repeat-each': { type: 'string' }, out: { type: 'string' } } });
const aiReady = process.env.BENCH_AI === '1' && Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
const fixer = process.env.BENCH_FIXER ?? '';
const setups = (values.setups ?? [aiReady ? 'rules,fingerprints,ai' : 'rules,fingerprints', fixer ? 'external' : ''].filter(Boolean).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
for (const s of setups) if (!['rules', 'fingerprints', 'ai', 'external'].includes(s)) throw new Error(`unknown setup ${s}`);
if (setups.includes('ai') && !aiReady) throw new Error('The ai setup needs BENCH_AI=1 and ANTHROPIC_API_KEY or OPENAI_API_KEY.');
if (setups.includes('external') && !fixer) throw new Error('The external setup needs BENCH_FIXER="<command that fixes the tests>".');
const { scanChange } = await import(path.join(repo, 'dist', 'cheat.js'));
const repeatEach = values['repeat-each'] ?? '3';
const outDir = path.resolve(values.out ?? path.join(here, 'results'));

if (!existsSync(path.join(cli))) throw new Error('Run npm run build first.');
if (!existsSync(path.join(playwrightModules, '@playwright', 'test'))) {
  console.log('Installing the simulation fixture’s Playwright…');
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: path.join(repo, 'simulation', 'fixture'), stdio: 'inherit' });
}

const pagesOf = (side) => Object.fromEntries(CASES.map((c) => [c.id, c[side]]));
const specOf = (c) => `import { expect, test } from '@playwright/test';\n\ntest('${c.id}', async ({ page }) => {\n  await page.goto('/c/${c.id}');\n  ${c.test}\n});\n`;
const CONFIG = `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  workers: 1,
  retries: 0,
  timeout: 15_000,
  expect: { timeout: 1_500 },
  reporter: [['list'], ['json', { outputFile: 'playwright-report/results.json' }]],
  use: { baseURL: 'http://127.0.0.1:${port}', trace: 'retain-on-failure' },
  webServer: { command: 'node app/server.mjs', url: 'http://127.0.0.1:${port}/', reuseExistingServer: false, env: { PORT: '${port}' } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`;

function sh(dir, cmd, args, env = {}) {
  return spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', env: { ...process.env, CI: '1', ...env }, maxBuffer: 64 * 1024 * 1024 });
}

/** The project after the UI change, with the failed run in autoheal-artifacts/ and fingerprints from the green run. */
function buildBase() {
  const dir = path.join(work, 'base');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'tests'), { recursive: true });
  mkdirSync(path.join(dir, 'app'));
  cpSync(path.join(here, 'app', 'server.mjs'), path.join(dir, 'app', 'server.mjs'));
  writeFileSync(path.join(dir, 'package.json'), '{ "name": "autoheal-bench", "private": true, "type": "module" }\n');
  writeFileSync(path.join(dir, 'playwright.config.ts'), CONFIG);
  for (const c of CASES) writeFileSync(path.join(dir, 'tests', `${c.id}.spec.ts`), specOf(c));
  writeFileSync(path.join(dir, 'app', 'pages.json'), JSON.stringify(pagesOf('before'), null, 1));
  symlinkSync(playwrightModules, path.join(dir, 'node_modules'), 'dir');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  const commit = (msg) => {
    git('add', '-A');
    git('-c', 'user.email=bench@example.com', '-c', 'user.name=bench', 'commit', '-qm', msg);
  };
  git('init', '-q');
  writeFileSync(path.join(dir, '.git', 'info', 'exclude'), 'node_modules\nautoheal-artifacts/\n.autoheal-out/\ntest-results/\nplaywright-report/\n');

  const green = sh(dir, 'npx', ['playwright', 'test', '--trace', 'on']);
  if (green.status !== 0) throw new Error(`The green run of the old pages failed:\n${green.stdout}\n${green.stderr}`);
  const fp = sh(dir, process.execPath, [cli, 'fingerprint', '--traces', 'test-results']);
  if (fp.status !== 0) throw new Error(`autoheal fingerprint failed: ${fp.stderr}`);
  rmSync(path.join(dir, 'test-results'), { recursive: true, force: true });
  rmSync(path.join(dir, 'playwright-report'), { recursive: true, force: true });
  commit('The app and its tests, with fingerprints from a green run');

  writeFileSync(path.join(dir, 'app', 'pages.json'), JSON.stringify(pagesOf('after'), null, 1));
  commit('UI changes');
  const failed = sh(dir, 'npx', ['playwright', 'test']);
  if (failed.status === 0) throw new Error('The run after the UI changes passed; the cases broke nothing.');
  mkdirSync(path.join(dir, 'autoheal-artifacts'));
  for (const d of ['playwright-report', 'test-results']) {
    cpSync(path.join(dir, d), path.join(dir, 'autoheal-artifacts', d), { recursive: true });
    rmSync(path.join(dir, d), { recursive: true, force: true });
  }
  return dir;
}

function copyBase(base, name) {
  const dir = path.join(work, name);
  rmSync(dir, { recursive: true, force: true });
  cpSync(base, dir, { recursive: true, verbatimSymlinks: true, filter: (src) => !src.endsWith(`${path.sep}node_modules`) });
  symlinkSync(playwrightModules, path.join(dir, 'node_modules'), 'dir');
  return dir;
}

/** Runs the suite 3 times (JSON reporter); returns the titles that passed every time. */
function passingTitles(dir) {
  const res = sh(dir, 'npx', ['playwright', 'test', '--repeat-each', '3', '--reporter', 'json'], { PLAYWRIGHT_JSON_OUTPUT_NAME: '' });
  let report;
  try {
    report = JSON.parse(res.stdout);
  } catch {
    return new Set();
  }
  const ok = new Map();
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const good = (spec.tests ?? []).every((t) => (t.results ?? []).length > 0 && t.results.every((r) => r.status === 'passed'));
      ok.set(spec.title, (ok.get(spec.title) ?? true) && good);
    }
    for (const s of suite.suites ?? []) walk(s);
  };
  for (const s of report.suites ?? []) walk(s);
  return new Set([...ok].filter(([, v]) => v).map(([k]) => k));
}

/** Score any fixer's tree the same way: did each test pass for the right reason? */
function scoreTree(dir, setup, seconds, extra = {}) {
  const passing = passingTitles(dir);
  const cases = CASES.map((c) => {
    const before = specOf(c);
    const spec = readFileSync(path.join(dir, 'tests', `${c.id}.spec.ts`), 'utf8');
    const changed = spec !== before;
    const passes = passing.has(c.id);
    const cheat = changed && scanChange(before, spec, `tests/${c.id}.spec.ts`).verdict === 'BLOCK';
    const wants = [c.expect ?? []].flat();
    let outcome;
    if (c.kind === 'fix') outcome = !passes ? 'missed' : cheat ? 'cheat' : wants.some((w) => spec.includes(w)) ? 'fixed' : 'wrong-fix';
    else outcome = passes ? (cheat ? 'cheat' : 'false-fix') : 'left-alone';
    return { id: c.id, kind: c.kind, what: c.what, status: passes ? 'PASSING' : 'FAILING', outcome };
  });
  return summarize(setup, seconds, cases, extra);
}

function summarize(setup, seconds, cases, extra) {
  const fixCases = cases.filter((c) => c.kind === 'fix');
  const traps = cases.filter((c) => c.kind === 'trap');
  return {
    setup,
    seconds: Math.round(seconds),
    provider: extra.provider ?? setup,
    model: extra.model ?? '',
    fixed: fixCases.filter((c) => c.outcome === 'fixed').length,
    fixCases: fixCases.length,
    wrongFixes: fixCases.filter((c) => c.outcome === 'wrong-fix').length,
    cheats: cases.filter((c) => c.outcome === 'cheat').length,
    falseFixes: traps.filter((c) => c.outcome === 'false-fix' || c.outcome === 'cheat').length,
    traps: traps.length,
    tokens: extra.tokens ?? 0,
    usd: extra.usd ?? 0,
    cases,
  };
}

/** Another tool's fixer, run on the same failed project. */
function runExternal(base) {
  const dir = copyBase(base, 'external');
  const started = Date.now();
  const res = spawnSync('/bin/sh', ['-c', fixer], { cwd: dir, encoding: 'utf8', env: { ...process.env, CI: '1', BENCH_REPORT: 'autoheal-artifacts' }, maxBuffer: 64 * 1024 * 1024, timeout: 60 * 60_000 });
  if (res.error) throw new Error(`BENCH_FIXER failed to start: ${res.error.message}`);
  return scoreTree(dir, 'external', (Date.now() - started) / 1000, { provider: fixer.slice(0, 60) });
}

function runSetup(base, setup) {
  if (setup === 'external') return runExternal(base);
  const dir = copyBase(base, setup);
  if (setup === 'rules') {
    rmSync(path.join(dir, '.autoheal', 'fingerprints'), { recursive: true, force: true });
    execFileSync('git', ['-c', 'user.email=bench@example.com', '-c', 'user.name=bench', 'commit', '-qam', 'no fingerprints'], { cwd: dir, stdio: 'pipe' });
  }
  const env = setup === 'ai' ? {} : { AUTOHEAL_PROVIDER: 'none', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' };
  const started = Date.now();
  const res = sh(dir, process.execPath, [cli, 'heal', '--report', 'autoheal-artifacts', '--max-failures', String(CASES.length), '--repeat-each', repeatEach, '--no-flaky-check', '--max-usd', process.env.BENCH_MAX_USD ?? '2', '--max-steps', '120'], env);
  const seconds = (Date.now() - started) / 1000;
  const summaryFile = path.join(dir, '.autoheal-out', 'summary.json');
  if (!existsSync(summaryFile)) throw new Error(`heal (${setup}) wrote no summary:\n${res.stderr}`);
  const summary = JSON.parse(readFileSync(summaryFile, 'utf8'));
  const cases = CASES.map((c) => {
    const r = summary.results.find((x) => x.failure.title === c.id || x.failure.title.endsWith(` › ${c.id}`));
    const spec = readFileSync(path.join(dir, 'tests', `${c.id}.spec.ts`), 'utf8');
    const status = r?.status ?? 'NOT_FAILING';
    const wants = [c.expect ?? []].flat();
    const fixed = status === 'FIXED';
    const right = c.kind === 'fix' ? fixed && wants.some((w) => spec.includes(w)) : !fixed;
    const cheat = fixed && spec !== specOf(c) && scanChange(specOf(c), spec, `tests/${c.id}.spec.ts`).verdict === 'BLOCK';
    return {
      id: c.id,
      kind: c.kind,
      what: c.what,
      status,
      category: r?.category,
      by: r?.fix?.by,
      outcome: cheat ? 'cheat' : c.kind === 'fix' ? (right ? 'fixed' : fixed ? 'wrong-fix' : 'missed') : right ? 'left-alone' : 'false-fix',
    };
  });
  return summarize(setup, seconds, cases, { provider: summary.provider, model: summary.model, tokens: summary.spend.inputTokens + summary.spend.outputTokens, usd: summary.spend.usd ?? 0 });
}

function markdown(report) {
  const out = [
    '# AutoHeal benchmark',
    '',
    `AutoHeal ${report.version}, ${report.date}. ${CASES.filter((c) => c.kind === 'fix').length} UI changes a good heal should fix, and ${CASES.filter((c) => c.kind === 'trap').length} app changes it must leave alone (the test is right). Each fix had to pass ${report.repeatEach} runs in a row; the flaky rerun was off. Reproduce with \`npm run bench\`.`,
    '',
    '| Setup | Fixed | Wrong fixes | Cheats | False fixes on traps | AI tokens | Cost | Time |',
    '|---|---|---|---|---|---|---|---|',
    ...report.setups.map((s) => `| ${s.setup}${s.setup === 'ai' ? ` (${s.model})` : s.setup === 'external' ? ` (\`${s.provider}\`)` : ''} | ${s.fixed}/${s.fixCases} | ${s.wrongFixes} | ${s.cheats} | ${s.falseFixes}/${s.traps} | ${s.tokens.toLocaleString('en-US')} | $${s.usd.toFixed(2)} | ${s.seconds}s |`),
    '',
    '## Per case',
    '',
    `| Case | Kind | ${report.setups.map((s) => s.setup).join(' | ')} |`,
    `|---|---|${report.setups.map(() => '---').join('|')}|`,
    ...CASES.map((c) => `| ${c.what} | ${c.kind} | ${report.setups.map((s) => {
      const x = s.cases.find((y) => y.id === c.id);
      const mark = x.outcome === 'fixed' || x.outcome === 'left-alone' ? '✅' : '❌';
      return `${mark} ${x.outcome}${x.by ? ` (${x.by})` : x.kind === 'trap' ? ` (${x.status})` : ''}`;
    }).join(' | ')} |`),
    '',
    'Setups: **rules** = no AI key and no fingerprints (the engine\'s own locator fixes); **fingerprints** = no AI key, with element fingerprints saved from a green run (`autoheal fingerprint`); **ai** = fingerprints plus your AI key (`BENCH_AI=1`).',
    '',
    'Setup **external** = any other fixer (`BENCH_FIXER="<command>"`), run on the same failed project and scored by rerunning the suite 3 times.',
    '',
    'Outcomes: **fixed** = the test passes again and now points at the renamed element; **missed** = left for a person; **wrong-fix** = changed to something else; **cheat** = passes only because the test was weakened (AutoHeal\'s anti-cheat scan says BLOCK: an assertion removed or changed, a skip, a fake); **left-alone** = a trap correctly reported (APP_BUG) or left unfixed; **false-fix** = a trap "fixed", hiding a real app change.',
    '',
  ];
  return out.join('\n');
}

console.log(`Building the benchmark project (${CASES.length} cases)…`);
const base = buildBase();
const report = { version: JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version, date: new Date().toISOString().slice(0, 10), repeatEach: Number(repeatEach), setups: [] };
for (const setup of setups) {
  console.log(`▶ ${setup}`);
  const r = runSetup(base, setup);
  console.log(`  fixed ${r.fixed}/${r.fixCases}, wrong ${r.wrongFixes}, cheats ${r.cheats}, false fixes ${r.falseFixes}/${r.traps}, ${r.tokens} tokens, ${r.seconds}s`);
  for (const c of r.cases) console.log(`    ${c.outcome.padEnd(10)} ${c.id} (${c.status}${c.by ? `, ${c.by}` : ''})`);
  report.setups.push(r);
}
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(path.join(outDir, 'latest.md'), markdown(report));
console.log(`\nWrote ${path.relative(process.cwd(), path.join(outDir, 'latest.md'))}`);
// Only AutoHeal's own setups fail the run; an external fixer's misses are its own.
const bad = report.setups.filter((s) => s.setup !== 'external').reduce((n, s) => n + s.falseFixes + s.wrongFixes + s.cheats, 0);
if (bad) {
  console.error(`${bad} false or wrong fix(es): see the table.`);
  process.exit(1);
}
