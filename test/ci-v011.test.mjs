// 0.11.0: GitLab CI, CircleCI and local runs; init and doctor; learned
// fingerprints; Cypress fingerprints and quarantine; screenshots in the PR;
// CI on the fix PR through workflow_dispatch.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { heal, engineEnv, fingerprintOf, saveFingerprints, CypressTools } from '../dist/index.js';
import { ciInfo, parseRepoUrl, isAutohealBranch } from '../dist/ci.js';
import { cypressSelectorFor, replaceCypressSelector, ownTitle, itTitles, parseCypressDom, restoreTree, domFor, loadCypressDoms } from '../dist/cypress-dom.js';
import { loadLearned, unpackLearned } from '../dist/learned.js';
import { init, doctor, renderTemplate, detect } from '../dist/setup.js';
import { testRun } from '../dist/local.js';
import { checkQuarantine, placeEvidence, evidenceImages, main as publishMain, settings } from '../scripts/publish.mjs';
import { gitlabForge, githubForge, forgeFor } from '../scripts/forge.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

test('ciInfo reads GitLab, CircleCI and GitHub variables, and checks every value', () => {
  const gl = ciInfo({
    GITLAB_CI: 'true',
    CI_SERVER_URL: 'https://gitlab.example.com',
    CI_API_V4_URL: 'https://gitlab.example.com/api/v4',
    CI_PROJECT_PATH: 'acme/web/shop',
    CI_PROJECT_ID: '42',
    CI_PIPELINE_ID: '9001',
    CI_PIPELINE_URL: 'https://gitlab.example.com/acme/web/shop/-/pipelines/9001',
    CI_JOB_URL: 'https://gitlab.example.com/acme/web/shop/-/jobs/5',
    CI_COMMIT_SHA: 'a'.repeat(40),
    CI_COMMIT_BRANCH: 'main',
    CI_MERGE_REQUEST_IID: '12',
    GITLAB_USER_LOGIN: 'ada',
    CI_DEFAULT_BRANCH: 'main',
  });
  assert.equal(gl.ci, 'gitlab');
  assert.equal(gl.forge, 'gitlab');
  assert.equal(gl.repo, 'acme/web/shop');
  assert.equal(gl.api, 'https://gitlab.example.com/api/v4');
  assert.equal(gl.runId, '9001');
  assert.equal(gl.pr, '12');
  assert.equal(gl.owner, '@ada');
  assert.equal(gl.selfUrl, 'https://gitlab.example.com/acme/web/shop/-/jobs/5');

  const cc = ciInfo({ CIRCLECI: 'true', CIRCLE_REPOSITORY_URL: 'git@github.com:acme/shop.git', CIRCLE_WORKFLOW_ID: '0b1c2d3e-aaaa-bbbb-cccc-123456789012', CIRCLE_SHA1: 'b'.repeat(40), CIRCLE_BRANCH: 'feature/x', CIRCLE_PULL_REQUEST: 'https://github.com/acme/shop/pull/7' });
  assert.equal(cc.ci, 'circleci');
  assert.equal(cc.forge, 'github');
  assert.equal(cc.repo, 'acme/shop');
  assert.equal(cc.api, 'https://api.github.com');
  assert.equal(cc.pr, '7');
  assert.equal(cc.runId, '0b1c2d3e-aaaa-bbbb-cccc-123456789012');
  assert.equal(ciInfo({ CIRCLECI: 'true', CIRCLE_REPOSITORY_URL: 'https://gitlab.com/acme/shop' }).forge, 'gitlab');

  const gh = ciInfo({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'acme/shop', GITHUB_RUN_ID: '77', GITHUB_SERVER_URL: 'https://github.com', AUTOHEAL_RUN_URL: 'https://github.com/acme/shop/actions/runs/70' });
  assert.equal(gh.runUrl, 'https://github.com/acme/shop/actions/runs/70', 'the failed run');
  assert.equal(gh.selfUrl, 'https://github.com/acme/shop/actions/runs/77', 'this job, where the screenshots are');

  // Bad values are dropped, never passed on.
  const bad = ciInfo({ GITLAB_CI: 'true', CI_COMMIT_BRANCH: 'x y', CI_COMMIT_SHA: 'zzz', CI_PROJECT_PATH: '../etc', CI_SERVER_URL: 'http://evil.example.com', AUTOHEAL_BRANCH: '--upload-pack=x' });
  assert.equal(bad.branch, undefined);
  assert.equal(bad.commit, undefined);
  assert.equal(bad.repo, undefined);
  assert.equal(bad.server, 'https://gitlab.com');
  assert.equal(ciInfo({}).ci, 'local');
  assert.deepEqual(parseRepoUrl('https://gitlab.com/a/b/c.git'), { host: 'gitlab.com', repo: 'a/b/c' });
  assert.equal(isAutohealBranch('autoheal/12'), true);
});

