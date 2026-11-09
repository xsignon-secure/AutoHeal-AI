#!/usr/bin/env node
/**
 * AutoHeal chat commands on pull requests (GitHub). A maintainer comments
 *
 *   /autoheal apply     add the AutoHeal fix to the failing PR's own branch
 *   /autoheal retry     heal the PR's newest failed run again
 *   /autoheal explain   say what AutoHeal changed and why
 *   /autoheal ignore    close the AutoHeal fix PR (AutoHeal learns from it)
 *   /autoheal help      list the commands
 *
 * on the failing PR or on the AutoHeal fix PR. Runs in a checkout of the
 * default branch and never runs the project's code. Only OWNER, MEMBER and
 * COLLABORATOR comments count. `apply` only moves a commit that AutoHeal's
 * publish job made and checked (its author, subject and paths are checked
 * again here), as a plain fast-forward-able commit, never a force push, and
 * never onto the default branch.
 *
 * Settings (command/action.yml sets them): COMMENT_BODY, PR_NUMBER,
 * AUTHOR_ASSOCIATION, COMMENTER, GH_TOKEN, HEAL_WORKFLOW (autoheal.yml),
 * RERUN_WORKFLOW, ALLOWED_PATHS.
 */

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ciInfo } from '../dist/ci.js';
import { forgeFor, ForgeError } from './forge.mjs';
import { allowedPaths, COMMIT_SUBJECT, git, neutralize, prBranchTarget, pushAuth } from './publish.mjs';

export const COMMANDS = ['apply', 'retry', 'explain', 'ignore', 'help'];
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const BOT_EMAIL = 'autoheal-ai@users.noreply.github.com';
const AUTOHEAL_FILES = /^(?:\.autoheal\/(?:memory|fingerprints)\/[0-9a-f]{16}\.json|(?:.*\/)?playwright-quarantine\.json|(?:.*\/)?[\w.-]+-snapshots\/[\w.-]+\.png)$/;

/** The command in a comment: its first line must be `/autoheal <command>`. */
export function parseCommand(body) {
  const first = String(body ?? '').trim().split('\n')[0]?.trim() ?? '';
  const m = /^\/autoheal(?:\s+([a-z]+))?\s*$/i.exec(first);
  if (!m) return null;
  const cmd = (m[1] ?? 'help').toLowerCase();
  return COMMANDS.includes(cmd) ? cmd : 'unknown';
}

const BY = { rules: 'rule', fingerprint: 'saved fingerprint, no AI', 'same-change': 'same UI change, no AI', baseline: 'new screenshot baseline', ai: 'AI agent' };

/**
 * `/autoheal explain`: a short answer built from the fix PR's own record (the
 * autoheal-fixes marker and its sections), never its hidden markers, so the
 * reply stays readable and no metrics marker is copied into a comment.
 */
export function explainText(body, url) {
  const text = String(body);
  const code = (v) => `\`${neutralize(String(v ?? '')).replace(/`/g, "'").slice(0, 200)}\``;
  let fixes = [];
  const m = /<!-- autoheal-fixes:([A-Za-z0-9+/=]{1,40000}) -->/.exec(text);
  if (m) {
    try {
      const parsed = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
      if (Array.isArray(parsed)) fixes = parsed.slice(0, 20);
    } catch {
      fixes = [];
    }
  }
  const out = [`**What AutoHeal changed** in ${url}`, ''];
  if (fixes.length) {
    out.push('| Test | Change | How |', '|---|---|---|');
    for (const f of fixes) {
      const change = f.before && f.after ? `${code(f.before)} → ${code(f.after)}` : `edited ${code(f.file)}`;
      out.push(`| ${neutralize(String(f.test ?? f.file ?? '')).replace(/\|/g, '/').slice(0, 200)} | ${change} | ${BY[f.by] ?? neutralize(String(f.by ?? 'fix'))} |`);
    }
    out.push('');
  } else {
    // An older fix PR without the record: its own text, without hidden markers.
    const prose = neutralize(text.replace(/<!--[\s\S]*?-->/g, '')).trim().slice(0, 20_000);
    if (prose) out.push('<details><summary>Fix details</summary>', '', prose, '', '</details>', '');
  }
  out.push('Each fix was triaged as a test problem (not an app bug), passed the anti-cheat checks, and passed every stability rerun before the PR was opened.');
  const kept = /### Not changed in this PR\n+([\s\S]*?)(?:\n\n[A-Z]|\n###|$)/.exec(text)?.[1]?.trim();
  if (kept) out.push('', '**Left alone on purpose:**', '', neutralize(kept).slice(0, 3000));
  out.push('', `Screenshots, the diff and the proof for each fix are in ${url}.`);
  return out.join('\n');
}

