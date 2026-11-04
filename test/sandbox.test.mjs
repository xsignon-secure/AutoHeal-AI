// 0.5.0 sandbox: tests run as a separate user that cannot read the AI key.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseSandbox, engineEnv, sandboxMode, wrapCommand } from '../dist/index.js';

const ok = () => Buffer.alloc(0);
const fail = () => {
  throw new Error('sudo: a password is required');
};
const prepared = { AUTOHEAL_SANDBOX_USER: 'autoheal-sb', AUTOHEAL_SANDBOX_HOME: '/home/autoheal-sb' };
const linux = process.platform === 'linux';

test('sandbox modes', () => {
  assert.equal(sandboxMode(undefined), 'auto');
  assert.equal(sandboxMode(''), 'auto');
  assert.equal(sandboxMode('USER'), 'user');
  assert.equal(sandboxMode('off'), 'off');
  assert.throws(() => sandboxMode('maybe'), /auto, user or off/);
});

test('off is off, and the PR says the tests could read the key', () => {
  const c = chooseSandbox('off', prepared, ok);
  assert.equal(c.sandbox, null);
  assert.match(c.note, /can read the AI key/);
});

test('auto uses the prepared user and falls back, saying why', { skip: !linux }, () => {
  assert.deepEqual(chooseSandbox('auto', prepared, ok).sandbox, { user: 'autoheal-sb', home: '/home/autoheal-sb' });
  assert.match(chooseSandbox('auto', prepared, ok).note, /cannot read the AI key/);
  assert.match(chooseSandbox('auto', {}, ok).note, /^off \(the sandbox user was not prepared/);
  assert.match(chooseSandbox('auto', prepared, fail).note, /^off \(cannot start processes as autoheal-sb/);
  assert.match(chooseSandbox('auto', { AUTOHEAL_SANDBOX_USER: 'root; rm -rf /', AUTOHEAL_SANDBOX_HOME: '/x' }, ok).note, /invalid/);
});

test('user fails closed when the sandbox cannot be used', { skip: !linux }, () => {
  assert.throws(() => chooseSandbox('user', {}, ok), /sandbox: user was requested/);
  assert.throws(() => chooseSandbox('user', prepared, fail), /cannot start processes/);
});

test('the engine starts as the sandbox user with only the filtered environment', () => {
  const env = engineEnv({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-x', GITHUB_TOKEN: 'ghs_x', HOME: '/home/runner', CI: '1' }, false);
  const { command, args } = wrapCommand({ user: 'autoheal-sb', home: '/home/autoheal-sb' }, '/usr/bin/node', ['/engine.js'], env);
  assert.equal(command, 'sudo');
  assert.deepEqual(args.slice(0, 6), ['-n', '-u', 'autoheal-sb', '--', '/usr/bin/env', '-i']);
  assert.deepEqual(args.slice(-2), ['/usr/bin/node', '/engine.js']);
  assert.ok(args.includes('HOME=/home/autoheal-sb') && !args.includes('HOME=/home/runner'));
  assert.ok(args.includes('PATH=/usr/bin') && args.includes('CI=1'));
  assert.ok(!args.some((a) => a.includes('sk-ant') || a.includes('ghs_')), 'no secret on the command line');
});
