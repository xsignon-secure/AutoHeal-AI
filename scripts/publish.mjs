#!/usr/bin/env node
/**
 * The publish job of AutoHeal AI. It runs in a fresh checkout, never runs the
 * project's code, and treats everything in the heal job's result as
 * untrusted: the patch is checked file by file before it is applied with git
 * hooks off. Then it pushes the fix branch, opens or updates the PR, opens
 * issues for confident app bugs, posts the comment (comment mode) and sends
 * the results to your dashboard. No dependencies; needs git and Node. It
 * works the same in GitHub Actions, GitLab CI and CircleCI (scripts/forge.mjs
 * talks to GitHub or GitLab).
 *
 * Nothing from the heal job is trusted. Here, on the trusted checkout, the
 * job checks four things:
 *   - each file is inside ALLOWED_PATHS;
 *   - the anti-cheat scan passes again on every changed source file;
 *   - quarantine entries are new or extended only within QUARANTINE_DAYS, and
 *     only for tests the result reports as flaky;
 *   - memory files have exactly AutoHeal's shape and name.
 *
 * Settings come from the environment (publish/action.yml or `autoheal
 * publish` sets them):
 *   RESULT_DIR, MODE, BASE_BRANCH, RUN_ID, COMMIT, PR_NUMBER, BLOCKED,
 *   OPEN_ISSUES, GH_TOKEN, DASHBOARD_URL, DASHBOARD_SECRET, ALLOWED_PATHS,
 *   ALLOW_WARN, QUARANTINE_DAYS, RERUN_WORKFLOW, FIX_TARGET
 * and, outside GitHub Actions, from the CI's own variables (src/ci.ts) and
 * AUTOHEAL_GITLAB_TOKEN or AUTOHEAL_GITHUB_TOKEN.
 *
 * The repository's .autoheal.yml (read from this checkout, which the patch
 * can never change) is enforced again here: protected paths, quarantine,
 * fixes per PR and issues.
 */

import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { appendFileSync, closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProtected, loadPolicy, PolicyError, POLICY_FILE } from '../dist/policy.js';
import { ciInfo, isAutohealBranch } from '../dist/ci.js';
import { forgeFor, ForgeError } from './forge.mjs';

const env = process.env;
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'commit.gpgsign=false'];
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 60;
const MAX_FINGERPRINT_FILES = 60;
const MAX_BODY = 60_000;
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/;
const NEW_OK = /(?:^|\/)(?:\.autoheal\/(?:memory|fingerprints)\/[0-9a-f]{16}\.json|playwright-quarantine\.json)$/;
/** Files that tools run or load on their own: never patched, even inside the allowed paths. */
const CONFIG = /(?:^|\/)(?:[\w.-]+\.(?:config|setup|conf)\.[cm]?[jt]sx?|(?:global|jest|vitest|test)[-.]?(?:setup|teardown)[\w.-]*\.[cm]?[jt]sx?|conftest\.py|setup\.py|noxfile\.py|__init__\.py|__main__\.py|sitecustomize\.py|usercustomize\.py|package\.json|\.pnpmfile\.cjs|[gG]ulpfile\.[\w.]+|[gG]runtfile\.[\w.]+|Jakefile[\w.]*|\.eslintrc[\w.]*|\.babelrc[\w.]*|babel\.config[\w.]*|cypress(?:\.env)?\.json|cypress\/(?:support|plugins)\/.+)$/;
/** Where fixes may land unless the workflow says otherwise. */
export const DEFAULT_ALLOWED_PATHS = ['**/tests/**', '**/test/**', '**/e2e/**', '**/playwright/**', '**/*.spec.*', '**/*.test.*', '**/*.cy.*', '**/test_*.py', '**/*_test.py'];
const QUARANTINE_FILE = /(?:^|\/)playwright-quarantine\.json$/;
const MEMORY_FILE = /(?:^|\/)\.autoheal\/memory\/([0-9a-f]{16})\.json$/;
const FINGERPRINT_FILE = /(?:^|\/)\.autoheal\/fingerprints\/([0-9a-f]{16})\.json$/;

const { scanChange } = await import(new URL('../dist/cheat.js', import.meta.url).href);