export const HELP = [
  '**AutoHeal AI commands** (maintainers only):',
  '',
  '- `/autoheal apply`: add the AutoHeal fix to this PR\'s branch and close the fix PR',
  '- `/autoheal retry`: heal this PR\'s newest failed run again',
  '- `/autoheal explain`: what AutoHeal changed and why',
  '- `/autoheal ignore`: close the AutoHeal fix PR (AutoHeal will not propose that change again)',
  '- `/autoheal help`: this list',
].join('\n');

/** The failing PR and its AutoHeal fix PR, from either one. */
export async function relatedPrs(forge, number) {
  const pr = await forge.getPr(number);
  if (pr.head?.startsWith('autoheal/')) {
    const sources = await forge.listPrs({ head: pr.base });
    return { source: sources.find((x) => x.headRepo === forge.repo) ?? null, fix: pr, here: 'fix' };
  }
  const fixes = (await forge.listPrs({ base: pr.head })).filter((x) => x.head?.startsWith('autoheal/') && x.headRepo === forge.repo);
  return { source: pr, fix: fixes.sort((a, b) => b.number - a.number)[0] ?? null, here: 'source' };
}

/** Checks the fix branch's tip is one commit AutoHeal made, touching only allowed paths. */
export function checkFixCommit(root, ref, allowed = allowedPaths(process.env.ALLOWED_PATHS)) {
  const [email, subject] = git(['log', '-1', '--format=%ae%n%s', ref], { cwd: root }).split('\n');
  if (email !== BOT_EMAIL || !subject?.startsWith(COMMIT_SUBJECT)) throw new Error('the fix branch\'s newest commit was not made by AutoHeal, so it is not applied automatically');
  const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', ref], { cwd: root }).split('\0').filter(Boolean);
  const bad = files.filter((f) => !AUTOHEAL_FILES.test(f) && !allowed.some((m) => m(f)));
  if (!files.length || bad.length) throw new Error(`the fix commit changes files outside the allowed paths (${bad.slice(0, 5).join(', ') || 'none'})`);
  return files;
}

