#!/usr/bin/env node
/**
 * The publish job of AutoHeal AI. It runs in a fresh checkout, never runs the
 * project's code, and treats everything in the heal job's result as
 * untrusted: the patch is checked file by file before it is applied with git
 * hooks off. Then it pushes the fix branch, opens or updates the PR, opens
 * issues for confident app bugs, posts the comment (comment mode) and sends
 * the results to your dashboard. No dependencies; needs git and the gh CLI.
 *
 * Settings come from the environment (publish/action.yml sets them):
 *   RESULT_DIR, MODE, BASE_BRANCH, RUN_ID, COMMIT, PR_NUMBER, BLOCKED,
 *   OPEN_ISSUES, GH_TOKEN, DASHBOARD_URL, DASHBOARD_SECRET
 */

import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { appendFileSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'commit.gpgsign=false'];
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 60;
const MAX_BODY = 60_000;
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/;
const NEW_OK = /(?:^|\/)(?:\.autoheal\/memory\/[0-9a-f]{16}\.json|playwright-quarantine\.json)$/;
const CONFIG = /(?:^|\/)(?:[\w.-]+\.config\.[cm]?[jt]s|conftest\.py|setup\.py|noxfile\.py|package\.json)$/;

export class Refused extends Error {}

const summaryLine = (line) => {
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
};

/**
 * Reads a regular file without following symlinks. The check and the read use
 * the same open file, so the file cannot be swapped in between.
 */
function readRegular(file, maxBytes) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    if (st.size > maxBytes) throw new Refused(`${path.basename(file)} is larger than ${maxBytes} bytes`);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function readText(dir, name, max = MAX_BODY) {
  const text = readRegular(path.join(dir, name), 8 * 1024 * 1024);
  if (text === null) return null;
  return text.length > max ? `${text.slice(0, max)}\n\n_(cut to ${max} characters)_\n` : text;
}