/** Turns a path glob (`**`, `*`, `?`) into a matcher, without building a regex from the text. */
export function globMatcher(glob) {
  const g = glob.trim().replace(/^\.\//, '');
  const match = (pi, si, s) => {
    for (;;) {
      if (pi === g.length) return si === s.length;
      if (g.startsWith('**/', pi)) {
        for (let k = si; k <= s.length; k++) if ((k === si || s[k - 1] === '/') && match(pi + 3, k, s)) return true;
        return false;
      }
      if (g.startsWith('**', pi)) return true;
      const c = g[pi];
      if (c === '*') {
        for (let k = si; k <= s.length; k++) {
          if (match(pi + 1, k, s)) return true;
          if (s[k] === '/') return false;
        }
        return false;
      }
      if (si >= s.length || (c === '?' ? s[si] === '/' : s[si] !== c)) return false;
      pi++;
      si++;
    }
  };
  return (file) => g.length > 0 && g.length <= 200 && file.length <= 400 && match(0, 0, file);
}

export function allowedPaths(text) {
  const list = (text ?? '').split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  return (list.length ? list : DEFAULT_ALLOWED_PATHS).slice(0, 50).map(globMatcher);
}

/** Stops @mentions in text from the heal job from notifying people. */
export function neutralize(text) {
  return text.replace(/(^|[^\w`/.@-])@(?=[A-Za-z0-9])/g, '$1@\u200b');
}

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

/** Checks each patched file against the checkout and the allowed paths. */
/** The repository's .autoheal.yml, or null. A broken one stops the publish. */
export function readPolicy(root) {
  try {
    return loadPolicy(root);
  } catch (err) {
    if (err instanceof PolicyError) throw new Refused(err.message);
    throw err;
  }
}

/** What the policy says about this patch (on top of the workflow's own rules). */
export function checkPolicy(policy, files, fixed) {
  for (const f of files) {
    if (f.path === POLICY_FILE || f.path.endsWith(`/${POLICY_FILE}`)) throw new Refused(`${f.path}: a fix may never change the policy file`);
    if (!policy) continue;
    if (isProtected(policy, f.path)) throw new Refused(`${f.path} is protected by ${POLICY_FILE}`);
    if (QUARANTINE_FILE.test(f.path) && !policy.quarantine.enabled) throw new Refused(`${f.path}: ${POLICY_FILE} turns quarantine off`);
  }
  const max = policy?.fixes.maxPerPr;
  if (max !== undefined && fixed > max) throw new Refused(`${fixed} fixes, but ${POLICY_FILE} allows at most ${max} per PR`);
}

export function checkFiles(root, files, changedList, allowed = allowedPaths(env.ALLOWED_PATHS)) {
  const prints = files.filter((f) => FINGERPRINT_FILE.test(f.path)).length;
  if (files.length - prints > MAX_FILES) throw new Refused(`too many files (${files.length - prints})`);
  if (prints > MAX_FINGERPRINT_FILES) throw new Refused(`too many fingerprint files (${prints})`);
  const realRoot = realpathSync(root);
  for (const f of files) {
    if (changedList && !changedList.includes(f.path)) throw new Refused(`${f.path} is not in the list of healed files`);
    const own = QUARANTINE_FILE.test(f.path) || MEMORY_FILE.test(f.path) || FINGERPRINT_FILE.test(f.path);
    if (!own && CONFIG.test(f.path)) throw new Refused(`${f.path} is a file that tools load or run; fixes may only change tests and page objects`);
    if (!own && !allowed.some((m) => m(f.path))) throw new Refused(`${f.path} is outside allowed-paths; fixes may only change tests and page objects there`);
    if (f.isNew) {
      if (!NEW_OK.test(f.path)) throw new Refused(`new file not allowed: ${f.path}`);
    } else if (!SOURCE.test(f.path) && !NEW_OK.test(f.path)) {
      throw new Refused(`${f.path}: only source files can be changed`);
    }
    const abs = path.join(realRoot, f.path);
    // Every existing folder on the way must be a real folder inside the repo.
    let dir = path.dirname(abs);
    while (dir !== realRoot && !lstatOrNull(dir)) dir = path.dirname(dir);
    if (realpathSync(dir) !== dir || !(dir === realRoot || dir.startsWith(realRoot + path.sep))) throw new Refused(`${f.path} goes through a symlink`);
    const st = lstatOrNull(abs);
    if (st) {
      if (f.isNew) throw new Refused(`${f.path} already exists`);
      if (!st.isFile()) throw new Refused(`${f.path} is not a regular file`);
    } else if (!f.isNew) {
      throw new Refused(`${f.path} does not exist in the checkout`);
    }
  }
}

function sameFiles(seen, expected, what) {
  const a = [...new Set(seen)].sort();
  const b = [...new Set(expected)].sort();
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Refused(`${what} shows different files than the patch header (${a.slice(0, 5).join(', ')})`);
}

/** Re-runs the anti-cheat scan on each changed source file: the trusted copy before, the patched copy after. */
export function rescan(root, files, befores, allowWarn = env.ALLOW_WARN === 'true') {
  for (const f of files) {
    if (!SOURCE.test(f.path)) continue;
    const before = befores.get(f.path) ?? '';
    const after = readRegular(path.join(root, f.path), 4 * 1024 * 1024) ?? '';
    const report = scanChange(before, after, f.path);
    const bad = report.findings.filter((x) => x.severity === 'BLOCK' || !allowWarn);
    if (bad.length) throw new Refused(`${f.path} fails the anti-cheat scan here: ${bad.slice(0, 3).map((x) => `${x.rule} (${x.message})`).join('; ')}`);
  }
}

const isoDay = (d) => d.toISOString().slice(0, 10);
const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\0-\x1f]/.test(v);

/**
 * Quarantine entries may only be added or extended, only for tests the result
 * reports as QUARANTINED, and for at most QUARANTINE_DAYS from today.
 */
export function checkQuarantine(root, rel, beforeText, results, days = Number(env.QUARANTINE_DAYS) || 14, now = new Date()) {
  const limit = Math.min(Math.max(Math.floor(days), 1), 90);
  const parse = (text, what) => {
    if (text === null || text === '') return { version: 1, entries: [] };
    let q;
    try {
      q = JSON.parse(text);
    } catch {
      throw new Refused(`${rel}: ${what} is not valid JSON`);
    }
    if (!q || q.version !== 1 || !Array.isArray(q.entries)) throw new Refused(`${rel}: ${what} is not a quarantine file`);
    return q;
  };
  const before = parse(beforeText, 'the checkout copy');
  const after = parse(readRegular(path.join(root, rel), 1024 * 1024), 'the patched copy');
  const key = (e) => `${e?.file}\n${e?.title}`;
  const keep = new Map(before.entries.map((e) => [key(e), JSON.stringify(e)]));
  for (const e of before.entries) {
    if (!after.entries.some((x) => key(x) === key(e))) throw new Refused(`${rel}: the patch removes the quarantine entry for ${e.file} › ${e.title}`);
  }
  const flaky = new Set(
    (Array.isArray(results) ? results : [])
      .filter((r) => r?.status === 'QUARANTINED' && typeof r.failure?.file === 'string' && typeof r.failure?.title === 'string')
      .map((r) => `${r.failure.file}\n${r.failure.title}`),
  );
  const latest = isoDay(new Date(now.getTime() + (limit + 1) * 86_400_000));
  const dir = path.dirname(path.join(root, rel));
  let changed = 0;
  for (const e of after.entries) {
    if (keep.get(key(e)) === JSON.stringify(e)) continue;
    changed++;
    if (!e || typeof e !== 'object' || Object.keys(e).some((k) => !['file', 'title', 'owner', 'reason', 'until', 'added', 'project'].includes(k))) throw new Refused(`${rel}: unexpected fields in a quarantine entry`);
    if (!str(e.file, 400) || !str(e.title, 500) || !str(e.owner, 200) || !str(e.reason, 500)) throw new Refused(`${rel}: a quarantine entry is missing file, title, owner or reason`);
    if (!safePath(e.file)) throw new Refused(`${rel}: bad test path ${JSON.stringify(e.file).slice(0, 80)}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.until)) || e.until > latest) throw new Refused(`${rel}: ${e.file} › ${e.title} is quarantined until ${e.until}, more than ${limit} days (quarantine-days)`);
    // Result titles are the full path ("file.spec.ts › describe › test"); the entry keeps the test's own title.
    const sameTest = (k) => {
      const [file, title] = k.split('\n');
      // Cypress joins describe and it titles with spaces.
      const cypressTitle = /\.cy\.[cm]?[jt]sx?$/.test(e.file) && title.endsWith(` ${e.title}`);
      return (file === e.file || file.endsWith(`/${e.file}`)) && (title === e.title || title.endsWith(` › ${e.title}`) || cypressTitle);
    };
    if (![...flaky].some(sameTest)) {
      throw new Refused(`${rel}: ${e.file} › ${e.title} is not a test this run found flaky`);
    }
    const spec = readRegular(path.join(dir, e.file), 4 * 1024 * 1024);
    if (spec === null || !spec.includes(e.title)) throw new Refused(`${rel}: ${e.file} › ${e.title} is not a test in this checkout`);
  }
  if (changed > Math.max(flaky.size, 0) || changed > 10) throw new Refused(`${rel}: ${changed} quarantine entries changed, but the run found ${flaky.size} flaky test(s)`);
}

