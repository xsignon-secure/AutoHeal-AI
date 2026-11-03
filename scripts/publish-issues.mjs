#!/usr/bin/env node
/**
 * Opens (or updates) one GitHub issue per APP_BUG found by `autoheal heal`.
 * Used by action.yml; needs the gh CLI and GH_TOKEN.
 *
 *   node scripts/publish-issues.mjs <issues.json> <out-dir>
 *
 * An open issue with the same title gets a comment instead of a duplicate.
 * The issue URLs are written back into issues.json for the dashboard upload.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [issuesFile, outDir] = process.argv.slice(2);
if (!issuesFile || !outDir) {
  console.error('usage: publish-issues.mjs <issues.json> <out-dir>');
  process.exit(2);
}

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const issues = JSON.parse(readFileSync(issuesFile, 'utf8'));
let open = [];
if (issues.length) {
  try {
    open = JSON.parse(gh('issue', 'list', '--state', 'open', '--limit', '200', '--search', 'AutoHeal in:title', '--json', 'title,url'));
  } catch {
    open = [];
  }
}

for (const issue of issues) {
  const body = path.join(outDir, issue.file);
  const existing = open.find((o) => o.title === issue.title);
  if (existing) {
    gh('issue', 'comment', existing.url, '--body-file', body);
    issue.url = existing.url;
  } else {
    issue.url = gh('issue', 'create', '--title', issue.title, '--body-file', body);
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `App bug issue: ${issue.url}\n`);
  console.log(`App bug issue: ${issue.url}`);
}
writeFileSync(issuesFile, `${JSON.stringify(issues, null, 2)}\n`);
