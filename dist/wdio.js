/**
 * WebdriverIO support (Mocha or Jasmine specs). The same tool interface as
 * the Cypress adapter, backed by WebdriverIO:
 *
 *   load-report   JUnit XML from @wdio/junit-reporter, or JSON from
 *                 wdio-json-reporter, in the folder you pass
 *   run-test      runs specs through WebdriverIO's Launcher (scripts/wdio-run.mjs),
 *                 as the sandbox user, one test at a time with mochaOpts.grep
 *
 * Healing is by AI (there are no Playwright traces, so no fingerprints and no
 * runtime guard), proven by reruns and the anti-cheat scan, which knows
 * WebdriverIO's ways to fake a pass (browser.execute, browser.mock, pause).
 * Selenium (Java, Python) and Appium are not supported yet.
 */
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CypressTools, cypressValues, parseJunit, specPath } from './cypress.js';
import { engineEnv } from './mcp.js';
import { wrapCommand } from './sandbox.js';
const PLAYWRIGHT_CONFIGS = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs', 'playwright.config.mts'];
export const WDIO_CONFIGS = ['wdio.conf.ts', 'wdio.conf.js', 'wdio.conf.mjs', 'wdio.conf.cjs', 'wdio.conf.mts', 'test/wdio.conf.ts', 'test/wdio.conf.js'];
const MAX_REPORT_BYTES = 20 * 1024 * 1024;
async function exists(file) {
    return stat(file).then(() => true, () => false);
}
/** A WebdriverIO project: a wdio config and no Playwright config. */
export async function isWdioProject(root) {
    for (const name of PLAYWRIGHT_CONFIGS)
        if (await exists(path.join(root, name)))
            return false;
    return (await wdioConfig(root)) !== null;
}
export async function wdioConfig(root) {
    for (const name of WDIO_CONFIGS)
        if (await exists(path.join(root, name)))
            return name;
    return null;
}
/** @wdio/junit-reporter: each testsuite names its spec in a `file` property. */
export function parseWdioJunit(xml) {
    const out = [];
    const parts = xml.split(/(?=<testsuite[\s>])/);
    for (const part of parts) {
        if (!part.startsWith('<testsuite'))
            continue;
        const file = /<property\s+name="file"\s+value="([^"]*)"/.exec(part)?.[1] ?? /<testsuite\b[^>]*\bfile="([^"]*)"/.exec(part)?.[1] ?? '';
        const suite = /<testsuite\b[^>]*\bname="([^"]*)"/.exec(part)?.[1] ?? '';
        for (const t of parseJunit(part)) {
            const title = suite && !t.title.startsWith(suite) ? `${suite} ${t.title}` : t.title;
            out.push({ ...t, file: t.file || file, title: decode(title) });
        }
    }
    return out;
}
function decode(s) {
    return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
/** wdio-json-reporter output (one file per worker). */
export function parseWdioJson(report) {
    const file = report.specs?.[0] ?? '';
    const out = [];
    for (const suite of report.suites ?? []) {
        for (const t of suite.tests ?? []) {
            const title = t.fullTitle ?? [suite.name, t.name].filter(Boolean).join(' ');
            const state = t.state === 'failed' ? 'failed' : t.state === 'passed' ? 'passed' : 'skipped';
            const test = { file: file.replace(/^file:\/\//, ''), title, state };
            if (state === 'failed') {
                test.message = String(t.error ?? 'failed').split('\n')[0] ?? 'failed';
                test.stack = String(t.standardError ?? t.error ?? '');
            }
            out.push(test);
        }
    }
    return out;
}
export function parseWdioReport(text) {
    const t = text.trimStart();
    if (t.startsWith('<'))
        return /<testsuite[\s>]/.test(t) ? parseWdioJunit(t) : null;
    try {
        const data = JSON.parse(t);
        return Array.isArray(data.suites) ? parseWdioJson(data) : null;
    }
    catch {
        return null;
    }
}
/** The failure kind from a WebdriverIO error. */
export function wdioKind(message) {
    const m = message.slice(0, 5000);
    if (/SyntaxError|Unexpected token|Cannot find module|ERR_MODULE_NOT_FOUND/i.test(m))
        return 'syntax';
    if (/ECONNREFUSED|ERR_CONNECTION_REFUSED|net::ERR_|Failed to create session|session not created/i.test(m))
        return 'server-unreachable';
    if (/chrome not reachable|disconnected: not connected to DevTools|browser crashed|tab crashed/i.test(m))
        return 'browser-crash';
    if (/element \(".*"\) still not (?:displayed|existing|clickable|enabled)|wasn't found|can't call \w+ on element with selector|no such element|element not interactable/i.test(m))
        return 'timeout';
    if (/(?:^[ \t]*Expected[\s\S]{0,400}Received)|(?:Expect \$)|(?:AssertionError)|(?:expected .{0,200} to )/im.test(m))
        return 'assertion';
    if (/timed? ?out|timeout of \d+ms exceeded/i.test(m))
        return 'timeout';
    return 'unknown';
}
export function wdioFailure(test) {
    const message = test.message ?? 'failed';
    const stack = test.stack ?? '';
    const f = { file: test.file, title: test.title, kind: wdioKind(`${message}\n${stack}`), message: `${message}${stack && !stack.startsWith(message) ? `\n${stack.split('\n').slice(0, 12).join('\n')}` : ''}`, stack };
    const base = path.posix.basename(test.file.replace(/\\/g, '/'));
    const line = base ? new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`).exec(stack)?.[1] : undefined;
    if (line)
        f.line = Number(line);
    const values = cypressValues(message);
    const exp = /^[ \t]*Expected:?[ \t]*(\S.*)$/m.exec(f.message)?.[1];
    const rec = /^[ \t]*Received:?[ \t]*(\S.*)$/m.exec(f.message)?.[1];
    if (f.kind === 'assertion') {
        if (exp !== undefined && rec !== undefined) {
            f.expected = exp.trim();
            f.actual = rec.trim();
        }
        else if (values.expected !== undefined && values.actual !== undefined) {
            f.expected = values.expected;
            f.actual = values.actual;
        }
    }
    if (test.screenshot)
        f.screenshotPath = test.screenshot;
    return f;
}
export function wdioRunnerScript() {
    return fileURLToPath(new URL('../scripts/wdio-run.mjs', import.meta.url));
}
const okResult = (text, data) => ({ ok: true, isError: false, text, data: { ok: true, ...data } });
const notOkResult = (text, kind) => ({ ok: false, isError: true, text, data: { ok: false, error: { kind, message: text } } });
export class WdioTools extends CypressTools {
    label = 'WebdriverIO';
    validateNote() {
        return 'validate_selector checks Playwright locators. For WebdriverIO, read the app source or use inspect_page, then propose the $(...) selector.';
    }
    inspectNote() {
        return "This is a WebdriverIO project: the locators above are Playwright's. Write the WebdriverIO equivalent, for example $('[data-testid=\"save\"]'), $('#email'), $('button=Save') or $('aria/Save').";
    }
    markdown(f) {
        const out = [`## ${f.file} › ${f.title}`, '', '### Error', '```', f.message.slice(0, 4000), '```'];
        if (f.expected !== undefined)
            out.push('', `Expected: ${f.expected}`, `Received: ${f.actual ?? ''}`);
        if (f.screenshotPath)
            out.push('', `Screenshot: ${f.screenshotPath}`);
        out.push('', 'Framework: WebdriverIO (no Playwright trace: fix the selector from the error, the spec, its page objects and the app source).');
        return out.join('\n');
    }
    async loadReport(report) {
        if (!report)
            return notOkResult('No report given.', 'BAD_INPUT');
        if (/^https?:\/\//.test(report))
            return notOkResult('Download the WebdriverIO report first (actions/download-artifact), then pass its folder.', 'BAD_INPUT');
        const abs = path.resolve(this.root, report);
        const st = await stat(abs).catch(() => null);
        if (!st)
            return notOkResult(`Report not found: ${report}`, 'NOT_FOUND');
        const files = [];
        const walk = async (d, depth) => {
            if (depth > 5 || files.length > 500)
                return;
            for (const name of await readdir(d).catch(() => [])) {
                if (name === 'node_modules' || name === '.git')
                    continue;
                const p = path.join(d, name);
                const s = await stat(p).catch(() => null);
                if (s?.isDirectory())
                    await walk(p, depth + 1);
                else if (s?.isFile() && /\.(?:xml|json)$/i.test(name) && s.size <= MAX_REPORT_BYTES)
                    files.push(p);
            }
        };
        if (st.isDirectory())
            await walk(abs, 0);
        else
            files.push(abs);
        const tests = [];
        let read = 0;
        for (const f of files) {
            const parsed = parseWdioReport(await readFile(f, 'utf8').catch(() => ''));
            if (!parsed)
                continue;
            read++;
            tests.push(...parsed);
        }
        if (!read)
            return notOkResult(`No WebdriverIO results (@wdio/junit-reporter XML or wdio-json-reporter JSON) found in ${report}.`, 'NOT_FOUND');
        const seen = new Set();
        this.failures = [];
        for (const t of tests) {
            if (t.state !== 'failed')
                continue;
            const test = { ...t, file: specPath(this.root, t.file) };
            const key = `${test.file}\n${test.title}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            this.failures.push(wdioFailure(test));
        }
        return okResult(`Loaded a WebdriverIO run: ${tests.length} tests, ${this.failures.length} failed.`, { framework: 'webdriverio', total: this.failures.length });
    }
    /** Runs specs through WebdriverIO's Launcher, as the sandbox user when there is one. */
    async runSpecs(specs, timeoutMs, grep) {
        const root = this.root;
        const safe = specs.map((s) => s.replace(/:\d+$/, '')).filter((s) => {
            const abs = path.resolve(root, s);
            return abs === root || abs.startsWith(root + path.sep);
        });
        if (!safe.length)
            return { tests: [], error: 'no spec inside the project' };
        const config = await wdioConfig(root);
        if (!config)
            return { tests: [], error: 'no wdio.conf found' };
        const dir = await mkdtemp(path.join(os.tmpdir(), 'autoheal-wdio-'));
        await chmod(dir, 0o733);
        try {
            const env = engineEnv(this.env, false);
            env.CI = env.CI ?? '1';
            let command = process.execPath;
            let args = [this.options.runner ?? wdioRunnerScript(), dir, config, grep ?? '', ...safe];
            if (this.options.sandbox)
                ({ command, args } = wrapCommand(this.options.sandbox, command, args, env));
            const tail = await new Promise((resolve) => {
                const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
                let out = '';
                const keep = (b) => {
                    out = (out + b.toString('utf8')).slice(-4000);
                };
                child.stdout.on('data', keep);
                child.stderr.on('data', keep);
                const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
                child.on('close', () => {
                    clearTimeout(timer);
                    resolve(out);
                });
                child.on('error', (e) => {
                    clearTimeout(timer);
                    resolve(e.message);
                });
            });
            const tests = [];
            for (const name of await readdir(dir).catch(() => [])) {
                if (!/\.(?:xml|json)$/.test(name) || name === 'exit.json')
                    continue;
                const parsed = parseWdioReport(await readFile(path.join(dir, name), 'utf8').catch(() => ''));
                if (parsed)
                    tests.push(...parsed.map((t) => ({ ...t, file: specPath(root, t.file || safe[0]) })));
            }
            if (!tests.length)
                return { tests: [], error: `WebdriverIO produced no results: ${tail.trim().split('\n').slice(-8).join(' | ')}` };
            return { tests };
        }
        finally {
            await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
    }
    async call(name, args, timeoutMs = 600_000) {
        // Pass grep down to WebdriverIO (mochaOpts.grep), so one test runs, not the whole spec.
        if (name === 'run-test' && typeof args.grep === 'string' && args.grep) {
            const files = Array.isArray(args.testFiles) ? args.testFiles.map(String) : [];
            const limit = typeof args.timeoutMs === 'number' ? args.timeoutMs : timeoutMs;
            const run = await this.runSpecs(files, limit, args.grep);
            let re = null;
            try {
                re = new RegExp(args.grep);
            }
            catch {
                re = null;
            }
            const tests = run.tests.filter((t) => (re ? re.test(t.title) : t.title.includes(String(args.grep))));
            const failed = tests.filter((t) => t.state === 'failed');
            const passed = tests.filter((t) => t.state === 'passed').length;
            const text = [`WebdriverIO: ${passed} passed, ${failed.length} failed${run.error ? ` (${run.error.slice(0, 300)})` : ''}`, ...failed.slice(0, 10).map((t) => `✘ ${t.file} › ${t.title}\n  ${(t.message ?? '').split('\n').slice(0, 4).join('\n  ')}`)].join('\n');
            const data = { run: { passed, failed: failed.length, flaky: 0, failures: failed.map((t) => ({ title: t.title, file: t.file, message: t.message ?? '' })) } };
            if (!tests.length)
                return { ok: false, isError: true, text, data: { ok: false, error: { kind: 'RUN_FAILED', message: run.error ?? 'no tests ran' }, ...data } };
            return { ok: failed.length === 0 && passed > 0, isError: false, text, data: { ok: failed.length === 0, ...data } };
        }
        return super.call(name, args, timeoutMs);
    }
}
//# sourceMappingURL=wdio.js.map