/** A memory file must have AutoHeal's exact shape, and its name must be the hash AutoHeal gives it. */
export function checkMemory(root, rel) {
  const id = MEMORY_FILE.exec(rel)?.[1];
  const text = readRegular(path.join(root, rel), 16 * 1024);
  let e;
  try {
    e = JSON.parse(text ?? '');
  } catch {
    throw new Refused(`${rel}: not valid JSON`);
  }
  const keys = ['at', 'file', 'test', 'rootCause', 'before', 'after', 'note'];
  if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).some((k) => !keys.includes(k))) throw new Refused(`${rel}: unexpected fields`);
  if (!str(e.at, 40) || Number.isNaN(Date.parse(e.at)) || !str(e.file, 400) || !str(e.test, 500) || !/^[\w-]{1,40}$/.test(String(e.rootCause))) {
    throw new Refused(`${rel}: not an AutoHeal memory entry`);
  }
  for (const k of ['before', 'after', 'note']) if (e[k] !== undefined && (typeof e[k] !== 'string' || e[k].length > 301)) throw new Refused(`${rel}: ${k} is too long`);
  const expect = createHash('sha256').update(`${e.file}\n${e.test}\n${e.after ?? ''}`).digest('hex').slice(0, 16);
  if (id !== expect) throw new Refused(`${rel}: the file name does not match its content`);
}

