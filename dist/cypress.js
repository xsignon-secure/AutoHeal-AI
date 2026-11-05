/**
 * Cypress support. Healing a Cypress test needs the same steps as a
 * Playwright one (read the failed run, triage, propose, guard, rerun until it
 * is stable), so this module gives heal() the same tool interface as the
 * playwright-e2e-mcp engine, backed by Cypress:
 *
 *   load-report        a Cypress JUnit XML report (the built-in junit reporter),
 *                      mochawesome JSON, or the results of `cypress.run()`
 *   get-failure        one failure, with its kind, expected and actual values
 *   run-test           runs specs through Cypress's module API, as the sandbox
 *                      user, and reports the tests that match `grep`
 *   diagnose-flaky     reruns the spec and compares the outcomes
 *   check-test-change  the whole-tree check against git HEAD (per-file checks
 *                      fall back to the strict local scan)
 *   inspect-page       the engine's page inspector, started on demand
 *
 * Trace-based steps (fingerprints, the runtime guard, engine locator fixes,
 * quarantine) are Playwright features and are reported as unavailable.
 */
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, mkdtemp, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { scanChange } from './cheat.js';
import { engineEnv, McpTools } from './mcp.js';
import { wrapCommand } from './sandbox.js';
const execFileP = promisify(execFile);
const PLAYWRIGHT_CONFIGS = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs', 'playwright.config.mts'];
const CYPRESS_CONFIGS = ['cypress.config.ts', 'cypress.config.js', 'cypress.config.mjs', 'cypress.config.cjs', 'cypress.config.mts', 'cypress.json'];
/** A report file larger than this is not read. */
const MAX_REPORT_BYTES = 20 * 1024 * 1024;
const MAX_REPORT_FILES = 500;
async function exists(file) {
    try {
        await stat(file);
        return true;
    }
    catch {
        return false;
    }
}
/** A Cypress project: a Cypress config and no Playwright config. */
export async function isCypressProject(root) {
    for (const name of PLAYWRIGHT_CONFIGS)
        if (await exists(path.join(root, name)))
            return false;
    for (const name of CYPRESS_CONFIGS)
        if (await exists(path.join(root, name)))
            return true;
    return false;
}
/** AUTOHEAL_FRAMEWORK / --framework: auto, playwright, pytest or cypress. */
export function frameworkSetting(value) {
    const v = (value ?? 'auto').trim().toLowerCase();
    if (v === '' || v === 'auto')
        return 'auto';
    if (v === 'playwright' || v === 'pytest' || v === 'cypress')
        return v;
    throw new Error(`framework must be auto, playwright, pytest or cypress (got "${value}")`);
}
// ---------------------------------------------------------------------------
// Report parsing
function decodeXml(text) {
    return text.replace(/&(?:lt|gt|amp|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g, (e) => {
        switch (e) {
            case '&lt;':
                return '<';
            case '&gt;':
                return '>';
            case '&amp;':
                return '&';
            case '&quot;':
                return '"';
            case '&apos;':
                return "'";
            default: {
                const code = e[2] === 'x' ? parseInt(e.slice(3, -1), 16) : parseInt(e.slice(2, -1), 10);
                return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
            }
        }
    });
}
function attributes(tag) {
    const out = {};
    for (const m of tag.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g))
        out[m[1]] = decodeXml(m[2]);
    return out;
}
/** The text inside an element: CDATA sections kept as they are, everything else decoded. */
function innerText(body) {
    let out = '';
    let i = 0;
    while (i < body.length) {
        const start = body.indexOf('<![CDATA[', i);
        if (start < 0) {
            out += decodeXml(body.slice(i));
            break;
        }
        out += decodeXml(body.slice(i, start));
        const end = body.indexOf(']]>', start + 9);
        out += body.slice(start + 9, end < 0 ? body.length : end);
        i = end < 0 ? body.length : end + 3;
    }
    return out.trim();
}
/**
 * Cypress's built-in junit reporter (mocha-junit-reporter). The spec file is
 * on the "Root Suite" testsuite; each testcase's name is the full title.
 */
