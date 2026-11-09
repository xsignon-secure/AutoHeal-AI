/**
 * Running your tests the way AutoHeal needs them, for `autoheal fix` (on your
 * machine) and `autoheal learn` (fingerprints from a green run): the right
 * reporter, traces on, results in one folder inside the project.
 */
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadCypressDoms } from './cypress-dom.js';
import { domFromZip, fingerprintPath, learn } from './fingerprints.js';
import { readTrace } from './runtime.js';
function python() {
    for (const p of ['python3', 'python']) {
        if (spawnSync(p, ['--version'], { stdio: 'ignore' }).status === 0)
            return p;
    }
    return 'python3';
}
/** The command that runs the tests into `dir` (relative to the project). */
export function testRun(framework, purpose, dir) {
    if (framework === 'webdriverio') {
        // @wdio/junit-reporter writes the XML AutoHeal reads (add it to the project's reporters).
        return { command: 'npx', args: ['wdio', 'run', process.env.AUTOHEAL_WDIO_CONFIG ?? 'wdio.conf.ts'], env: { AUTOHEAL_REPORT_DIR: dir } };
    }
    if (framework === 'cypress') {
        const args = ['cypress', 'run'];
        if (purpose === 'fix')
            args.push('--reporter', 'junit', '--reporter-options', `mochaFile=${dir}/results-[hash].xml`);
        return { command: 'npx', args, env: { AUTOHEAL_DOM_DIR: path.join(dir, 'autoheal') } };
    }
    if (framework === 'pytest') {
        const args = ['-m', 'pytest', `--tracing=${purpose === 'fix' ? 'retain-on-failure' : 'on'}`, '--output', `${dir}/test-results`];
        if (purpose === 'fix')
            args.push(`--junitxml=${dir}/junit.xml`);
        return { command: python(), args, env: {} };
    }
    if (purpose === 'fix') {
        return {
            command: 'npx',
            args: ['playwright', 'test', '--reporter=json', '--trace=retain-on-failure', '--output', `${dir}/test-results`],
            env: { PLAYWRIGHT_JSON_OUTPUT_NAME: `${dir}/results.json` },
        };
    }
    return { command: 'npx', args: ['playwright', 'test', '--reporter=line', '--trace=on', '--output', `${dir}/test-results`], env: {} };
}
/** Runs the tests in the project; returns the exit code. */
export function runTests(root, run, extra = []) {
    const res = spawnSync(run.command, [...run.args, ...extra], { cwd: root, stdio: 'inherit', env: { ...process.env, ...run.env } });
    if (res.error)
        throw res.error;
    return res.status ?? 1;
}
/** Fingerprints from every trace.zip under `dir` (a run with traces on). */
export async function fingerprintsFromTraces(dir) {
    const entries = new Map();
    let traces = 0;
    const walk = async (d, depth) => {
        if (depth > 6)
            return;
        for (const name of (await readdir(d).catch(() => [])).slice(0, 5000)) {
            const p = path.join(d, name);
            const st = await lstat(p).catch(() => null);
            if (!st || st.isSymbolicLink() || name === 'node_modules')
                continue;
            if (st.isDirectory())
                await walk(p, depth + 1);
            else if (name.endsWith('.zip') && traces < 2000) {
                const buf = await readTrace(p);
                if (!buf)
                    continue;
                try {
                    for (const e of learn(domFromZip(buf)))
                        entries.set(`${e.selector}\n${e.page ?? ''}`, e);
                    traces++;
                }
                catch {
                    // not a trace
                }
            }
        }
    };
    await walk(dir, 0);
    return { entries: [...entries.values()], traces };
}
/** Fingerprints from what the Cypress plugin saved under `dir`. */
export async function fingerprintsFromCypress(root, dir) {
    const doms = await loadCypressDoms(root, [dir]);
    const entries = new Map();
    for (const d of doms)
        for (const e of learn(d.dom, d.spec))
            entries.set(`${e.selector}\n${e.page ?? ''}`, e);
    return { entries: [...entries.values()], tests: doms.length };
}
/** Writes entries as <id>.json files into a flat folder (the learned folder). */
export async function writeLearned(dir, entries) {
    await mkdir(dir, { recursive: true });
    for (const e of entries)
        await writeFile(path.join(dir, path.posix.basename(fingerprintPath(e.selector, e.page))), `${JSON.stringify(e, null, 2)}\n`);
    return entries.length;
}
//# sourceMappingURL=local.js.map