const FINGERPRINT_KEYS = ['tag', 'role', 'name', 'text', 'testId', 'id', 'nameAttr', 'type', 'label', 'placeholder', 'href', 'near'];

/** An element fingerprint: only the expected short fields, named after its own content. */
export function checkFingerprint(root, rel) {
  const id = FINGERPRINT_FILE.exec(rel)?.[1];
  const text = readRegular(path.join(root, rel), 16 * 1024);
  let e;
  try {
    e = JSON.parse(text ?? '');
  } catch {
    throw new Refused(`${rel}: not valid JSON`);
  }
  const keys = ['at', 'selector', 'page', 'file', 'fingerprint'];
  if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).some((k) => !keys.includes(k))) throw new Refused(`${rel}: unexpected fields`);
  if (!str(e.at, 40) || Number.isNaN(Date.parse(e.at)) || !str(e.selector, 1000) || (e.page !== undefined && !str(e.page, 400)) || (e.file !== undefined && !str(e.file, 400))) {
    throw new Refused(`${rel}: not an AutoHeal fingerprint`);
  }
  const fp = e.fingerprint;
  if (!fp || typeof fp !== 'object' || Array.isArray(fp) || Object.keys(fp).some((k) => !FINGERPRINT_KEYS.includes(k))) throw new Refused(`${rel}: unexpected fingerprint fields`);
  if (typeof fp.tag !== 'string' || !/^[A-Z][A-Z0-9-]{0,40}$/.test(fp.tag)) throw new Refused(`${rel}: bad tag`);
  for (const k of FINGERPRINT_KEYS) if (fp[k] !== undefined && (typeof fp[k] !== 'string' || fp[k].length > 200)) throw new Refused(`${rel}: ${k} is too long`);
  const expect = createHash('sha256').update(`${e.selector}\n${e.page ?? ''}`).digest('hex').slice(0, 16);
  if (id !== expect) throw new Refused(`${rel}: the file name does not match its content`);
}

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

