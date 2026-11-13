/**
 * `autoheal init` and `autoheal doctor`: the first ten minutes.
 *
 * init finds your CI, test framework, package manager and test workflow,
 * writes the AutoHeal workflow for GitHub Actions, GitLab CI or CircleCI from
 * the bundled templates, adds AutoHeal's folders to .gitignore and prints the
 * few things only you can do (a secret, a repository setting), with links.
 *
 * doctor checks the same things any time, plus the local machine, and says
 * how to fix each one. Neither command runs your tests or changes your code.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRepoUrl } from './ci.js';
import { isCypressProject } from './cypress.js';
import { isPytestProject } from './heal.js';
import { loadPolicy } from './policy.js';
import { VERSION } from './version.js';
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const GITIGNORE_LINES = ['.autoheal-out/', '.autoheal-local/', '.autoheal-learned/', 'autoheal-result/', 'autoheal-artifacts/', 'autoheal-healed/'];
function read(file) {
    try {
        return readFileSync(file, 'utf8');
    }
    catch {
        return '';
    }
}
function gitRemote(root) {
    try {
        const url = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
        return parseRepoUrl(url);
    }
    catch {
        return undefined;
    }
}
/** The GitHub workflow that runs the tests (not AutoHeal's own). */
export function findTestWorkflow(root, framework) {
    const dir = path.join(root, '.github', 'workflows');
    let names = [];
    try {
        names = readdirSync(dir).filter((n) => /\.ya?ml$/.test(n) && !/^autoheal/.test(n));
    }
    catch {
        return undefined;
    }
    const runs = framework === 'cypress' ? /cypress run|cypress-io\/github-action/ : framework === 'pytest' ? /\bpytest\b/ : /playwright test/;
    for (const file of names.sort()) {
        const text = read(path.join(dir, file));
        if (!runs.test(text))
            continue;
        const name = /^name:\s*["']?(.+?)["']?\s*$/m.exec(text)?.[1] ?? file;
        return { name, file, text };
    }
    return undefined;
}
export async function detect(root, ci) {
    const framework = (await isCypressProject(root)) ? 'cypress' : (await isPytestProject(root)) ? 'pytest' : 'playwright';
    const remote = gitRemote(root);
    const has = (p) => existsSync(path.join(root, p));
    const chosen = ci ?? (has('.gitlab-ci.yml') ? 'gitlab' : has('.circleci/config.yml') ? 'circleci' : has('.github/workflows') ? 'github' : remote && /gitlab/.test(remote.host) ? 'gitlab' : 'github');
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('package.json') ? 'npm' : 'none';
    let playwrightVersion;
    try {
        const pkg = JSON.parse(read(path.join(root, 'package.json')) || '{}');
        const v = pkg.devDependencies?.['@playwright/test'] ?? pkg.dependencies?.['@playwright/test'];
        const m = v ? /(\d+\.\d+\.\d+)/.exec(v) : null;
        if (m?.[1])
            playwrightVersion = m[1];
    }
    catch {
        // no package.json
    }
    const workflow = chosen === 'github' ? findTestWorkflow(root, framework) : undefined;
    return { root, ci: chosen, framework, pm, ...(remote ? { remote } : {}), ...(workflow ? { workflow } : {}), ...(playwrightVersion ? { playwrightVersion } : {}) };
}
function installLines(p) {
    const deps = p.pm === 'pnpm' ? 'pnpm install --frozen-lockfile' : p.pm === 'yarn' ? 'yarn install --frozen-lockfile' : p.pm === 'npm' ? 'npm ci' : '';
    const exec = p.pm === 'pnpm' ? 'pnpm exec' : p.pm === 'yarn' ? 'yarn' : 'npx';
    if (p.framework === 'pytest')
        return ['pip install -r requirements.txt', 'python -m playwright install --with-deps chromium'];
    if (p.framework === 'cypress')
        return [deps || 'npm ci'];
    return [deps || 'npm ci', `${exec} playwright install --with-deps chromium`];
}
/** The bundled template, filled in for this project. */
export function renderTemplate(p) {
    const lines = installLines(p);
    if (p.ci === 'github') {
        let text = read(path.join(PACKAGE_ROOT, 'templates', 'autoheal.yml'));
        if (p.workflow)
            text = text.replace('workflows: ["Playwright Tests"]', `workflows: [${JSON.stringify(p.workflow.name)}]`);
        const block = `        run: |\n${lines.map((l) => `          ${l}`).join('\n')}\n`;
        text = text.split('        run: |\n          npm ci\n          npx playwright install --with-deps chromium\n').join(block);
        if (p.framework === 'pytest') {
            const py = '      - uses: actions/setup-python@v5\n        with:\n          python-version: "3.12"\n\n      - name: Install dependencies and browsers\n';
            text = text.split('      - name: Install dependencies and browsers\n').join(py);
        }
        return { file: '.github/workflows/autoheal.yml', text: text.split('0.13.0').join(VERSION) };
    }
    if (p.ci === 'gitlab') {
        let text = read(path.join(PACKAGE_ROOT, 'templates', 'gitlab-ci.yml'));
        const image = p.framework === 'cypress' ? 'cypress/browsers:latest' : p.playwrightVersion ? `mcr.microsoft.com/playwright:v${p.playwrightVersion}-noble` : 'mcr.microsoft.com/playwright:v1.56.1-noble';
        text = text.replace('image: mcr.microsoft.com/playwright:v1.56.1-noble', `image: ${image}`);
        text = text.replace('AUTOHEAL_REPORT: "."', `AUTOHEAL_REPORT: ${JSON.stringify(p.framework === 'cypress' ? 'cypress' : p.framework === 'pytest' ? '.' : 'playwright-report')}`);
        text = text.split('    - npm ci\n').join(lines.map((l) => `    - ${l}\n`).join(''));
        return { file: '.gitlab/autoheal.yml', text: text.split('0.13.0').join(VERSION) };
    }
    let text = read(path.join(PACKAGE_ROOT, 'templates', 'circleci-config.yml'));
    if (p.playwrightVersion)
        text = text.split('mcr.microsoft.com/playwright:v1.56.1-noble').join(`mcr.microsoft.com/playwright:v${p.playwrightVersion}-noble`);
    text = text.split('      - run: npm ci\n').join(lines.map((l) => `      - run: ${l}\n`).join(''));
    return { file: '.circleci/autoheal.yml', text: text.split('0.13.0').join(VERSION) };
}
/** What the project's own files say about the setup, as checks. */
export function projectChecks(p) {
    const out = [];
    const root = p.root;
    if (p.framework === 'playwright') {
        const config = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs', 'playwright.config.mts'].map((n) => read(path.join(root, n))).find(Boolean) ?? '';
        out.push(/['"](?:json|blob)['"]/.test(config)
            ? { level: 'ok', what: 'Playwright writes a JSON or blob report' }
            : { level: 'fail', what: 'Playwright writes no JSON or blob report', fix: "In playwright.config, add: reporter: [['list'], ['json', { outputFile: 'playwright-report/results.json' }]]" });
        out.push(/trace\s*:\s*['"](?:on|retain-on-failure|on-first-retry|on-all-retries|retain-on-first-failure)['"]/.test(config)
            ? { level: 'ok', what: 'Playwright keeps traces' }
            : { level: 'warn', what: 'Playwright keeps no traces (no runtime guard, screenshots or fingerprint fixes)', fix: "In playwright.config, add: use: { trace: 'retain-on-failure' }" });
    }
    else if (p.framework === 'cypress') {
        const support = ['cypress/support/e2e.js', 'cypress/support/e2e.ts', 'cypress/support/e2e.mjs', 'cypress/support/index.js', 'cypress/support/index.ts'].map((n) => read(path.join(root, n))).join('\n');
        const config = ['cypress.config.js', 'cypress.config.ts', 'cypress.config.mjs', 'cypress.config.cjs', 'cypress.config.mts'].map((n) => read(path.join(root, n))).join('\n');
        out.push(/xsignon-autoheal\/cypress['"]/.test(support)
            ? { level: 'ok', what: 'The AutoHeal Cypress support file is loaded' }
            : { level: 'warn', what: 'The AutoHeal Cypress plugin is not in your support file (no fingerprint fixes or quarantine)', fix: "Add to cypress/support/e2e.js: import 'xsignon-autoheal/cypress';" });
        out.push(/xsignon-autoheal\/cypress\/plugin/.test(config)
            ? { level: 'ok', what: 'The AutoHeal Cypress plugin is registered' }
            : { level: 'warn', what: 'The AutoHeal Cypress plugin is not registered in cypress.config', fix: "In setupNodeEvents(on, config): require('xsignon-autoheal/cypress/plugin')(on, config); return config;" });
        out.push({ level: 'ok', what: 'Cypress: keep cypress/results/, cypress/screenshots/ and cypress/autoheal/ as artifacts of your test job' });
    }
    if (p.ci === 'github') {
        const wf = p.workflow;
        if (!wf)
            out.push({ level: 'warn', what: 'No test workflow found in .github/workflows', fix: 'Set the name under `workflows:` in .github/workflows/autoheal.yml to your test workflow.' });
        else {
            out.push({ level: 'ok', what: `Test workflow: "${wf.name}" (${wf.file})` });
            out.push(/upload-artifact/.test(wf.text)
                ? { level: 'ok', what: `${wf.file} uploads artifacts` }
                : { level: 'fail', what: `${wf.file} uploads no artifacts, so AutoHeal has no report to read`, fix: 'After the tests add a step: uses: actions/upload-artifact@v4, with if: failure() and path: playwright-report/ and test-results/ (Cypress: cypress/results/, cypress/screenshots/, cypress/autoheal/)' });
            out.push(/workflow_dispatch/.test(wf.text)
                ? { level: 'ok', what: `${wf.file} can be started on the fix PR` }
                : { level: 'warn', what: `${wf.file} has no workflow_dispatch trigger, so CI will not run on AutoHeal's PRs`, fix: `Add \`workflow_dispatch:\` to the \`on:\` list of ${wf.file}.` });
        }
    }
    if (p.ci === 'gitlab') {
        const ci = read(path.join(root, '.gitlab-ci.yml'));
        out.push(/autoheal\.yml/.test(ci)
            ? { level: 'ok', what: '.gitlab-ci.yml includes AutoHeal' }
            : { level: 'fail', what: '.gitlab-ci.yml does not include AutoHeal', fix: 'Add to .gitlab-ci.yml:\n  include:\n    - local: .gitlab/autoheal.yml' });
        if (ci && !/when:\s*always/.test(ci))
            out.push({ level: 'warn', what: 'Your test job may drop its artifacts when it fails', fix: 'In your test job: artifacts: { when: always, paths: [playwright-report/, test-results/] }' });
    }
    if (p.ci === 'circleci') {
        const cfg = read(path.join(root, '.circleci', 'config.yml'));
        out.push(/autoheal-heal/.test(cfg)
            ? { level: 'ok', what: '.circleci/config.yml has the AutoHeal jobs' }
            : { level: 'fail', what: '.circleci/config.yml has no AutoHeal jobs yet', fix: 'Copy the jobs and workflow lines from .circleci/autoheal.yml into .circleci/config.yml.' });
    }
    try {
        loadPolicy(root);
    }
    catch (error) {
        out.push({ level: 'fail', what: `.autoheal.yml is invalid: ${error instanceof Error ? error.message : String(error)}`, fix: 'Fix it or remove it.' });
    }
    const ignore = read(path.join(root, '.gitignore'));
    const missing = GITIGNORE_LINES.filter((l) => !ignore.split('\n').some((x) => x.trim() === l));
    if (missing.length)
        out.push({ level: 'warn', what: `.gitignore is missing ${missing.join(', ')}`, fix: 'Run `npx xsignon-autoheal init` or add them by hand.' });
    return out;
}
/** The things only you can do: secrets and repository settings, with links. */
export function manualSteps(p) {
    const web = p.remote ? `https://${p.remote.host}/${p.remote.repo}` : undefined;
    if (p.ci === 'github') {
        return [
            `Add your AI key as the repository secret ANTHROPIC_API_KEY (or OPENAI_API_KEY)${web ? `: ${web}/settings/secrets/actions/new` : ''}. Use a key with a spend limit.`,
            `Let workflows open pull requests: Settings > Actions > General > Workflow permissions > "Allow GitHub Actions to create and approve pull requests"${web ? ` (${web}/settings/actions)` : ''}.`,
            'Commit .github/workflows/autoheal.yml to your default branch (workflow_run only fires from there).',
        ];
    }
    if (p.ci === 'gitlab') {
        return [
            `Add ANTHROPIC_API_KEY (masked) under Settings > CI/CD > Variables${web ? `: ${web}/-/settings/ci_cd` : ''}.`,
            `Create a project access token (role Developer, scopes api and write_repository)${web ? ` at ${web}/-/settings/access_tokens` : ''} and add it as the masked variable AUTOHEAL_GITLAB_TOKEN, scoped to the environment autoheal-publish.`,
            `For fingerprints learned every day, add a daily pipeline schedule on your default branch${web ? `: ${web}/-/pipeline_schedules` : ''}.`,
        ];
    }
    return [
        'Copy the jobs and the workflow lines from .circleci/autoheal.yml into .circleci/config.yml (CircleCI reads one file).',
        'Create the context autoheal-ai with ANTHROPIC_API_KEY, and the context autoheal-publish with AUTOHEAL_GITHUB_TOKEN (Contents, Pull requests and Issues read and write) or AUTOHEAL_GITLAB_TOKEN.',
    ];
}
export async function init(root, options = {}) {
    const project = await detect(root, options.ci);
    const written = [];
    const skipped = [];
    const write = async (rel, text) => {
        const abs = path.join(root, rel);
        if (options.dryRun) {
            (existsSync(abs) && !options.force ? skipped : written).push(rel);
            return;
        }
        await mkdir(path.dirname(abs), { recursive: true });
        try {
            // 'wx' fails if the file exists, so an existing workflow is never overwritten by accident.
            await writeFile(abs, text, { flag: options.force ? 'w' : 'wx' });
        }
        catch (err) {
            if (err.code === 'EEXIST') {
                skipped.push(rel);
                return;
            }
            throw err;
        }
        written.push(rel);
    };
    const t = renderTemplate(project);
    await write(t.file, t.text);
    // GitLab: include the file from .gitlab-ci.yml when that is a plain append.
    if (project.ci === 'gitlab') {
        const ciFile = path.join(root, '.gitlab-ci.yml');
        const ci = await readFile(ciFile, 'utf8').catch(() => '');
        if (ci && !/autoheal\.yml/.test(ci) && !/^include:/m.test(ci)) {
            if (!options.dryRun)
                await writeFile(ciFile, `${ci.replace(/\s*$/, '\n')}\ninclude:\n  - local: .gitlab/autoheal.yml\n`);
            written.push('.gitlab-ci.yml (include added)');
        }
    }
    // .gitignore: AutoHeal's working folders.
    const ignoreFile = path.join(root, '.gitignore');
    const ignore = await readFile(ignoreFile, 'utf8').catch(() => '');
    const missing = GITIGNORE_LINES.filter((l) => !ignore.split('\n').some((x) => x.trim() === l));
    if (missing.length) {
        if (!options.dryRun)
            await writeFile(ignoreFile, `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}# AutoHeal AI\n${missing.join('\n')}\n`);
        written.push('.gitignore');
    }
    const after = options.dryRun ? project : await detect(root, project.ci);
    return { project, written, skipped, checks: projectChecks(after), steps: manualSteps(project) };
}
function sudoWorks() {
    try {
        execFileSync('sudo', ['-n', 'true'], { stdio: 'ignore', timeout: 10_000 });
        return true;
    }
    catch {
        return false;
    }
}
/** Every check: the project's setup and this machine. */
export async function doctor(root, env = process.env, options = {}) {
    const p = await detect(root, options.ci);
    const out = [];
    const [major, minor] = process.versions.node.split('.').map(Number);
    out.push(major > 22 || (major === 22 && minor >= 13) ? { level: 'ok', what: `Node ${process.versions.node}` } : { level: 'fail', what: `Node ${process.versions.node} is too old`, fix: 'Use Node 22.13 or newer.' });
    out.push(p.remote ? { level: 'ok', what: `Repository: ${p.remote.host}/${p.remote.repo}` } : { level: 'warn', what: 'No git remote named origin', fix: 'AutoHeal opens PRs on GitHub or GitLab; set the origin remote.' });
    out.push({ level: 'ok', what: `Framework: ${p.framework} · CI: ${p.ci} · package manager: ${p.pm}` });
    const ciFile = p.ci === 'github' ? '.github/workflows/autoheal.yml' : p.ci === 'gitlab' ? '.gitlab/autoheal.yml' : '.circleci/autoheal.yml';
    out.push(existsSync(path.join(root, ciFile)) ? { level: 'ok', what: `${ciFile} exists` } : { level: 'fail', what: `${ciFile} is missing`, fix: `Run: npx xsignon-autoheal init --ci ${p.ci}` });
    out.push(...projectChecks(p));
    const key = env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.AUTOHEAL_BASE_URL;
    out.push(key
        ? { level: 'ok', what: 'An AI key is set here (for `autoheal fix`)' }
        : { level: 'warn', what: 'No AI key here: only fixes without AI (fingerprints, rules) will run locally', fix: 'export ANTHROPIC_API_KEY=... (in CI, add it as a secret)' });
    const prints = (() => {
        try {
            return readdirSync(path.join(root, '.autoheal', 'fingerprints')).filter((n) => n.endsWith('.json')).length;
        }
        catch {
            return 0;
        }
    })();
    out.push(prints
        ? { level: 'ok', what: `${prints} element fingerprint(s) saved in .autoheal/fingerprints` }
        : { level: 'warn', what: 'No element fingerprints yet, so the first broken locator needs the AI', fix: 'Run `npx xsignon-autoheal learn` once (or let the daily learn job do it).' });
    if (process.platform === 'linux') {
        out.push(sudoWorks() ? { level: 'ok', what: 'Sandbox available (passwordless sudo)' } : { level: 'warn', what: 'No passwordless sudo here: tests run without the sandbox user', fix: 'Fine on your own machine; in CI use a Linux runner or image with sudo (or root).' });
    }
    else {
        out.push({ level: 'warn', what: `Sandbox not available on ${process.platform}`, fix: 'Fine on your own machine; CI runs on Linux.' });
    }
    return out;
}
export function checksText(checks) {
    const mark = { ok: '✓', warn: '!', fail: '✗' };
    return checks.map((c) => `${mark[c.level]} ${c.what}${c.fix && c.level !== 'ok' ? `\n    → ${c.fix.split('\n').join('\n      ')}` : ''}`).join('\n');
}
//# sourceMappingURL=setup.js.map