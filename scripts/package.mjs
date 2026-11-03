#!/usr/bin/env node
/**
 * Packs the heal job's result for the publish job: a git patch of the healed
 * files plus the Markdown and JSON that `autoheal heal` wrote. The heal job
 * has a read-only token; the publish job checks this package and opens the PR.
 * No dependencies, so it runs on any Node the runner has.
 *
 *   node scripts/package.mjs <heal-out-dir> <result-dir>
 *
 * Run it from the project folder (the action's working-directory).
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [outDir, resultDir] = process.argv.slice(2);
if (!outDir || !resultDir) {
  console.error('usage: package.mjs <heal-out-dir> <result-dir>');
  process.exit(2);
}

// Hooks, fsmonitor, external diff and textconv are all off: the project's code
// ran in this job and may have changed .git/config.
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.attributesFile=/dev/null'];
const git = (args, opts = {}) => execFileSync('git', [...SAFE, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

rmSync(resultDir, { recursive: true, force: true });
mkdirSync(resultDir, { recursive: true });

const summaryFile = path.join(outDir, 'summary.json');
let summary = null;
try {
  summary = JSON.parse(readFileSync(summaryFile, 'utf8'));
} catch {
  // No summary: the heal step failed before writing one.
}
const results = summary?.results ?? [];

let changed = [];
if (summary?.changes && Array.isArray(summary.changedFiles) && summary.changedFiles.length) {
  const top = git(['rev-parse', '--show-toplevel']).trim();
  const here = process.cwd();
  // Root-relative paths, so the publish job can apply the patch from the repo root.
  changed = summary.changedFiles.map((f) => path.relative(top, path.resolve(here, f)).split(path.sep).join('/'));
  git(['add', '-N', '--', ...changed], { cwd: top });
  const patch = git(['diff', '--no-ext-diff', '--no-textconv', '--binary', '--no-renames', '--', ...changed], { cwd: top });
  writeFileSync(path.join(resultDir, 'patch.diff'), patch);
}
writeFileSync(path.join(resultDir, 'changed-files.txt'), changed.length ? `${changed.join('\n')}\n` : '');

// Only the files the publish job uses.
const keep = /^(pr-body\.md|comment\.md|job-summary\.md|issues\.json|events\.json|summary\.json|issue-\d+\.md)$/;
let names = [];
try {
  names = readdirSync(outDir);
} catch {
  names = [];
}
for (const name of names) if (keep.test(name)) copyFileSync(path.join(outDir, name), path.join(resultDir, name));

const count = (status) => results.filter((r) => r.status === status).length;
const meta = {
  version: 1,
  outcome: summary?.outcome ?? 'error',
  fixed: count('FIXED'),
  blocked: count('BLOCKED_CHEATING'),
  quarantined: count('QUARANTINED'),
  changes: changed.length > 0,
};
writeFileSync(path.join(resultDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
console.log(`Packed ${changed.length} changed file(s) into ${resultDir}`);