export const git = (args, opts = {}) => execFileSync('git', [...SAFE, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

/** git -c options that send the forge token to its own server only (never written to .git/config). */
export function pushAuth(forge) {
  if (!forge?.pushHeader) return [];
  if (env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${forge.pushHeader.slice(forge.pushHeader.indexOf('basic ') + 6)}`);
  let server = forge.server;
  while (server.endsWith('/')) server = server.slice(0, -1);
  return ['-c', `http.${server}/.extraheader=`, '-c', `http.${server}/.extraheader=${forge.pushHeader}`];
}

const EVIDENCE_NAME = /^\d{1,3}-(?:before|after)\.(?:png|jpeg)$/;
const MAX_EVIDENCE = 20;
const MAX_EVIDENCE_BYTES = 1_500_000;
const EVIDENCE_MARKER = /<!-- autoheal-evidence(?: before="([^"]{1,40})")?(?: after="([^"]{1,40})")? -->/g;

/** The heal job's before/after screenshots that are real PNG or JPEG files of a sane size. */
export function evidenceImages(dir) {
  const out = new Map();
  const folder = path.join(dir, 'evidence');
  let names = [];
  try {
    names = readdirSync(folder);
  } catch {
    return out;
  }
  for (const name of names.filter((n) => EVIDENCE_NAME.test(n)).sort().slice(0, MAX_EVIDENCE)) {
    let fd;
    try {
      fd = openSync(path.join(folder, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch {
      continue;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > MAX_EVIDENCE_BYTES || st.size < 8) continue;
      const buf = readFileSync(fd);
      const png = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
      if ((name.endsWith('.png') && png) || (name.endsWith('.jpeg') && jpeg)) out.set(name, buf);
    } finally {
      closeSync(fd);
    }
  }
  return out;
}

/** Replaces the evidence markers in a PR body with images; markers without images are removed. */
export function placeEvidence(body, urls) {
  return body.replace(EVIDENCE_MARKER, (_m, before, after) => {
    const b = before && urls.get(before);
    const a = after && urls.get(after);
    if (!b && !a) return '';
    return ['| Before | After |', '|---|---|', `| ${b ? `![before](${b})` : '(none)'} | ${a ? `![after](${a})` : '(none)'} |`].join('\n');
  });
}

/**
 * Puts the screenshots where the PR can show them. GitLab: the project's
 * uploads. GitHub: a commit on the autoheal-evidence branch (images only,
 * never merged), linked by commit SHA so later runs cannot change them.
 */
export async function hostEvidence({ forge, root, dir, runId }) {
  const urls = new Map();
  const images = evidenceImages(dir);
  if (!images.size) return urls;
  try {
    if (forge.uploadImage) {
      for (const [name, buf] of images) urls.set(name, await forge.uploadImage(name, buf, name.endsWith('.png') ? 'image/png' : 'image/jpeg'));
      return urls;
    }
    if (!forge.imageUrl) return urls;
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'autoheal-ev-'));
    const genv = { ...process.env, GIT_INDEX_FILE: path.join(tmp, 'index') };
    const auth = pushAuth(forge);
    let parent = '';
    try {
      git([...auth, 'fetch', '-q', '--depth=1', forge.pushUrl, '+refs/heads/autoheal-evidence:refs/autoheal/evidence'], { cwd: root });
      parent = git(['rev-parse', '--verify', '-q', 'refs/autoheal/evidence^{commit}'], { cwd: root }).trim();
    } catch {
      parent = '';
    }
    if (parent) git(['read-tree', `${parent}^{tree}`], { cwd: root, env: genv });
    else git(['read-tree', '--empty'], { cwd: root, env: genv });
    for (const [name, buf] of images) {
      const blob = execFileSync('git', [...SAFE, 'hash-object', '-w', '--stdin'], { cwd: root, input: buf, encoding: 'utf8' }).trim();
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${runId}/${name}`], { cwd: root, env: genv });
    }
    const tree = git(['write-tree'], { cwd: root, env: genv }).trim();
    const who = ['-c', 'user.name=autoheal-ai[bot]', '-c', 'user.email=autoheal-ai@users.noreply.github.com'];
    const commit = git([...who, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `AutoHeal screenshots for run ${runId}`], { cwd: root }).trim();
    git([...auth, 'push', '-q', forge.pushUrl, `${commit}:refs/heads/autoheal-evidence`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const name of images.keys()) urls.set(name, forge.imageUrl(commit, `${runId}/${name}`));
  } catch (err) {
    // Screenshots are a help: without them the PR still links the run's artifacts.
    console.log(`Screenshots not shown in the ${forge.label}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
  return urls;
}

/** Applies the checked patch on a fresh branch and opens or updates the PR. */
export async function publishPatch({ root, dir, mode, base, runId, fixed, forge, rerun, target = 'new-pr', pr: sourcePr = '' }) {
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
  const policy = readPolicy(root);
  checkPolicy(policy, files, Math.max(Number(fixed) || 0, 0));
  checkFiles(root, files, changedList);
  const befores = new Map(files.filter((f) => !f.isNew).map((f) => [f.path, readRegular(path.join(root, f.path), 4 * 1024 * 1024)]));
  const memories = files.filter((f) => MEMORY_FILE.test(f.path));
  const fixedCount = Math.max(Number(fixed) || 0, 0);
  if (memories.length > Math.min(fixedCount * 3, 30)) throw new Refused(`${memories.length} memory files for ${fixedCount} fix(es)`);

  const branch = `autoheal/${runId}`;
  git(['checkout', '-q', '-B', branch], { cwd: root });
  // Apply exactly the text that was checked, from a private copy.
  const checked = path.join(mkdtempSync(path.join(os.tmpdir(), 'autoheal-')), 'checked.diff');
  writeFileSync(checked, patch, { mode: 0o600 });
  git(['apply', '--check', '--whitespace=nowarn', checked], { cwd: root });
  // git's own reading of the patch must name exactly the files we checked.
  const numstat = git(['apply', '--numstat', '-z', checked], { cwd: root }).split('\0').filter(Boolean);
  const applied = numstat.map((row) => {
    const [add, del, ...rest] = row.split('\t');
    if (add === '-' || del === '-') throw new Refused(`git sees binary data in the patch (${rest.join('\t')})`);
    return rest.join('\t');
  });
  sameFiles(applied, files.map((f) => f.path), 'git apply --numstat');
  git(['apply', '--whitespace=nowarn', checked], { cwd: root });
  // And the working tree must have changed in exactly those files.
  const resultRel = path.relative(realpathSync(root), realpathSync(dir)).split(path.sep).join('/');
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no'], { cwd: root })
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(3))
    .filter((p) => !(resultRel && !resultRel.startsWith('..') && (p === resultRel || p.startsWith(`${resultRel}/`))));
  sameFiles(status, files.map((f) => f.path), 'git status after applying');
  // The heal job's own checks are not trusted: run them again here.
  rescan(root, files, befores);
  const results = readJson(dir, 'summary.json')?.results;
  for (const f of files) {
    if (QUARANTINE_FILE.test(f.path)) checkQuarantine(root, f.path, befores.get(f.path) ?? null, results, Math.min(Number(env.QUARANTINE_DAYS) || 14, policy?.quarantine.maxDays ?? 90));
    if (MEMORY_FILE.test(f.path)) checkMemory(root, f.path);
    if (FINGERPRINT_FILE.test(f.path)) checkFingerprint(root, f.path);
  }
  git(['add', '--', ...files.map((f) => f.path)], { cwd: root });
  const staged = git(['diff', '--cached', '--name-only'], { cwd: root }).split('\n').filter(Boolean).sort();
  const expected = files.map((f) => f.path).sort();
  if (JSON.stringify(staged) !== JSON.stringify(expected)) throw new Refused(`staged files differ from the patch (${staged.join(', ')})`);
  git(['-c', 'user.name=autoheal-ai[bot]', '-c', 'user.email=autoheal-ai@users.noreply.github.com', 'commit', '-q', '--no-verify', '-m', `${COMMIT_SUBJECT} ${runId}`, '-m', 'Verified by the AutoHeal anti-cheat guard and a stability rerun.'], { cwd: root });

  // fix-target pr-branch: the fix goes onto the failing PR's own branch, as one
  // more commit (never forced, never the default branch). Anything else falls
  // back to a separate fix PR.
  if (target === 'pr-branch') {
    const onto = await prBranchTarget(forge, base, sourcePr);
    if (onto.ok) {
      try {
        git([...pushAuth(forge), 'push', forge.pushUrl, `HEAD:refs/heads/${base}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        summaryLine(`Pushed the fix onto ${base}, the branch of ${forge.label} ${sourcePr}.`);
        if (rerun) await rerunTests(forge, rerun, base);
        const url = forge.prLink ? forge.prLink(sourcePr) : null;
        return { url, onBranch: true };
      } catch (err) {
        console.log(`Could not push onto ${base} (${err instanceof Error ? err.message.split('\n')[0] : String(err)}); opening a fix ${forge.label} instead.`);
      }
    } else {
      console.log(`fix-target pr-branch: ${onto.why}; opening a fix ${forge.label} instead.`);
    }
  }
  git([...pushAuth(forge), 'push', '--force', forge.pushUrl, `HEAD:refs/heads/${branch}`], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });

  const urls = await hostEvidence({ forge, root, dir, runId });
  const body = placeEvidence(neutralize(readText(dir, 'pr-body.md') ?? `AutoHeal fixes for failed run ${runId}.`), urls).slice(0, 65_000);
  const existing = await forge.findPr(branch).catch(() => null);
  let pr;
  if (existing) {
    await forge.editPr(existing, body);
    pr = existing;
  } else {
    pr = await forge.createPr({ base, head: branch, title: `AutoHeal: ${fixed} test fix(es) for run ${runId}`, body, draft: mode === 'draft-pr' });
  }
  if (rerun) await rerunTests(forge, rerun, branch);
  return { url: pr.url, onBranch: false };
}