function readJson(dir, name) {
  const text = readText(dir, name, 5 * 1024 * 1024);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** True when `rel` is a safe, plain, repo-relative path. */
export function safePath(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 400) return false;
  if (/[\0-\x1f\x7f\\"]/.test(rel) || rel.startsWith('/') || rel.startsWith('-')) return false;
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  if (parts.some((p) => p.toLowerCase() === '.git' || p === 'node_modules')) return false;
  if (parts[0] === '.github') return false;
  return true;
}

/**
 * Splits a git patch into files and checks each header. Only plain content
 * edits of existing files and new memory/quarantine files are accepted:
 * no renames, copies, deletes, mode changes, symlinks or binary data.
 */
export function parsePatch(patch) {
  if (!patch.startsWith('diff --git ')) throw new Refused('the patch does not start with a git diff header');
  const files = [];
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    const lines = chunk.split('\n');
    const header = lines[0].slice('diff --git '.length);
    const n = (header.length - 5) / 2;
    const name = Number.isInteger(n) && n > 0 ? header.slice(2, 2 + n) : '';
    if (!name || header !== `a/${name} b/${name}`) throw new Refused(`unreadable or renamed path in "${lines[0].slice(0, 120)}"`);
    if (!safePath(name)) throw new Refused(`path not allowed: ${name}`);
    let isNew = false;
    let i = 1;
    for (; i < lines.length && !lines[i].startsWith('@@'); i++) {
      const line = lines[i];
      if (line === '' && i === lines.length - 1) break;
      if (/^index [0-9a-f]+\.\.[0-9a-f]+(?: 100644)?$/.test(line)) continue;
      if (line === 'new file mode 100644') {
        isNew = true;
        continue;
      }
      if (line === `--- a/${name}` || (isNew && line === '--- /dev/null') || line === `+++ b/${name}`) continue;
      throw new Refused(`${name}: unsupported change "${line.slice(0, 80)}" (only plain text edits are allowed)`);
    }
    if (files.some((f) => f.path === name)) throw new Refused(`${name} appears twice in the patch`);
    files.push({ path: name, isNew });
  }
  return files;
}

/** Checks each patched file against the checkout. */
export function checkFiles(root, files, changedList) {
  if (files.length > MAX_FILES) throw new Refused(`too many files (${files.length})`);
  const realRoot = realpathSync(root);
  for (const f of files) {
    if (changedList && !changedList.includes(f.path)) throw new Refused(`${f.path} is not in the list of healed files`);
    if (CONFIG.test(f.path)) throw new Refused(`${f.path} is a config file; fixes may only change tests, page objects and AutoHeal's own files`);
    if (f.isNew) {
      if (!NEW_OK.test(f.path)) throw new Refused(`new file not allowed: ${f.path}`);
    } else if (!SOURCE.test(f.path) && !NEW_OK.test(f.path)) {
      throw new Refused(`${f.path}: only source files can be changed`);
    }
    const abs = path.join(realRoot, f.path);
    // Every existing folder on the way must be a real folder inside the repo.
    let dir = path.dirname(abs);
    while (dir !== realRoot && !existsSync(dir)) dir = path.dirname(dir);
    if (realpathSync(dir) !== dir || !(dir === realRoot || dir.startsWith(realRoot + path.sep))) throw new Refused(`${f.path} goes through a symlink`);
    if (existsSync(abs) || isLink(abs)) {
      if (f.isNew) throw new Refused(`${f.path} already exists`);
      const st = lstatSync(abs);
      if (!st.isFile()) throw new Refused(`${f.path} is not a regular file`);
    } else if (!f.isNew) {
      throw new Refused(`${f.path} does not exist in the checkout`);
    }
  }
}

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

const git = (args, opts = {}) => execFileSync('git', [...SAFE, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

function pushAuth() {
  if (!env.GH_TOKEN) return [];
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  const basic = Buffer.from(`x-access-token:${env.GH_TOKEN}`).toString('base64');
  console.log(`::add-mask::${basic}`);
  return ['-c', `http.${server}/.extraheader=`, '-c', `http.${server}/.extraheader=AUTHORIZATION: basic ${basic}`];
}

/** Applies the checked patch on a fresh branch and opens or updates the PR. */
export function publishPatch({ root, dir, mode, base, runId, fixed }) {
  const patchFile = path.join(dir, 'patch.diff');
  const patch = readRegular(patchFile, MAX_PATCH_BYTES);
  if (!patch?.trim()) return null;
  if (base.startsWith('autoheal/')) {
    console.log('Refusing to open a PR against another AutoHeal branch.');
    return null;
  }
  const changedText = readText(dir, 'changed-files.txt', 100_000);
  const changedList = changedText === null ? null : changedText.split('\n').filter(Boolean);
  const files = parsePatch(patch);
  checkFiles(root, files, changedList);

  const branch = `autoheal/${runId}`;
  git(['checkout', '-q', '-B', branch], { cwd: root });
  // Apply exactly the text that was checked, from a private copy.
  const checked = path.join(mkdtempSync(path.join(os.tmpdir(), 'autoheal-')), 'checked.diff');
  writeFileSync(checked, patch, { mode: 0o600 });
  git(['apply', '--check', '--whitespace=nowarn', checked], { cwd: root });
  git(['apply', '--whitespace=nowarn', checked], { cwd: root });
  git(['add', '--', ...files.map((f) => f.path)], { cwd: root });
  const staged = git(['diff', '--cached', '--name-only'], { cwd: root }).split('\n').filter(Boolean).sort();
  const expected = files.map((f) => f.path).sort();
  if (JSON.stringify(staged) !== JSON.stringify(expected)) throw new Refused(`staged files differ from the patch (${staged.join(', ')})`);
  git(['-c', 'user.name=autoheal-ai[bot]', '-c', 'user.email=autoheal-ai@users.noreply.github.com', 'commit', '-q', '--no-verify', '-m', `test: AutoHeal fixes for failed run ${runId}`, '-m', 'Verified by the AutoHeal anti-cheat guard and a stability rerun.'], { cwd: root });
  git([...pushAuth(), 'push', '--force', 'origin', `HEAD:refs/heads/${branch}`], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });

  const bodyFile = path.join(dir, 'pr-body.md');
  const body = readText(dir, 'pr-body.md') ?? `AutoHeal fixes for failed run ${runId}.`;
  writeFileSync(bodyFile, body);
  const existing = (() => {
    try {
      return gh('pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url');
    } catch {
      return '';
    }
  })();
  if (existing) {
    gh('pr', 'edit', existing, '--body-file', bodyFile);
    return existing;
  }
  const args = ['pr', 'create', '--base', base, '--head', branch, '--title', `AutoHeal: ${fixed} test fix(es) for run ${runId}`, '--body-file', bodyFile];
  if (mode === 'draft-pr') args.push('--draft');
  return gh(...args);
}

export function publishIssues(dir) {
  const list = readJson(dir, 'issues.json');
  if (!Array.isArray(list)) return [];
  let open = [];
  if (list.length) {
    try {
      open = JSON.parse(gh('issue', 'list', '--state', 'open', '--limit', '200', '--search', 'AutoHeal in:title', '--json', 'title,url'));
    } catch {
      open = [];
    }
  }
  const done = [];
  for (const issue of list.slice(0, 10)) {
    if (typeof issue?.title !== 'string' || !issue.title.startsWith('AutoHeal') || issue.title.length > 200) continue;
    if (typeof issue.file !== 'string' || !/^issue-\d{1,2}\.md$/.test(issue.file)) continue;
    const text = readText(dir, issue.file);
    if (text === null) continue;
    const bodyFile = path.join(dir, issue.file);
    writeFileSync(bodyFile, text);
    const existing = open.find((o) => o.title === issue.title);
    let url;
    if (existing) {
      gh('issue', 'comment', existing.url, '--body-file', bodyFile);
      url = existing.url;
    } else {
      url = gh('issue', 'create', '--title', issue.title, '--body-file', bodyFile);
    }
    summaryLine(`App bug issue: ${url}`);
    done.push({ test: typeof issue.test === 'string' ? issue.test : '', url });
  }
  return done;
}

export function publishComment(dir) {
  const text = readText(dir, 'comment.md');
  if (!text) return;
  const file = path.join(dir, 'comment.md');
  writeFileSync(file, text);
  if (/^\d+$/.test(env.PR_NUMBER ?? '')) gh('pr', 'comment', env.PR_NUMBER, '--body-file', file);
  else if (/^[0-9a-f]{40}$/.test(env.COMMIT ?? '')) gh('api', `repos/${env.GITHUB_REPOSITORY}/commits/${env.COMMIT}/comments`, '-F', `body=@${file}`);
  else console.log('No PR or commit to comment on.');
}

export async function uploadDashboard(dir, prUrl, issues) {
  if (!env.DASHBOARD_URL || !env.DASHBOARD_SECRET) return;
  const events = readJson(dir, 'events.json');
  if (!Array.isArray(events) || !events.length) return;
  const issueUrls = Object.fromEntries(issues.map((i) => [i.test, i.url]));
  const clean = events.slice(0, 200).map((e) => {
    const out = { ...e, repo: env.GITHUB_REPOSITORY ?? e.repo };
    if (prUrl && (e.status === 'FIXED' || e.status === 'QUARANTINED')) out.pr_url = prUrl;
    if (e.status === 'APP_BUG' && issueUrls[e.test_title]) out.issue_url = issueUrls[e.test_title];
    return out;
  });
  const body = JSON.stringify({ version: 1, events: clean });
  const ts = Math.floor(Date.now() / 1000);
  const signature = `sha256=${createHmac('sha256', env.DASHBOARD_SECRET).update(`${ts}.${body}`).digest('hex')}`;
  try {
    const res = await fetch(`${env.DASHBOARD_URL.replace(/\/+$/, '')}/api/heal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-autoheal-signature': signature, 'x-autoheal-timestamp': String(ts) },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    console.log(`Dashboard upload: HTTP ${res.status}`);
  } catch (err) {
    // The dashboard is optional: a failed upload never fails the job.
    console.log(`Dashboard upload failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  const dir = path.resolve(env.RESULT_DIR || 'autoheal-result');
  const root = process.cwd();
  const mode = env.MODE || 'draft-pr';
  if (!['comment', 'draft-pr', 'pr'].includes(mode)) throw new Refused(`mode must be comment, draft-pr or pr (got "${mode}")`);
  const runId = env.RUN_ID ?? '';
  if (!/^\d{1,20}$/.test(runId)) throw new Refused('RUN_ID must be the numeric id of the failed run');
  const meta = readJson(dir, 'meta.json');
  if (!meta) {
    console.log('No AutoHeal result to publish.');
    return Number(env.BLOCKED) > 0 ? 3 : 0;
  }
  const blocked = Math.max(Number(env.BLOCKED) || 0, Number(meta.blocked) || 0);
  const fixed = Math.min(Math.max(Number(meta.fixed) || 0, 0), 999);
  let prUrl = null;
  let issues = [];
  if (mode === 'comment') {
    publishComment(dir);
  } else {
    const base = env.BASE_BRANCH ?? '';
    if (!/^[\w./-]{1,200}$/.test(base) || base.includes('..') || base.startsWith('-')) throw new Refused(`bad base branch "${base}"`);
    prUrl = publishPatch({ root, dir, mode, base, runId, fixed });
    if (prUrl) summaryLine(`Fix PR: ${prUrl}`);
    if (env.OPEN_ISSUES !== 'false') issues = publishIssues(dir);
  }
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `pr-url=${prUrl ?? ''}\n`);
  await uploadDashboard(dir, prUrl, issues);
  return blocked > 0 ? 3 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      if (code === 3) console.log('::error title=AutoHeal blocked a fix::A proposed fix tried to weaken a test (BLOCKED_CHEATING). See the heal job summary.');
      process.exit(code === 3 ? 1 : code);
    },
    (err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`::error title=AutoHeal publish refused::${message.replace(/\n/g, ' ')}`);
      process.exit(1);
    },
  );
}
