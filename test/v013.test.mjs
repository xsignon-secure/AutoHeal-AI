import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePrice, lookupOpenRouterPrice } from '../dist/budget.js';
import { VERSION } from '../dist/version.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const models = { data: [{ id: 'anthropic/claude-sonnet-5.5', pricing: { prompt: '0.000002', completion: '0.00001' } }] };
const fetchOk = async (url) => {
  assert.equal(String(url), 'https://openrouter.ai/api/v1/models');
  return { ok: true, json: async () => models };
};

test('OpenRouter prices are looked up, so the dollar limit works without hand-set prices', async () => {
  assert.deepEqual(await lookupOpenRouterPrice('anthropic/claude-sonnet-5.5', 'https://openrouter.ai/api/v1', fetchOk), [2, 10]);
  assert.equal(await lookupOpenRouterPrice('nope/model', 'https://openrouter.ai/api/v1', fetchOk), null);
  assert.equal(await lookupOpenRouterPrice('m', 'http://localhost:11434/v1', async () => { throw new Error('must not fetch'); }), null);
  assert.equal(await lookupOpenRouterPrice('m', 'https://openrouter.ai/api/v1', async () => { throw new Error('offline'); }), null);

  const env = { AUTOHEAL_BASE_URL: 'https://openrouter.ai/api/v1' };
  const lines = [];
  assert.deepEqual(await ensurePrice('anthropic/claude-sonnet-5.5', env, (l) => lines.push(l), fetchOk), [2, 10]);
  assert.equal(env.AUTOHEAL_PRICE_IN, '2');
  assert.equal(env.AUTOHEAL_PRICE_OUT, '10');
  assert.match(lines[0], /OpenRouter price/);
  // A known or hand-set price wins and nothing is fetched.
  assert.deepEqual(await ensurePrice('claude-opus-5-5', {}, undefined, async () => { throw new Error('must not fetch'); }), [4, 20]);
  assert.deepEqual(await ensurePrice('x', { AUTOHEAL_PRICE_IN: '1', AUTOHEAL_PRICE_OUT: '2' }, undefined, async () => { throw new Error('must not fetch'); }), [1, 2]);
});

test('every template and the README pin this version of AutoHeal', () => {
  const files = [...readdirSync(path.join(root, 'templates')).map((f) => `templates/${f}`), 'README.md', 'examples/demo/.github/workflows/autoheal.yml'];
  for (const file of files) {
    const text = readFileSync(path.join(root, file), 'utf8');
    for (const m of text.matchAll(/(?:AutoHeal-AI(?:\/[a-z]+)?@v|xsignon-autoheal@|AUTOHEAL_VERSION: ")(\d+\.\d+\.\d+)/g)) {
      assert.equal(m[1], VERSION, `${file} pins ${m[0]}`);
    }
  }
});

test('the heal action takes an api-key for OpenRouter and other OpenAI-compatible endpoints', () => {
  const action = readFileSync(path.join(root, 'action.yml'), 'utf8');
  assert.match(action, /\n  api-key:\n/);
  assert.match(action, /AUTOHEAL_API_KEY: \$\{\{ inputs\.api-key \}\}/);
});