/** The subject of every AutoHeal fix commit; the heal workflow skips runs of such a commit (no loops). */
export const COMMIT_SUBJECT = 'test: AutoHeal fixes for failed run';

/** May the fix go onto this branch? Only an open PR's branch, never the default branch. */
export async function prBranchTarget(forge, base, pr) {
  if (!/^\d+$/.test(pr ?? '')) return { ok: false, why: 'the failed run has no pull request' };
  if (isAutohealBranch(base)) return { ok: false, why: 'the branch is an AutoHeal branch' };
  const main = forge.defaultBranch ? await forge.defaultBranch().catch(() => null) : null;
  if (!main) return { ok: false, why: 'the default branch is unknown' };
  if (main === base) return { ok: false, why: `${base} is the default branch, and AutoHeal never pushes there` };
  if (/^(?:main|master|develop|release[/-].*)$/.test(base)) return { ok: false, why: `${base} looks like a shared branch` };
  return { ok: true };
}

/** A short note on the failing PR, pointing at the fix and the chat commands. */
export function sourceComment({ fixUrl, onBranch, fixed, label }) {
  const n = `${fixed} test fix${fixed === 1 ? '' : 'es'}`;
  const lines = onBranch
    ? [`**AutoHeal AI** pushed ${n} onto this branch. Each one passed the anti-cheat guard and a stability rerun; review the commit like any other.`]
    : [
        `**AutoHeal AI** found ${n} for the failing tests here: ${fixUrl}`,
        '',
        `Comment \`/autoheal apply\` to add the fix to this ${label}, \`/autoheal explain\` for why, \`/autoheal retry\` to heal again, or \`/autoheal ignore\` to close the fix ${label}.`,
      ];
  return [...lines, '', '<!-- autoheal-source-comment -->'].join('\n');
}

