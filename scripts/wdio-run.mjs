#!/usr/bin/env node
/**
 * Runs WebdriverIO specs for AutoHeal through WebdriverIO's Launcher and
 * leaves JUnit XML in <out-dir>. AutoHeal starts this as the sandbox user, in
 * the project folder, with the AI key and runner tokens removed.
 *
 *   node wdio-run.mjs <out-dir> <wdio.conf> <grep or ""> <spec> [spec...]
 *
 * WebdriverIO and @wdio/junit-reporter are loaded from the project's own
 * node_modules. Spec retries are off: AutoHeal decides how often a test runs.
 */

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [out, config, grep, ...specs] = process.argv.slice(2);
if (!out || !config || !specs.length) {
  console.error('usage: wdio-run.mjs <out-dir> <wdio.conf> <grep or ""> <spec> [spec...]');
  process.exit(2);
}

const require = createRequire(path.join(process.cwd(), 'package.json'));
let Launcher;
try {
  ({ Launcher } = await import(pathToFileURL(require.resolve('@wdio/cli')).href));
} catch (error) {
  console.error(`WebdriverIO is not installed in this project (${error instanceof Error ? error.message : error}). Run npm ci before AutoHeal.`);
  process.exit(1);
}
try {
  require.resolve('@wdio/junit-reporter');
} catch {
  console.error('AutoHeal reads WebdriverIO results through @wdio/junit-reporter: add it to your devDependencies.');
  process.exit(1);
}

const launcher = new Launcher(path.resolve(config), {
  spec: specs.map((s) => path.resolve(s)),
  specFileRetries: 0,
  reporters: [['junit', { outputDir: out }]],
  ...(grep ? { mochaOpts: { grep }, jasmineOpts: { grep } } : {}),
});
const code = await launcher.run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  return 1;
});
writeFileSync(path.join(out, 'exit.json'), JSON.stringify({ code }));
process.exit(0);