export function parseJunit(xml) {
    const tests = [];
    let file = '';
    // Walk the document tag by tag (no nested quantifiers, so no slow regex on big reports).
    let i = 0;
    while (i < xml.length) {
        const open = xml.indexOf('<', i);
        if (open < 0)
            break;
        if (xml.startsWith('<![CDATA[', open)) {
            const end = xml.indexOf(']]>', open);
            i = end < 0 ? xml.length : end + 3;
            continue;
        }
        const close = xml.indexOf('>', open);
        if (close < 0)
            break;
        const tag = xml.slice(open, close + 1);
        i = close + 1;
        if (/^<testsuite[\s>]/.test(tag)) {
            const a = attributes(tag);
            if (a.file)
                file = a.file;
            continue;
        }
        if (!/^<testcase[\s>/]/.test(tag))
            continue;
        const a = attributes(tag);
        const test = { file: a.file || file, title: a.name ?? '', state: 'passed' };
        if (!tag.endsWith('/>')) {
            const end = xml.indexOf('</testcase>', i);
            const body = xml.slice(i, end < 0 ? xml.length : end);
            i = end < 0 ? xml.length : end + 11;
            const failure = /<(failure|error)(\s[^>]*)?(\/>|>)/.exec(body);
            if (failure) {
                test.state = 'failed';
                const fa = attributes(failure[0]);
                let text = '';
                if (failure[3] === '>') {
                    const from = failure.index + failure[0].length;
                    const to = body.indexOf(`</${failure[1]}>`, from);
                    text = innerText(body.slice(from, to < 0 ? body.length : to));
                }
                test.message = fa.message || text.split('\n')[0] || 'failed';
                test.stack = text;
            }
            else if (/<skipped[\s/>]/.test(body)) {
                test.state = 'skipped';
            }
        }
        if (test.title)
            tests.push(test);
    }
    return tests;
}
/** mochawesome JSON (also after mochawesome-merge). */
export function parseMochawesome(report) {
    const tests = [];
    const walk = (suite, file, depth) => {
        if (depth > 50)
            return;
        const here = suite.file || suite.fullFile || file;
        for (const t of suite.tests ?? []) {
            const title = t.fullTitle ?? t.title ?? '';
            if (!title)
                continue;
            const state = t.fail || t.state === 'failed' ? 'failed' : t.pending ? 'pending' : t.skipped ? 'skipped' : 'passed';
            const test = { file: here, title, state };
            if (state === 'failed') {
                test.message = (t.err?.message ?? 'failed').split('\n')[0] ?? 'failed';
                test.stack = t.err?.estack ?? t.err?.message ?? '';
                if (t.err?.message && t.err.message.includes('\n'))
                    test.message = t.err.message;
            }
            tests.push(test);
        }
        for (const s of suite.suites ?? [])
            walk(s, here, depth + 1);
    };
    for (const r of report.results ?? [])
        walk(r, '', 0);
    return tests;
}
/** The results of `cypress.run()` (the module API), or AutoHeal's slim copy of them. */
export function parseModuleResults(report) {
    const tests = [];
    for (const run of report.runs ?? []) {
        const file = typeof run.spec === 'string' ? run.spec : (run.spec?.relative ?? run.spec?.absolute ?? '');
        const shots = (run.screenshots ?? []).map((s) => s.path ?? '').filter((p) => /\(failed\)/.test(p));
        for (const t of run.tests ?? []) {
            const title = Array.isArray(t.title) ? t.title.join(' ') : (t.title ?? '');
            if (!title)
                continue;
            const state = t.state === 'failed' ? 'failed' : t.state === 'pending' ? 'pending' : t.state === 'skipped' ? 'skipped' : 'passed';
            const test = { file, title, state };
            const error = t.displayError ?? t.error ?? '';
            if (state === 'failed') {
                test.message = error || 'failed';
                test.stack = error;
                const last = Array.isArray(t.title) ? t.title[t.title.length - 1] : title;
                const shot = shots.find((p) => last && path.basename(p).includes(last.slice(0, 40)));
                if (shot)
                    test.screenshot = shot;
            }
            tests.push(test);
        }
    }
    return tests;
}
/** Any of the three formats, by content. Returns null when this is not a Cypress result. */
export function parseCypressReport(text) {
    const trimmed = text.trimStart();
    if (trimmed.startsWith('<')) {
        if (!/<testsuites?[\s>]/.test(trimmed.slice(0, 4096)))
            return null;
        return parseJunit(trimmed);
    }
    if (!trimmed.startsWith('{'))
        return null;
    let json;
    try {
        json = JSON.parse(trimmed);
    }
    catch {
        return null;
    }
    if (!json || typeof json !== 'object')
        return null;
    const o = json;
    if (Array.isArray(o.runs))
        return parseModuleResults(o);
    if (Array.isArray(o.results) && o.stats)
        return parseMochawesome(o);
    return null;
}
// ---------------------------------------------------------------------------
// Failure reading
/** The text between `start` and the first `end` after it, or null. */
function between(text, start, end, from = 0) {
    const a = text.indexOf(start, from);
    if (a < 0)
        return null;
    const b = text.indexOf(end, a + start.length);
    if (b < 0)
        return null;
    return { value: text.slice(a + start.length, b), at: b + end.length };
}
const unquote = (v) => v.trim().replace(/^'([\s\S]*)'$/, '$1').replace(/^"([\s\S]*)"$/, '$1');
/** Expected and actual values from Cypress and chai assertion messages. */
export function cypressValues(message) {
    const line = message.split('\n').find((l) => /\bexpected\b/i.test(l)) ?? '';
    // cy.get(...).should('have.text', 'A'): "expected '<p#msg>' to have text 'A', but the text was 'B'"
    for (const what of ['text', 'value']) {
        const want = between(line, ` to have ${what} '`, `', but the ${what} was '`);
        if (want) {
            const got = line.slice(want.at).replace(/'\s*$/, '');
            return { expected: want.value, actual: got };
        }
    }
    // chai: "expected 'B' to equal 'A'", "expected 3 to deep equal 4"
    const lower = line.toLowerCase();
    const start = lower.indexOf('expected ');
    if (start >= 0) {
        for (const verb of [' to deep equal ', ' to deeply equal ', ' to equal ', ' to eq ']) {
            const at = lower.indexOf(verb, start + 9);
            if (at < 0)
                continue;
            const actual = unquote(line.slice(start + 9, at));
            const expected = unquote(line.slice(at + verb.length).trimEnd());
            if (actual.startsWith('<') || actual.startsWith('['))
                return {};
            return { expected, actual };
        }
    }
    return {};
}
/** The engine's failure kinds, from a Cypress error. */
export function cypressKind(message) {
    const m = message.slice(0, 5000);
    if (/webpack compilation error|syntaxerror|unexpected token|module not found|cannot find module|error: (?:cannot|can't) resolve/i.test(m))
        return 'syntax';
    if (/could not verify that this server is running|cy\.visit\(\) failed trying to load|ECONNREFUSED|ESOCKETTIMEDOUT|ERR_CONNECTION_REFUSED/i.test(m))
        return 'server-unreachable';
    if (/renderer process (?:just )?crashed|browser (?:process )?(?:crashed|exited unexpectedly)|out of memory/i.test(m))
        return 'browser-crash';
    if (/configfile is invalid|could not find a cypress configuration|your configfile/i.test(m))
        return 'config';
    if (/expected to find (?:element|content)\b|but never found it|but never did|can only be called on a single element|subject contained \d+ elements/i.test(m))
        return 'timeout';
    if (/\bexpected\b[^\n]{0,400}\bto (?:have|equal|eq|deep|include|contain|be|match)\b|AssertionError/i.test(m))
        return 'assertion';
    if (/timed out retrying|timed out after|cypress command timeout/i.test(m))
        return 'timeout';
    return 'unknown';
}
function lineIn(stack, file) {
    const base = path.posix.basename(file.replace(/\\/g, '/'));
    if (!base)
        return undefined;
    let at = stack.indexOf(`${base}:`);
    while (at >= 0) {
        const m = /^:(\d+):\d+/.exec(stack.slice(at + base.length, at + base.length + 20));
        if (m)
            return Number(m[1]);
        at = stack.indexOf(`${base}:`, at + 1);
    }
    return undefined;
}
export function toFailure(test) {
    const message = test.message ?? 'failed';
    const stack = test.stack ?? '';
    const f = { file: test.file, title: test.title, kind: cypressKind(`${message}\n${stack}`), message, stack };
    const line = lineIn(stack, test.file);
    if (line !== undefined)
        f.line = line;
    const values = cypressValues(message);
    if (values.expected !== undefined && values.actual !== undefined && f.kind === 'assertion') {
        f.expected = values.expected;
        f.actual = values.actual;
    }
    if (test.screenshot)
        f.screenshotPath = test.screenshot;
    return f;
}
export function failureMarkdown(f) {
    const out = [`## ${f.file} › ${f.title}`, '', '### Error', '```', f.message.slice(0, 4000), '```'];
    const frames = f.stack
        .split('\n')
        .filter((l) => /^\s*at\s/.test(l) || /\.(?:cy|spec|test)\.[cm]?[jt]sx?:\d+/.test(l))
        .slice(0, 15);
    if (frames.length)
        out.push('', '### Stack', '```', ...frames, '```');
    if (f.expected !== undefined)
        out.push('', `Expected: ${f.expected}`, `Received: ${f.actual ?? ''}`);
    if (f.screenshotPath)
        out.push('', `Screenshot: ${f.screenshotPath}`);
    out.push('', 'Framework: Cypress (no Playwright trace: fix the selector from the error, the spec and the app source).');
    return out.join('\n');
}
// ---------------------------------------------------------------------------
// Files
async function listFiles(dir, depth, out) {
    if (depth > 5 || out.length >= MAX_REPORT_FILES)
        return;
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const e of entries) {
        if (out.length >= MAX_REPORT_FILES)
            return;
        if (e.name === 'node_modules' || e.name === '.git')
            continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory())
            await listFiles(p, depth + 1, out);
        else if (e.isFile())
            out.push(p);
    }
}
/** A file's text when it is a regular file of at most `max` bytes (size checked on the open descriptor). */
async function readSmall(file, max) {
    let handle;
    try {
        handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await handle.stat();
        if (!info.isFile() || info.size > max)
            return null;
        return await handle.readFile('utf8');
    }
    catch {
        return null;
    }
    finally {
        await handle?.close();
    }
}
function insideRoot(root, abs) {
    const rel = path.relative(root, abs);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
/** A spec path from a report, as a path relative to the project. */
export function specPath(root, file) {
    const f = file.replace(/\\/g, '/');
    if (path.isAbsolute(f) || /^[A-Za-z]:\//.test(f)) {
        const abs = path.resolve(f);
        if (insideRoot(root, abs))
            return path.relative(root, abs).replace(/\\/g, '/');
        // A path from the CI machine: keep the part from cypress/ (or the last parts) on.
        const at = f.lastIndexOf('/cypress/');
        return at >= 0 ? f.slice(at + 1) : f.split('/').slice(-3).join('/');
    }
    return path.posix.normalize(f.replace(/^\.\//, ''));
}
const loose = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
/** Cypress's failure screenshot for a test: "<describe> -- <it> (failed).png" under a screenshots folder. */
export function matchScreenshot(pngs, test) {
    const want = loose(test.title);
    if (!want)
        return undefined;
    const spec = path.posix.basename(test.file);
    const named = pngs.filter((p) => {
        const name = path.basename(p);
        const at = name.indexOf('(failed)');
        if (at < 0 || !name.endsWith('.png'))
            return false;
        return loose(name.slice(0, at).split(' -- ').join(' ')) === want;
    });
    return named.find((p) => p.includes(spec)) ?? named[0];
}
function ok(text, data) {
    return { ok: true, isError: false, text, data: { ok: true, ...data } };
}
function notOk(text, kind = 'UNSUPPORTED') {
    return { ok: false, isError: true, text, data: { ok: false, error: { kind, message: text } } };
}
function grepFor(grep) {
    if (typeof grep !== 'string' || !grep)
        return () => true;
    try {
        const re = new RegExp(grep);
        return (title) => re.test(title);
    }
    catch {
        return (title) => title.includes(grep);
    }
}
export function runnerScript() {
    return fileURLToPath(new URL('../scripts/cypress-run.mjs', import.meta.url));
}
export class CypressTools {
    root;
    options;
    failures = [];
    engine = null;
    env;
    constructor(root, options = {}) {
        this.root = root;
        this.options = options;
        this.env = options.env ?? process.env;
    }
    async call(name, args, timeoutMs = 600_000) {
        try {
            switch (name) {
                case 'load-report':
                    return await this.loadReport(String(args.report ?? ''));
                case 'get-failure':
                    return this.getFailure(Number(args.index));
                case 'suggest-fix':
                    return ok('No rule-based fix for Cypress: the AI proposes one.', {});
                case 'run-test':
                    return await this.runTest(args, timeoutMs);
                case 'diagnose-flaky':
                    return await this.diagnoseFlaky(args, timeoutMs);
                case 'check-test-change':
                    return await this.checkChange(args);
                case 'inspect-page':
                    return await this.inspect(args, timeoutMs);
                case 'quarantine':
                    return notOk('Quarantine writes playwright-quarantine.json, which Cypress does not read. The flaky test is reported, not quarantined.');
                case 'validate-selector':
                    return notOk('validate_selector checks Playwright locators. For Cypress, read the app source or use inspect_page, then propose the cy.get / cy.contains selector.');
                default:
                    return notOk(`${name} is not available for Cypress projects.`);
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return notOk(`Tool ${name} failed: ${message}`, 'CALL_FAILED');
        }
    }
    async close() {
        await this.engine?.close();
        this.engine = null;
    }
    async loadReport(report) {
        if (!report)
            return notOk('No report given.', 'BAD_INPUT');
        if (/^https?:\/\//.test(report))
            return notOk('Download the Cypress report first (actions/download-artifact), then pass its folder.', 'BAD_INPUT');
        const abs = path.resolve(this.root, report);
        let files = [];
        const st = await stat(abs).catch(() => null);
        if (!st)
            return notOk(`Report not found: ${report}`, 'NOT_FOUND');
        if (st.isDirectory())
            await listFiles(abs, 0, files);
        else
            files = [abs];
        const tests = [];
        let read = 0;
        for (const file of files) {
            if (!/\.(?:xml|json)$/i.test(file))
                continue;
            const text = await readSmall(file, MAX_REPORT_BYTES);
            if (text === null)
                continue;
            const parsed = parseCypressReport(text);
            if (!parsed)
                continue;
            read++;
            tests.push(...parsed);
        }
        if (!read)
            return notOk(`No Cypress results (JUnit XML, mochawesome JSON or cypress.run() JSON) found in ${report}.`, 'NOT_FOUND');
        const pngs = [...files.filter((f) => f.endsWith('.png'))];
        const shotsDir = path.join(this.root, 'cypress', 'screenshots');
        if (!st.isDirectory() || !abs.startsWith(shotsDir)) {
            const more = [];
            await listFiles(shotsDir, 0, more);
            pngs.push(...more.filter((f) => f.endsWith('.png')));
        }
        const seen = new Set();
        this.failures = [];
        for (const t of tests) {
            if (t.state !== 'failed')
                continue;
            const test = { ...t, file: specPath(this.root, t.file) };
            const key = `${test.file}\n${test.title}`;
            if (seen.has(key))
                continue; // retries list a test more than once
            seen.add(key);
            if (!test.screenshot) {
                const shot = matchScreenshot(pngs, test);
                if (shot)
                    test.screenshot = shot;
            }
            if (test.screenshot) {
                const shotAbs = path.resolve(this.root, test.screenshot);
                if (insideRoot(this.root, shotAbs))
                    test.screenshot = path.relative(this.root, shotAbs).replace(/\\/g, '/');
                else
                    delete test.screenshot;
            }
            this.failures.push(toFailure(test));
        }
        const passed = tests.filter((t) => t.state === 'passed').length;
        return ok(`Loaded a Cypress run: ${tests.length} tests, ${this.failures.length} failed, ${passed} passed.`, { framework: 'cypress', total: this.failures.length });
    }
    getFailure(index) {
        const f = this.failures[index - 1];
        if (!f)
            return notOk(`No failure ${index}.`, 'NOT_FOUND');
        const failure = { file: f.file, title: f.title, kind: f.kind, message: f.message };
        for (const k of ['line', 'expected', 'actual', 'screenshotPath'])
            if (f[k] !== undefined)
                failure[k] = f[k];
        return ok(failureMarkdown(f), { failure, total: this.failures.length });
    }
    /** Runs specs through the runner script (as the sandbox user when there is one). */
    async runSpecs(specs, timeoutMs) {
        const safe = specs.map((s) => s.replace(/:\d+$/, '')).filter((s) => insideRoot(this.root, path.resolve(this.root, s)));
        if (!safe.length)
            return { tests: [], error: 'no spec inside the project' };
        const dir = await mkdtemp(path.join(os.tmpdir(), 'autoheal-cy-'));
        // The sandbox user writes the results here; it may create files but not list the folder.
        await chmod(dir, 0o733);
        const out = path.join(dir, 'results.json');
        try {
            const env = engineEnv(this.env, false);
            env.CI = env.CI ?? '1';
            let command = process.execPath;
            let args = [this.options.runner ?? runnerScript(), out, ...safe];
            if (this.options.sandbox) {
                // The setup step copied the Cypress binary into the sandbox user's home.
                delete env.CYPRESS_CACHE_FOLDER;
                ({ command, args } = wrapCommand(this.options.sandbox, command, args, env));
            }
            const result = await new Promise((resolve) => {
                const child = spawn(command, args, { cwd: this.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
                let tail = '';
                const keep = (b) => {
                    tail = (tail + b.toString('utf8')).slice(-4000);
                };
                child.stdout.on('data', keep);
                child.stderr.on('data', keep);
                const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
                child.on('close', (code) => {
                    clearTimeout(timer);
                    resolve({ code, tail });
                });
                child.on('error', (e) => {
                    clearTimeout(timer);
                    resolve({ code: -1, tail: e.message });
                });
            });
            const text = await readFile(out, 'utf8').catch(() => '');
            const parsed = text ? parseCypressReport(text) : null;
            if (!parsed)
                return { tests: [], error: `Cypress produced no results (exit ${result.code}): ${result.tail.trim().split('\n').slice(-8).join(' | ')}` };
            const failedRun = JSON.parse(text).failed;
            return { tests: parsed.map((t) => ({ ...t, file: specPath(this.root, t.file) })), ...(failedRun ? { error: failedRun } : {}) };
        }
        finally {
            await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
    }
    async runTest(args, timeoutMs) {
        const files = Array.isArray(args.testFiles) ? args.testFiles.map(String) : [];
        const wanted = grepFor(args.grep);
        const limit = typeof args.timeoutMs === 'number' ? args.timeoutMs : timeoutMs;
        const run = await this.runSpecs(files, limit);
        const tests = run.tests.filter((t) => wanted(t.title));
        const failed = tests.filter((t) => t.state === 'failed');
        const passed = tests.filter((t) => t.state === 'passed').length;
        const lines = [
            `Cypress: ${passed} passed, ${failed.length} failed${run.error ? ` (${run.error.slice(0, 300)})` : ''}`,
            ...failed.slice(0, 10).map((t) => `✘ ${t.file} › ${t.title}\n  ${(t.message ?? '').split('\n').slice(0, 4).join('\n  ')}`),
        ];
        const data = { run: { passed, failed: failed.length, flaky: 0, failures: failed.map((t) => ({ title: t.title, file: t.file, message: t.message ?? '' })) } };
        if (!run.tests.length)
            return { ...notOk(lines.join('\n'), 'RUN_FAILED'), data: { ok: false, error: { kind: 'RUN_FAILED', message: run.error ?? 'no tests ran' }, ...data } };
        return { ok: failed.length === 0, isError: false, text: lines.join('\n'), data: { ok: failed.length === 0, ...data } };
    }
    async diagnoseFlaky(args, timeoutMs) {
        const target = Array.isArray(args.testFiles) ? String(args.testFiles[0] ?? '') : '';
        const m = /^(.*?)(?::(\d+))?$/.exec(target);
        const file = m?.[1] ?? target;
        const line = m?.[2] ? Number(m[2]) : undefined;
        const known = this.failures.filter((f) => f.file === file);
        const which = known.find((f) => line !== undefined && f.line === line) ?? (known.length === 1 ? known[0] : undefined);
        const titles = which ? [which.title] : known.map((f) => f.title);
        if (!titles.length)
            return notOk(`No failure from the report in ${file}.`, 'NOT_FOUND');
        const runs = Math.max(2, Math.min(5, Number(args.runs) || 3));
        let pass = 0;
        let fail = 0;
        for (let i = 0; i < runs; i++) {
            const run = await this.runSpecs([file], timeoutMs);
            const mine = run.tests.filter((t) => titles.includes(t.title));
            if (!mine.length)
                continue;
            if (mine.some((t) => t.state === 'failed'))
                fail++;
            else
                pass++;
        }
        if (pass + fail === 0)
            return notOk(`The test did not run in ${runs} reruns.`, 'RUN_FAILED');
        const verdict = fail === 0 ? 'NOT REPRODUCING' : pass === 0 ? 'CONSISTENT FAILURE' : 'FLAKY';
        return ok(`${verdict}: passed ${pass} of ${pass + fail} reruns.`, { verdict, passed: pass, failed: fail });
    }
    /** Per-file checks are the strict local scan's job; the whole-tree check compares each file with git HEAD. */
    async checkChange(args) {
        if (typeof args.base !== 'string' || !Array.isArray(args.files)) {
            return notOk('The engine heal guard reads Playwright specs; Cypress changes are checked by the strict local scan.');
        }
        const findings = [];
        let status = 'PASS';
        for (const rel of args.files.map(String)) {
            const abs = path.resolve(this.root, rel);
            if (!insideRoot(this.root, abs))
                continue;
            const after = await readFile(abs, 'utf8').catch(() => null);
            if (after === null)
                continue;
            let before = '';
            try {
                before = (await execFileP('git', ['show', `HEAD:${rel.replace(/\\/g, '/')}`], { cwd: this.root, maxBuffer: 20 * 1024 * 1024 })).stdout;
            }
            catch {
                continue; // a new file: nothing to compare
            }
            const report = scanChange(before, after, rel);
            for (const f of report.findings)
                findings.push({ severity: f.severity, rule: f.rule, message: `${rel}: ${f.message}` });
            if (report.verdict === 'BLOCK')
                status = 'BLOCK';
            else if (report.verdict === 'WARN' && status === 'PASS')
                status = 'WARN';
        }
        return ok(`Heal guard (Cypress, against HEAD): ${status}`, { status, findings });
    }
    async inspect(args, timeoutMs) {
        if (!this.engine)
            this.engine = await McpTools.start(this.root, { sandbox: this.options.sandbox ?? null, ...(this.options.env ? { env: this.options.env } : {}) });
        const res = await this.engine.call('inspect-page', args, timeoutMs);
        if (!res.ok)
            return res;
        return {
            ...res,
            text: `${res.text}\n\nThis is a Cypress project: the locators above are Playwright's. Write the Cypress equivalent, for example cy.get('[data-cy="save"]'), cy.get('#email') or cy.contains('button', 'Save').`,
        };
    }
}
//# sourceMappingURL=cypress.js.map