/**
 * A push made with GitHub's default token starts no workflows, so CI would
 * never run on the fix PR. A workflow_dispatch is the exception GitHub allows:
 * start the test workflow on the fix branch, so the PR gets its checks.
 */
export async function rerunTests(forge, workflow, branch) {
  if (!forge.dispatch || !/^[\w.-]{1,100}\.ya?ml$/.test(workflow)) return false;
  try {
    await forge.dispatch(workflow, branch);
    summaryLine(`Started ${workflow} on ${branch}, so the ${forge.label} gets its CI checks.`);
    return true;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    summaryLine(
      /HTTP 422/.test(why)
        ? `CI was not started on the fix ${forge.label}: add \`workflow_dispatch:\` to the \`on:\` list of ${workflow} (or pass a PAT or App token as github-token).`
        : `CI was not started on the fix ${forge.label} (${why}). The publish job needs \`actions: write\`.`,
    );
    return false;
  }
}

export async function publishIssues(dir, forge) {
  const list = readJson(dir, 'issues.json');
  if (!Array.isArray(list)) return [];
  let open = [];
  if (list.length) open = await forge.openIssues().catch(() => []);
  const done = [];
  for (const issue of list.slice(0, 10)) {
    if (typeof issue?.title !== 'string' || !issue.title.startsWith('AutoHeal') || issue.title.length > 200) continue;
    if (typeof issue.file !== 'string' || !/^issue-\d{1,2}\.md$/.test(issue.file)) continue;
    const raw = readText(dir, issue.file);
    if (raw === null) continue;
    const text = neutralize(raw);
    const existing = open.find((o) => o.title === issue.title);
    let url;
    if (existing) {
      await forge.commentIssue(existing, text);
      url = existing.url;
    } else {
      url = (await forge.createIssue(issue.title, text)).url;
    }
    summaryLine(`App bug issue: ${url}`);
    done.push({ test: typeof issue.test === 'string' ? issue.test : '', url });
  }
  return done;
}

export async function publishComment(dir, forge, { pr, commit } = { pr: env.PR_NUMBER, commit: env.COMMIT }) {
  const raw = readText(dir, 'comment.md');
  const text = raw && neutralize(raw);
  if (!text) return;
  if (/^\d+$/.test(pr ?? '')) await forge.commentPr(pr, text);
  else if (/^[0-9a-f]{40}$/.test(commit ?? '')) await forge.commentCommit(commit, text);
  else console.log('No PR or commit to comment on.');
}