test('engineEnv drops GitLab and CircleCI tokens from what tests can see', () => {
  const env = engineEnv({ PATH: '/bin', CI_JOB_TOKEN: 'j', AUTOHEAL_GITLAB_TOKEN: 'g', AUTOHEAL_GITHUB_TOKEN: 'h', CIRCLE_TOKEN: 'c', CI_REPOSITORY_URL: 'https://gitlab-ci-token:x@gitlab.com/a/b.git', CI_REGISTRY_PASSWORD: 'r', CI: 'true' }, false);
  assert.deepEqual(Object.keys(env).sort(), ['AUTOHEAL_RUNTIME', 'CI', 'PATH']);
});

function mockServer(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      const [status, data] = handler(req, body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

test('GitLab forge: merge requests, issues, notes and image uploads through the REST API', async () => {
  const { server, calls, url } = await mockServer((req) => {
    if (req.method === 'GET' && req.url.startsWith('/api/v4/projects/7/merge_requests')) return [200, []];
    if (req.method === 'POST' && req.url === '/api/v4/projects/7/merge_requests') return [201, { web_url: `${url}/acme/shop/-/merge_requests/3`, iid: 3 }];
    if (req.method === 'GET' && req.url.startsWith('/api/v4/projects/7/issues')) return [200, [{ title: 'AutoHeal: app bug in x', web_url: 'u', iid: 9 }, { title: 'Other', web_url: 'v', iid: 1 }]];
    if (req.method === 'POST' && req.url === '/api/v4/projects/7/uploads') return [201, { url: '/uploads/abc/1-before.png', full_path: '/-/project/7/uploads/abc/1-before.png' }];
    return [201, {}];
  });
  try {
    const f = gitlabForge({ api: `${url}/api/v4`, server: url, repo: 'acme/shop', projectId: '7', token: 'glpat-x' });
    assert.equal(await f.findPr('autoheal/1'), null);
    const mr = await f.createPr({ base: 'main', head: 'autoheal/1', title: 'AutoHeal: 1 fix', body: 'b', draft: true });
    assert.equal(mr.number, 3);
    const sent = JSON.parse(calls.find((c) => c.method === 'POST' && c.url.endsWith('/merge_requests')).body);
    assert.equal(sent.title, 'Draft: AutoHeal: 1 fix');
    assert.equal(sent.source_branch, 'autoheal/1');
    assert.deepEqual((await f.openIssues()).map((i) => i.number), [9]);
    await f.commentPr(3, 'hello');
    await f.commentCommit('a'.repeat(40), 'hi');
    assert.equal(await f.uploadImage('1-before.png', Buffer.from('x'), 'image/png'), `${url}/-/project/7/uploads/abc/1-before.png`);
    assert.ok(calls.every((c) => c.headers['private-token'] === 'glpat-x'));
    assert.ok(f.pushHeader.startsWith('AUTHORIZATION: basic '));
    assert.equal(Buffer.from(f.pushHeader.split('basic ')[1], 'base64').toString(), 'oauth2:glpat-x');
  } finally {
    server.close();
  }
});

test('GitHub forge: workflow_dispatch starts CI on the fix branch with the default token', async () => {
  const { server, calls, url } = await mockServer(() => [204, {}]);
  try {
    const f = githubForge({ api: url, server: 'https://github.com', repo: 'acme/shop', token: 'ghs_x' });
    await f.dispatch('e2e.yml', 'autoheal/5');
    assert.equal(calls[0].url, '/repos/acme/shop/actions/workflows/e2e.yml/dispatches');
    assert.deepEqual(JSON.parse(calls[0].body), { ref: 'autoheal/5' });
    assert.equal(f.imageUrl('c'.repeat(40), '5/1-before.png'), `https://github.com/acme/shop/blob/${'c'.repeat(40)}/5/1-before.png?raw=true`);
    assert.throws(() => forgeFor({ forge: 'none' }, {}), /GitHub and GitLab/);
    assert.throws(() => githubForge({ api: url, server: 'https://github.com', repo: 'acme/shop' }), /No GitHub token/);
  } finally {
    server.close();
  }
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);

test('screenshots: only real images are used, and the markers become a before/after table', () => {
  const dir = tmp('autoheal-ev-');
  mkdirSync(path.join(dir, 'evidence'));
  writeFileSync(path.join(dir, 'evidence', '1-before.png'), PNG);
  writeFileSync(path.join(dir, 'evidence', '1-after.png'), 'not a png at all');
  writeFileSync(path.join(dir, 'evidence', 'secret.txt'), 'x');
  const images = evidenceImages(dir);
  assert.deepEqual([...images.keys()], ['1-before.png']);
  const body = 'Row\n<!-- autoheal-evidence before="1-before.png" after="1-after.png" -->\nNext\n<!-- autoheal-evidence before="2-before.png" -->\n';
  const out = placeEvidence(body, new Map([['1-before.png', 'https://x/1.png']]));
  assert.match(out, /\| Before \| After \|/);
  assert.match(out, /!\[before\]\(https:\/\/x\/1\.png\)/);
  assert.doesNotMatch(out, /autoheal-evidence/, 'unused markers are removed');
});

test('publish on GitLab CI: checks the patch, pushes the branch, uploads screenshots and opens a draft merge request', async () => {
  const bare = tmp('autoheal-bare-');
  git(bare, 'init', '-q', '--bare');
  const work = tmp('autoheal-work-');
  git(work, 'init', '-q');
  mkdirSync(path.join(work, 'tests'));
  const before = "test('login', async ({ page }) => {\n  await page.getByRole('button', { name: 'Log in' }).click();\n});\n";
  writeFileSync(path.join(work, 'tests', 'login.spec.ts'), before);
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'init');
  const sha = git(work, 'rev-parse', 'HEAD');
  writeFileSync(path.join(work, 'tests', 'login.spec.ts'), before.replace("'Log in'", "'Sign in'"));
  const patch = execFileSync('git', ['diff'], { cwd: work, encoding: 'utf8' });
  git(work, 'checkout', '--', '.');
  const result = tmp('autoheal-result-');
  writeFileSync(path.join(result, 'patch.diff'), patch);
  writeFileSync(path.join(result, 'changed-files.txt'), 'tests/login.spec.ts\n');
  writeFileSync(path.join(result, 'meta.json'), JSON.stringify({ version: 1, fixed: 1, blocked: 0 }));
  writeFileSync(path.join(result, 'pr-body.md'), '## AutoHeal\n<!-- autoheal-evidence before="1-before.png" -->\n@someone look\n');
  writeFileSync(path.join(result, 'issues.json'), '[]');
  mkdirSync(path.join(result, 'evidence'));
  writeFileSync(path.join(result, 'evidence', '1-before.png'), PNG);

  const { server, calls, url } = await mockServer((req) => {
    if (req.method === 'GET') return [200, []];
    if (req.url === '/api/v4/projects/7/uploads') return [201, { url: '/uploads/u1/1-before.png', full_path: '/acme/shop/uploads/u1/1-before.png' }];
    if (req.url === '/api/v4/projects/7/merge_requests') return [201, { web_url: `${url}/acme/shop/-/merge_requests/1`, iid: 1 }];
    return [201, {}];
  });
  const cwd = process.cwd();
  try {
    process.chdir(work);
    const env = {
      GITLAB_CI: 'true',
      CI_SERVER_URL: url,
      CI_API_V4_URL: `${url}/api/v4`,
      CI_PROJECT_PATH: 'acme/shop',
      CI_PROJECT_ID: '7',
      CI_PIPELINE_ID: '555',
      CI_COMMIT_SHA: sha,
      CI_COMMIT_BRANCH: 'main',
      AUTOHEAL_GITLAB_TOKEN: 'glpat-x',
      AUTOHEAL_PUSH_URL: bare,
      RESULT_DIR: result,
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    };
    assert.equal(settings(env).runId, '555');
    assert.equal(await publishMain(env), 0);
  } finally {
    process.chdir(cwd);
    server.close();
  }
  assert.match(execFileSync('git', ['show', 'autoheal/555:tests/login.spec.ts'], { cwd: bare, encoding: 'utf8' }), /Sign in/);
  const mr = JSON.parse(calls.find((c) => c.method === 'POST' && c.url === '/api/v4/projects/7/merge_requests').body);
  assert.equal(mr.target_branch, 'main');
  assert.equal(mr.source_branch, 'autoheal/555');
  assert.match(mr.title, /^Draft: AutoHeal: 1 test fix/);
  assert.ok(mr.description.includes(`![before](${url}/acme/shop/uploads/u1/1-before.png)`));
  assert.match(mr.description, /@\u200bsomeone/, 'mentions are neutralized');
});

test('publish refuses to open fixes for an AutoHeal branch', async () => {
  const result = tmp('autoheal-result-');
  writeFileSync(path.join(result, 'meta.json'), JSON.stringify({ version: 1, fixed: 1 }));
  const env = { GITLAB_CI: 'true', CI_PROJECT_PATH: 'a/b', CI_PIPELINE_ID: '1', CI_COMMIT_BRANCH: 'autoheal/1', AUTOHEAL_GITLAB_TOKEN: 't', RESULT_DIR: result };
  assert.equal(await publishMain(env), 0);
});

// ---------- Cypress ----------

function page(button) {
  return { tag: 'HTML', attrs: {}, children: [{ tag: 'BODY', attrs: {}, children: [{ tag: 'H1', attrs: {}, children: ['Welcome'] }, { tag: 'BUTTON', attrs: button, children: ['Log in'] }] }] };
}

test('Cypress DOM files: parsed safely, selectors chosen in Cypress order, sources rewritten in place', () => {
  const root = restoreTree(page({ 'data-cy': 'signin', id: 'btn-12345' }));
  const button = root.children[0].children[1];
  assert.equal(button.parent.tag, 'BODY');
  assert.equal(cypressSelectorFor(button, root), '[data-cy="signin"]');
  const idOnly = restoreTree(page({ id: 'submit' }));
  assert.equal(cypressSelectorFor(idOnly.children[0].children[1], idOnly), '#submit');
  const generated = restoreTree(page({ id: 'btn-48213' }));
  assert.equal(cypressSelectorFor(generated.children[0].children[1], generated), null, 'generated ids are not stable');

  const src = "it('logs in', () => {\n  cy.get('[data-cy=login]').click();\n  cy.get(\"[data-cy=login]\").should('be.visible');\n});\n";
  const r = replaceCypressSelector(src, '[data-cy=login]', '[data-cy="signin"]');
  assert.equal(r.next, "it('logs in', () => {\n  cy.get('[data-cy=\"signin\"]').click();\n  cy.get(\"[data-cy='signin']\").should('be.visible');\n});\n");
  assert.equal(replaceCypressSelector(src, '#nope', '#x'), null);

  assert.deepEqual(itTitles("describe('login', () => { it('user can log in', () => {}); it(\"shows errors\", () => {}) })"), ['user can log in', 'shows errors']);
  assert.equal(ownTitle('login user can log in', "it('user can log in', () => {})"), 'user can log in');
  assert.equal(ownTitle('login other', "it('user can log in', () => {})"), undefined);

  assert.equal(parseCypressDom('{"version":2}'), null);
  assert.equal(parseCypressDom('not json'), null);
  const parsed = parseCypressDom(JSON.stringify({ version: 1, spec: 'cypress/e2e/a.cy.js', title: 't', calls: [{ callId: '0', selector: 'x', failed: true }, { selector: 5 }], failedCall: { callId: '0', selector: 'x' }, failedPage: { root: page({}) } }));
  assert.equal(parsed.dom.calls.length, 1);
  assert.equal(parsed.dom.failedCall.selector, 'x');
  assert.equal(domFor([parsed], 'cypress/e2e/b.cy.js', 't'), undefined, 'a different spec');
  assert.equal(domFor([parsed], 'e2e/a.cy.js', 't'), parsed.dom, 'reports may name the spec relative to another folder');
  assert.equal(domFor([parsed], 'cypress/e2e/a.cy.js', 't'), parsed.dom);
});

const CY_SPEC = "describe('login', () => {\n  it('user can log in', () => {\n    cy.get('[data-cy=login]').click();\n    cy.get('#msg').should('have.text', 'Signed in');\n  });\n});\n";

function cyProject(elements) {
  const dir = tmp('autoheal-cy11-');
  writeFileSync(path.join(dir, 'package.json'), '{"name":"shop","private":true}\n');
  writeFileSync(path.join(dir, 'cypress.config.js'), 'module.exports = { e2e: {} };\n');
  mkdirSync(path.join(dir, 'cypress', 'e2e'), { recursive: true });
  writeFileSync(path.join(dir, 'cypress', 'e2e', 'login.cy.js'), CY_SPEC);
  cpSync(path.join(here, 'fake-cypress'), path.join(dir, 'node_modules', 'cypress'), { recursive: true });
  writeFileSync(path.join(dir, 'fake-app.json'), JSON.stringify({ elements }));
  git(dir, 'init', '-q');
  writeFileSync(path.join(dir, '.git', 'info', 'exclude'), 'autoheal-artifacts/\n.fake-cypress-runs\nnode_modules/\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

test('heal on Cypress: the renamed element is found again from its fingerprint, with no AI', async () => {
  const dir = cyProject({ '[data-cy="signin"]': 'Log in', '#msg': 'Signed in' });
  // What the element looked like on an earlier green run.
  const old = restoreTree(page({ 'data-cy': 'login' }));
  await saveFingerprints(dir, [{ at: '2026-11-01T00:00:00Z', selector: '[data-cy=login]', page: '/', fingerprint: fingerprintOf(old.children[0].children[1]) }]);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'prints');
  // The failed run: the plugin kept the page when cy.get found nothing.
  mkdirSync(path.join(dir, 'autoheal-artifacts', 'autoheal'), { recursive: true });
  writeFileSync(
    path.join(dir, 'autoheal-artifacts', 'autoheal', '0123456789abcdef.json'),
    JSON.stringify({ version: 1, spec: 'cypress/e2e/login.cy.js', title: 'login user can log in', calls: [{ callId: '0', method: 'get', selector: '[data-cy=login]', failed: true, page: '/' }], failedCall: { callId: '0', method: 'get', selector: '[data-cy=login]', failed: true, page: '/' }, failedPage: { root: page({ 'data-cy': 'signin' }), frameUrl: 'http://localhost:3000/' } }),
  );
  writeFileSync(
    path.join(dir, 'autoheal-artifacts', 'results.xml'),
    `<testsuites><testsuite name="Root Suite" file="cypress/e2e/login.cy.js"></testsuite><testsuite name="login"><testcase name="login user can log in" classname="user can log in"><failure message="Timed out retrying after 4000ms: Expected to find element: \`[data-cy=login]\`, but never found it." type="AssertionError"/></testcase></testsuite></testsuites>`,
  );
  const s = await heal({ projectRoot: dir, report: 'autoheal-artifacts', mode: 'draft-pr', maxFailures: 3, repeatEach: 3, quarantineDays: 14, allowWarn: false, checkFlaky: false, flakyRuns: 3, budget: { maxSteps: 5, maxTokens: 1e5, maxUsd: 1 }, provider: null });
  const r = s.results[0];
  assert.equal(r.status, 'FIXED', JSON.stringify(r, null, 1));
  assert.equal(r.fix.by, 'fingerprint');
  assert.equal(s.spend.inputTokens, 0);
  assert.match(readFileSync(path.join(dir, 'cypress/e2e/login.cy.js'), 'utf8'), /cy\.get\('\[data-cy="signin"\]'\)\.click\(\)/);
  const loaded = await loadCypressDoms(dir, ['autoheal-artifacts']);
  assert.equal(loaded.length, 1);
});

test('Cypress quarantine: an entry with the it() title, which publish accepts for a flaky result', async () => {
  const dir = cyProject({});
  const tools = new CypressTools(dir);
  const q = await tools.call('quarantine', { action: 'add', file: 'cypress/e2e/login.cy.js', title: 'login user can log in', days: 7, owner: '@ada', reason: 'AutoHeal: flaky' });
  assert.equal(q.ok, true, q.text);
  const file = JSON.parse(readFileSync(path.join(dir, 'playwright-quarantine.json'), 'utf8'));
  assert.equal(file.entries[0].title, 'user can log in');
  assert.equal((await tools.call('quarantine', { action: 'add', file: 'cypress/e2e/login.cy.js', title: 'login nope' })).ok, false);
  assert.equal((await tools.call('quarantine', { action: 'add', file: '../x.cy.js', title: 'a' })).ok, false);
  const results = [{ status: 'QUARANTINED', failure: { file: 'cypress/e2e/login.cy.js', title: 'login user can log in' } }];
  assert.doesNotThrow(() => checkQuarantine(dir, 'playwright-quarantine.json', null, results, 14));
  await tools.close();
});

test('the Cypress plugin saves what a test saw and serves the quarantine list', async () => {
  const require = (await import('node:module')).createRequire(import.meta.url);
  const autoheal = require('../cypress/plugin.cjs');
  const dir = tmp('autoheal-plugin-');
  writeFileSync(path.join(dir, 'playwright-quarantine.json'), JSON.stringify({ version: 1, entries: [{ file: 'cypress/e2e/a.cy.js', title: 't', until: '2099-01-01', owner: 'x', reason: 'y' }, { bad: 1 }] }));
  const tasks = {};
  autoheal((event, handlers) => event === 'task' && Object.assign(tasks, handlers), { projectRoot: dir });
  tasks['autoheal:save']({ version: 1, spec: 'cypress/e2e/a.cy.js', title: 'a t', calls: [{ callId: '0', selector: '#x', failed: false }] });
  assert.equal((await loadCypressDoms(dir, ['cypress/autoheal'])).length, 1);
  assert.equal(tasks['autoheal:quarantine']().length, 1);
  assert.equal(tasks['autoheal:save'](null), null);
  const esm = await import('../cypress/plugin.mjs');
  assert.equal(esm.default, autoheal);
});

// ---------- learned fingerprints, init, doctor, local runs ----------

test('learned fingerprints: only well-formed entries are unpacked and loaded', async () => {
  const src = tmp('autoheal-zip-');
  const good = { at: '2026-11-01T00:00:00Z', selector: 'internal:role=button[name="Go"i]', fingerprint: { tag: 'BUTTON', role: 'button', name: 'Go' } };
  writeFileSync(path.join(src, '0123456789abcdef.json'), JSON.stringify(good));
  writeFileSync(path.join(src, 'fedcba9876543210.json'), JSON.stringify({ selector: 1 }));
  writeFileSync(path.join(src, 'evil.sh'), 'rm -rf /');
  execFileSync('zip', ['-q', path.join(src, 'a.zip'), '0123456789abcdef.json', 'fedcba9876543210.json', 'evil.sh'], { cwd: src });
  const out = tmp('autoheal-learned-');
  assert.equal(await unpackLearned(readFileSync(path.join(src, 'a.zip')), out), 1);
  assert.equal(existsSync(path.join(out, 'evil.sh')), false);
  const loaded = await loadLearned(out);
  assert.equal(loaded[0].selector, good.selector);
});

function project(files) {
  const dir = tmp('autoheal-init-');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  git(dir, 'init', '-q');
  git(dir, 'remote', 'add', 'origin', 'git@github.com:acme/shop.git');
  return dir;
}

test('init for GitHub: fills in the test workflow and install steps, and lists what is missing', async () => {
  const dir = project({
    'package.json': '{"devDependencies":{"@playwright/test":"^1.58.2"}}',
    'pnpm-lock.yaml': '',
    'playwright.config.ts': "export default { reporter: [['json', { outputFile: 'r.json' }]], use: { trace: 'retain-on-failure' } };",
    '.github/workflows/e2e.yml': 'name: "Shop E2E"\non: [push]\njobs:\n  t:\n    steps:\n      - run: pnpm exec playwright test\n      - uses: actions/upload-artifact@v4\n',
  });
  const r = await init(dir);
  assert.equal(r.project.ci, 'github');
  assert.deepEqual(r.written, ['.github/workflows/autoheal.yml', '.gitignore']);
  const wf = readFileSync(path.join(dir, '.github/workflows/autoheal.yml'), 'utf8');
  assert.match(wf, /workflows: \["Shop E2E"\]/);
  assert.match(wf, /pnpm install --frozen-lockfile\n\s+pnpm exec playwright install --with-deps chromium/);
  assert.doesNotMatch(wf, /run: \|\n\s+npm ci/);
  assert.match(wf, /rerun-workflow: \$\{\{ needs\.heal\.outputs\.workflow \}\}/);
  assert.match(wf, /learn --out \.autoheal-learned/);
  const dispatch = r.checks.find((c) => /workflow_dispatch/.test(c.what));
  assert.equal(dispatch.level, 'warn');
  const links = r.steps.join('\n').match(/https:\/\/\S+?(?=[.)]?(?:\s|$))/g) ?? [];
  assert.equal(links[0], 'https://github.com/acme/shop/settings/secrets/actions/new');
  assert.match(readFileSync(path.join(dir, '.gitignore'), 'utf8'), /\.autoheal-local\//);
  // A second run keeps the file.
  assert.deepEqual((await init(dir)).skipped, ['.github/workflows/autoheal.yml']);
});

test('init for GitLab and CircleCI, with the right image, report folder and include', async () => {
  const dir = project({ 'package.json': '{"devDependencies":{"@playwright/test":"1.57.0"}}', 'playwright.config.ts': '', '.gitlab-ci.yml': 'e2e:\n  script: npx playwright test\n' });
  const r = await init(dir, { ci: 'gitlab' });
  assert.deepEqual(r.written, ['.gitlab/autoheal.yml', '.gitlab-ci.yml (include added)', '.gitignore']);
  const yml = readFileSync(path.join(dir, '.gitlab/autoheal.yml'), 'utf8');
  assert.match(yml, /mcr\.microsoft\.com\/playwright:v1\.57\.0-noble/);
  assert.match(yml, /AUTOHEAL_REPORT: "playwright-report"/);
  assert.match(readFileSync(path.join(dir, '.gitlab-ci.yml'), 'utf8'), /include:\n  - local: \.gitlab\/autoheal\.yml/);
  assert.ok(r.checks.some((c) => /drop its artifacts/.test(c.what)));

  const cy = project({ 'package.json': '{}', 'cypress.config.js': '', 'cypress/support/e2e.js': '' });
  const p = await detect(cy, 'circleci');
  assert.equal(p.framework, 'cypress');
  const t = renderTemplate(p);
  assert.equal(t.file, '.circleci/autoheal.yml');
  assert.match(t.text, /requires:\n\s+- e2e: failed/);
  const doc = await doctor(cy, {}, { ci: 'circleci' });
  assert.ok(doc.some((c) => c.level === 'warn' && /Cypress plugin is not in your support file/.test(c.what)));
  assert.ok(doc.some((c) => c.level === 'fail' && /autoheal\.yml is missing/.test(c.what)));
});

test('local runs use a JSON report and traces for fix, traces on for learn', () => {
  const fix = testRun('playwright', 'fix', '.autoheal-local/run');
  assert.deepEqual(fix.args, ['playwright', 'test', '--reporter=json', '--trace=retain-on-failure', '--output', '.autoheal-local/run/test-results']);
  assert.equal(fix.env.PLAYWRIGHT_JSON_OUTPUT_NAME, '.autoheal-local/run/results.json');
  assert.ok(testRun('playwright', 'learn', 'x').args.includes('--trace=on'));
  assert.ok(testRun('cypress', 'fix', 'x').args.includes('junit'));
  assert.equal(testRun('cypress', 'learn', 'x').env.AUTOHEAL_DOM_DIR, path.join('x', 'autoheal'));
  assert.ok(testRun('pytest', 'fix', 'x').args.includes('--junitxml=x/junit.xml'));
});

test('demo project: workflow equals the template, test workflow can be dispatched', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const demo = path.join(root, 'examples', 'demo');
  assert.equal(readFileSync(path.join(demo, '.github/workflows/autoheal.yml'), 'utf8'), readFileSync(path.join(root, 'templates/autoheal.yml'), 'utf8'));
  const e2e = readFileSync(path.join(demo, '.github/workflows/e2e.yml'), 'utf8');
  assert.match(e2e, /^name: Playwright Tests$/m);
  assert.match(e2e, /workflow_dispatch:/);
  assert.ok(existsSync(path.join(demo, 'package-lock.json')));
});
