/**
 * Runs the steps of action.yml locally, the way GitHub would, against a
 * prepared simulation project: real bash, real git with a local bare
 * "origin", and a fake `gh` that records every call. Used by the `action`
 * scenario in run.mjs. Needs python3 with PyYAML to read action.yml.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function loadAction(file) {
  const json = execFileSync('python3', ['-c', 'import yaml,json,sys;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', file], { encoding: 'utf8' });
  return JSON.parse(json);
}

function lookup(ctx, ref) {
  const m = /^(\w+)\.([\w-]+)(?:\.outputs\.([\w-]+))?(.*)$/.exec(ref);
  if (!m) return undefined;
  if (m[1] === 'inputs') return ctx.inputs[m[2]];
  if (m[1] === 'steps') return ctx.steps[m[2]]?.[m[3]];
  if (m[1] === 'github') {
    let value = ctx.github;
    for (const key of ref.replace(/^github\./, '').replace(/\[(\d+)\]/g, '.$1').split('.')) value = value?.[key];
    return value;
  }
  return undefined;
}

/** A tiny evaluator for the expressions action.yml uses. */
export function evaluate(ctx, expr) {
  const e = expr.trim();
  const and = /^(.+?)\s*==\s*'([^']*)'\s*&&\s*'([^']*)'\s*\|\|\s*'([^']*)'$/.exec(e);
  if (and) return String(lookup(ctx, and[1].trim()) ?? '') === and[2] ? and[3] : and[4];
  for (const part of e.split('||').map((p) => p.trim())) {
    const value = /^'(.*)'$/.test(part) ? part.slice(1, -1) : lookup(ctx, part);
    if (value !== undefined && value !== null && value !== '' && value !== 0) return String(value);
  }
  return '';
}

export function interpolate(ctx, text) {
  return String(text).replace(/\$\{\{\s*([\s\S]+?)\s*\}\}/g, (_, expr) => evaluate(ctx, expr));
}

export function condition(ctx, expr) {
  const parts = expr.split('&&').map((p) => p.trim());
  return parts.every((p) => {
    const eq = /^(.+?)\s*(==|!=)\s*'([^']*)'$/.exec(p);
    if (!eq) return Boolean(evaluate(ctx, p));
    const value = String(lookup(ctx, eq[1].trim()) ?? '');
    return eq[2] === '==' ? value === eq[3] : value !== eq[3];
  });
}

export function fakeGh(binDir, logFile) {
  mkdirSync(binDir, { recursive: true });
  const script = `#!/usr/bin/env node
const fs = process.getBuiltinModule('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + '\\n');
const has = (...words) => words.every((w, i) => args[i] === w);
const log = fs.readFileSync(${JSON.stringify(logFile)}, 'utf8');
if (has('pr', 'list')) process.stdout.write(log.includes('"pr","create"') ? 'https://github.com/acme/shop/pull/101\\n' : '');
else if (has('pr', 'create')) process.stdout.write('https://github.com/acme/shop/pull/101\\n');
else if (has('issue', 'list')) process.stdout.write('[]\\n');
else if (has('issue', 'create')) process.stdout.write('https://github.com/acme/shop/issues/' + (200 + fs.readFileSync(${JSON.stringify(logFile)}, 'utf8').split('\\n').length) + '\\n');
`;
  const file = path.join(binDir, 'gh');
  writeFileSync(file, script);
  chmodSync(file, 0o755);
}

/**
 * Runs every step of the action in order. `skip` names steps to skip (the
 * install step, which the simulation replaces with the local build).
 */
export function runAction({ actionDir, projectDir, inputs, github, env, skip = [], seed = {} }) {
  const action = loadAction(path.join(actionDir, 'action.yml'));
  const defaults = Object.fromEntries(Object.entries(action.inputs).map(([k, v]) => [k, v.default ?? '']));
  const ctx = { inputs: { ...defaults, ...inputs }, steps: { ...seed }, github };
  ctx.inputs['github-token'] = inputs['github-token'] ?? 'fake-token';
  const temp = path.join(projectDir, '.runner-temp');
  mkdirSync(temp, { recursive: true });
  const log = [];
  for (const step of action.runs.steps) {
    if (skip.includes(step.name)) continue;
    if (step.if && !condition(ctx, step.if)) {
      log.push({ step: step.name, skipped: true });
      continue;
    }
    const outputFile = path.join(temp, `${step.id ?? 'step'}-output.txt`);
    writeFileSync(outputFile, '');
    const stepEnv = Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, interpolate(ctx, v)]));
    const cwd = step['working-directory'] ? path.resolve(projectDir, interpolate(ctx, step['working-directory'])) : projectDir;
    const res = spawnSync('bash', ['-e', '-c', step.run], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...env,
        ...stepEnv,
        GITHUB_ACTION_PATH: actionDir,
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: path.join(temp, 'summary.md'),
        RUNNER_TEMP: temp,
        GITHUB_REPOSITORY: github.repository,
      },
    });
    const outputs = {};
    const text = readFileSync(outputFile, 'utf8');
    for (const m of text.matchAll(/^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) outputs[m[1]] = m[3];
    for (const m of text.matchAll(/^([\w-]+)=(.*)$/gm)) outputs[m[1]] = m[2];
    if (step.id) ctx.steps[step.id] = outputs;
    log.push({ step: step.name, code: res.status, stdout: res.stdout, stderr: res.stderr, outputs });
    if (res.status !== 0 && !step['continue-on-error']) return { ok: false, log, ctx };
  }
  return { ok: true, log, ctx };
}

export { existsSync };