export async function uploadDashboard(dir, prUrl, issues) {
  if (!env.DASHBOARD_URL || !env.DASHBOARD_SECRET) return;
  const events = readJson(dir, 'events.json');
  if (!Array.isArray(events) || !events.length) return;
  const issueUrls = Object.fromEntries(issues.map((i) => [i.test, i.url]));
  // Only the known label fields, with the right types, leave the runner; the
  // dashboard validates them again.
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const clean = events.slice(0, 200).filter((e) => e && typeof e === 'object').map((e) => {
    const out = {
      id: str(e.id, 64),
      repo: ciInfo(env).repo ?? env.GITHUB_REPOSITORY ?? '',
      run_id: str(e.run_id, 40),
      run_url: str(e.run_url, 500),
      commit_sha: str(e.commit_sha, 64),
      branch: str(e.branch, 200),
      test_title: str(e.test_title, 500),
      file_path: str(e.file_path, 500),
      status: str(e.status, 40),
      category: str(e.category, 40),
      root_cause: str(e.root_cause, 40),
      confidence: num(e.confidence),
      fix_by: str(e.fix_by, 40),
      tokens: num(e.tokens),
      usd: num(e.usd),
      minutes_saved: num(e.minutes_saved),
      created_at: str(e.created_at, 40),
    };
    if (prUrl && (out.status === 'FIXED' || out.status === 'QUARANTINED')) out.pr_url = prUrl;
    if (out.status === 'APP_BUG' && issueUrls[out.test_title]) out.issue_url = issueUrls[out.test_title];
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
  });
  const body = JSON.stringify({ version: 1, events: clean });
  const ts = Math.floor(Date.now() / 1000);
  const signature = `sha256=${createHmac('sha256', env.DASHBOARD_SECRET).update(`${ts}.${body}`).digest('hex')}`;
  try {
    let base = env.DASHBOARD_URL;
    while (base.endsWith('/')) base = base.slice(0, -1);
    const res = await fetch(`${base}/api/heal`, {
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

/**
 * Settings for one publish, from the environment: the publish action's
 * variables first, then the CI's own (GitLab and CircleCI need no extra
 * settings), then the heal result's meta.json for what only the heal job knew.
 */
export function settings(env = process.env) {
  const info = ciInfo(env);
  return {
    info,
    dir: path.resolve(env.RESULT_DIR || env.AUTOHEAL_RESULT_DIR || 'autoheal-result'),
    mode: env.MODE || env.AUTOHEAL_MODE || 'draft-pr',
    runId: env.RUN_ID || info.runId || '',
    base: env.BASE_BRANCH || info.branch || '',
    commit: env.COMMIT || info.commit || '',
    pr: env.PR_NUMBER || info.pr || '',
    target: env.FIX_TARGET || env.AUTOHEAL_FIX_TARGET || 'new-pr',
    rerun: env.RERUN_WORKFLOW || env.AUTOHEAL_RERUN_WORKFLOW || '',
    openIssues: (env.OPEN_ISSUES ?? env.AUTOHEAL_OPEN_ISSUES) !== 'false',
  };
}

export async function main(env = process.env) {
  const s = settings(env);
  const { dir, mode } = s;
  const root = process.cwd();
  if (!['comment', 'draft-pr', 'pr'].includes(mode)) throw new Refused(`mode must be comment, draft-pr or pr (got "${mode}")`);
  const runId = s.runId;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(runId)) throw new Refused('RUN_ID must be the id of the failed run (letters, digits and dashes)');
  const meta = readJson(dir, 'meta.json');
  if (!meta) {
    console.log('No AutoHeal result to publish.');
    return Number(env.BLOCKED) > 0 ? 3 : 0;
  }
  const blocked = Math.max(Number(env.BLOCKED) || 0, Number(meta.blocked) || 0);
  const fixed = Math.min(Math.max(Number(meta.fixed) || 0, 0), 999);
  const forge = forgeFor(s.info, env);
  let prUrl = null;
  let issues = [];
  if (mode === 'comment') {
    await publishComment(dir, forge, { pr: s.pr, commit: s.commit });
  } else {
    const base = s.base;
    if (!/^[\w./-]{1,200}$/.test(base) || base.includes('..') || base.startsWith('-')) throw new Refused(`bad base branch "${base}"`);
    if (isAutohealBranch(base)) {
      console.log('The failed run is on an AutoHeal branch; nothing to publish.');
      return 0;
    }
    if (!['new-pr', 'pr-branch'].includes(s.target)) throw new Refused(`fix-target must be new-pr or pr-branch (got "${s.target}")`);
    const done = await publishPatch({ root, dir, mode, base, runId, fixed, forge, rerun: s.rerun, target: s.target, pr: s.pr });
    prUrl = done?.url ?? null;
    if (prUrl) summaryLine(`Fix ${forge.label}: ${prUrl}`);
    // Tell the failing PR where its fix is (or that it is already on its branch).
    if (done && /^\d+$/.test(s.pr ?? '')) {
      await forge.commentPr(s.pr, sourceComment({ fixUrl: done.url, onBranch: done.onBranch, fixed, label: forge.label })).catch((err) => console.log(`Could not comment on ${forge.label} ${s.pr}: ${err instanceof Error ? err.message : String(err)}`));
    }
    if (s.openIssues && readPolicy(root)?.issues.enabled !== false) issues = await publishIssues(dir, forge);
  }
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `pr-url=${prUrl ?? ''}\n`);
  await uploadDashboard(dir, prUrl, issues);
  return blocked > 0 ? 3 : 0;
}

/** Exit code for a finished publish: 0 done, 1 refused or blocked. */
export function report(promise) {
  return promise.then(
    (code) => {
      if (code === 3) console.log('::error title=AutoHeal blocked a fix::A proposed fix tried to weaken a test (BLOCKED_CHEATING). See the heal job summary.');
      return code === 3 ? 1 : code;
    },
    (err) => {
      const message = err instanceof Error ? err.message : String(err);
      const kind = err instanceof ForgeError ? 'AutoHeal could not reach the code host' : 'AutoHeal publish refused';
      console.log(`::error title=${kind}::${message.replace(/\n/g, ' ')}`);
      return 1;
    },
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  report(main()).then((code) => process.exit(code));
}