/** Runs one command; returns the reply to post. */
export async function runCommand({ cmd, forge, number, commenter, root, env = process.env }) {
  if (cmd === 'help' || cmd === 'unknown') return (cmd === 'unknown' ? 'Unknown command.\n\n' : '') + HELP;
  const { source, fix, here } = await relatedPrs(forge, number);
  const who = commenter ? ` (asked by ${commenter})` : '';
  if (cmd === 'retry') {
    const sha = source?.sha ?? (source ? (await forge.getPr(source.number)).sha : null);
    const runId = fix?.head ? fix.head.slice('autoheal/'.length) : sha ? await forge.failedRun(sha) : null;
    if (!runId || !/^\d+$/.test(runId)) return 'No failed run found to heal again.';
    const workflow = env.HEAL_WORKFLOW || 'autoheal.yml';
    await forge.dispatchWith(workflow, env.DEFAULT_BRANCH || (await forge.defaultBranch()), { run_id: runId });
    return `Started ${workflow} to heal run ${runId} again${who}.`;
  }
  if (!fix) return `No open AutoHeal fix ${forge.label} found for this ${here === 'fix' ? 'fix' : forge.label}.`;
  if (cmd === 'explain') {
    return explainText(fix.body || '', fix.url);
  }
  if (cmd === 'ignore') {
    await forge.closePr(fix.number);
    await forge.commentPr(fix.number, `Closed with \`/autoheal ignore\`${who}. AutoHeal will not propose this change again.`);
    return `Closed the AutoHeal fix ${fix.url}${who}.`;
  }
  // apply
  if (!source) return `The ${forge.label} this fix was made for is not open any more.`;
  if (source.headRepo !== forge.repo) return `The ${forge.label} comes from a fork, so AutoHeal cannot push to it. Merge ${fix.url} instead.`;
  const onto = await prBranchTarget(forge, source.head, String(source.number));
  if (!onto.ok) return `Not applied: ${onto.why}. Merge ${fix.url} instead.`;
  const auth = pushAuth(forge);
  git([...auth, 'fetch', '-q', forge.pushUrl, `+refs/heads/${source.head}:refs/autoheal/source`, `+refs/heads/${fix.head}:refs/autoheal/fix`], { cwd: root });
  checkFixCommit(root, 'refs/autoheal/fix');
  git(['checkout', '-q', '--detach', 'refs/autoheal/source'], { cwd: root });
  try {
    git(['-c', 'user.name=autoheal-ai[bot]', '-c', `user.email=${BOT_EMAIL}`, 'cherry-pick', '-x', 'refs/autoheal/fix'], { cwd: root });
  } catch {
    git(['cherry-pick', '--abort'], { cwd: root, stdio: 'ignore' });
    return `The fix does not apply cleanly on the newest commit of \`${source.head}\`. Use \`/autoheal retry\`, or merge ${fix.url} by hand.`;
  }
  git([...auth, 'push', forge.pushUrl, `HEAD:refs/heads/${source.head}`], { cwd: root });
  if (env.RERUN_WORKFLOW && /^[\w.-]{1,100}\.ya?ml$/.test(env.RERUN_WORKFLOW)) await forge.dispatch(env.RERUN_WORKFLOW, source.head).catch(() => undefined);
  await forge.closePr(fix.number);
  await forge.commentPr(fix.number, `Applied to \`${source.head}\` with \`/autoheal apply\`${who}; closing this ${forge.label}.`);
  return `Applied the AutoHeal fix from ${fix.url} to \`${source.head}\`${who}.`;
}

export async function main(env = process.env) {
  const cmd = parseCommand(env.COMMENT_BODY);
  if (!cmd) return 0;
  const number = env.PR_NUMBER ?? '';
  if (!/^\d+$/.test(number)) throw new Error('PR_NUMBER must be a number');
  const forge = forgeFor(ciInfo(env), env);
  if (forge.name !== 'github' || !forge.getPr) throw new Error('AutoHeal chat commands work on GitHub');
  const commenter = /^[\w-]{1,39}$/.test(env.COMMENTER ?? '') ? `@​${env.COMMENTER}` : '';
  let reply;
  if (!TRUSTED.has(String(env.AUTHOR_ASSOCIATION ?? '').toUpperCase())) {
    reply = 'Only maintainers (owners, members and collaborators) can use AutoHeal commands.';
  } else {
    try {
      reply = await runCommand({ cmd, forge, number, commenter, root: process.cwd(), env });
    } catch (err) {
      reply = `\`/autoheal ${cmd}\` failed: ${neutralize(err instanceof Error ? err.message.split('\n')[0] : String(err)).slice(0, 300)}`;
    }
  }
  console.log(reply.split('\n')[0]);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${reply}\n`);
  await forge.commentPr(number, `${reply}\n\n<!-- autoheal-command -->`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      const kind = err instanceof ForgeError ? 'AutoHeal could not reach the code host' : 'AutoHeal command failed';
      console.log(`::error title=${kind}::${(err instanceof Error ? err.message : String(err)).replace(/\n/g, ' ')}`);
      process.exit(1);
    },
  );
}
