/**
 * Runs the steps of action.yml locally, the way GitHub would, against a
 * prepared simulation project: real bash, real git with a local bare
 * "origin", and a fake GitHub API that records every call. Used by the `action`
 * scenario in run.mjs. Needs python3 with PyYAML to read action.yml.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function loadAction(file) {
  const json = execFileSync('python3', ['-c', 'import yaml,json,sys;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', file], { encoding: 'utf8' });
  return JSON.parse(json);
}

function lookup(ctx, ref) {
  const m = /^(\w+)\.([\w-]+)(?:\.outputs\.([\w-]+))?(.*)$/.exec(ref);
  if (!m) return undefined;
  if (m[1] === 'inputs') return ctx.inputs[m[2]];
  if (m[1] === 'runner') return ctx.runner?.[m[2]];
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
    if (p === 'always()') return true;
    const eq = /^(.+?)\s*(==|!=)\s*'([^']*)'$/.exec(p);
    if (!eq) return Boolean(evaluate(ctx, p));
    const value = String(lookup(ctx, eq[1].trim()) ?? '');
    return eq[2] === '==' ? value === eq[3] : value !== eq[3];
  });
}

/**
 * A fake GitHub REST API in its own process (the harness runs steps
 * synchronously). Every request is appended to `logFile` as one JSON line:
 * { method, path, body }. Returns { url, stop }.
 */
export function fakeGithubApi(logFile) {
  const portFile = `${logFile}.port`;
  rmSync(portFile, { force: true });
  const script = `
const http = require('node:http');
const fs = require('node:fs');
let pr = null;
let issues = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let json = null;
    try { json = body ? JSON.parse(body) : null; } catch {}
    fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ method: req.method, path: req.url, body: json }) + '\\n');
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const p = req.url.split('?')[0];
    if (req.method === 'GET' && p === '/repos/acme/shop/pulls') return send(200, pr ? [pr] : []);
    if (req.method === 'POST' && p === '/repos/acme/shop/pulls') { pr = { html_url: 'https://github.com/acme/shop/pull/101', number: 101 }; return send(201, pr); }
    if (req.method === 'GET' && p === '/repos/acme/shop/issues') return send(200, []);
    if (req.method === 'POST' && p === '/repos/acme/shop/issues') { issues++; return send(201, { html_url: 'https://github.com/acme/shop/issues/' + (200 + issues), number: 200 + issues }); }
    if (req.method === 'POST' && /dispatches$/.test(p)) { res.writeHead(204); return res.end(); }
    return send(req.method === 'GET' ? 200 : 201, req.method === 'GET' ? [] : {});
  });
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(portFile)}, String(server.address().port)));
`;
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  for (let i = 0; i < 200 && !existsSync(portFile); i++) spawnSync('sleep', ['0.05']);
  const port = readFileSync(portFile, 'utf8').trim();
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

/** The fake API's log, one object per request. */
export function apiCalls(logFile) {
  return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Runs every `run:` step of the action in order (`uses:` steps are skipped). `skip` names steps to skip (the
 * install step, which the simulation replaces with the local build).
 */
export function runAction({ actionDir, projectDir, inputs, github, env, skip = [], seed = {} }) {
  const action = loadAction(path.join(actionDir, 'action.yml'));
  const defaults = Object.fromEntries(Object.entries(action.inputs).map(([k, v]) => [k, v.default ?? '']));
  const temp = path.join(projectDir, '.runner-temp');
  mkdirSync(temp, { recursive: true });
  const ctx = { inputs: { ...defaults, ...inputs }, steps: { ...seed }, github, runner: { temp } };
  ctx.inputs['github-token'] = inputs['github-token'] ?? 'fake-token';
  const log = [];
  for (const step of action.runs.steps) {
    if (skip.includes(step.name)) continue;
    // `uses:` steps (upload-artifact) are GitHub's own; the scenario copies the files itself.
    if (step.uses) {
      log.push({ step: step.name, uses: step.uses, skipped: true });
      continue;
    }
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
        // No real GitHub in the simulation: API calls fail fast unless a scenario sets a stub.
        GITHUB_API_URL: env?.GITHUB_API_URL ?? process.env.SIM_GITHUB_API_URL ?? 'http://127.0.0.1:9',
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
