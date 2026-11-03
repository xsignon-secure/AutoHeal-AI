import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { AnthropicProvider, ConfigError, OpenAIProvider, providerFromEnv, toWireMessages } from '../dist/index.js';

function mockServer(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      requests.push({ url: req.url, headers: req.headers, body });
      const [status, json] = handler(body, req, requests.length);
      res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_test' });
      res.end(JSON.stringify(json));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const tools = [{ name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];

test('providerFromEnv picks by key and validates settings', () => {
  assert.equal(providerFromEnv({}), null);
  assert.equal(providerFromEnv({ AUTOHEAL_PROVIDER: 'none', ANTHROPIC_API_KEY: 'k' }), null);
  const a = providerFromEnv({ ANTHROPIC_API_KEY: 'k' });
  assert.equal(a.name, 'anthropic');
  assert.equal(a.model, 'claude-opus-5-5');
  assert.throws(() => providerFromEnv({ OPENAI_API_KEY: 'k' }), ConfigError);
  assert.equal(providerFromEnv({ OPENAI_API_KEY: 'k', AUTOHEAL_MODEL: 'm' }).name, 'openai');
  assert.equal(providerFromEnv({ AUTOHEAL_BASE_URL: 'http://localhost:11434/v1', AUTOHEAL_MODEL: 'llama' }).name, 'openai-compatible');
  assert.throws(() => providerFromEnv({ ANTHROPIC_API_KEY: 'k', AUTOHEAL_EFFORT: 'huge' }), ConfigError);
  assert.throws(() => providerFromEnv({ AUTOHEAL_PROVIDER: 'other' }), ConfigError);
});

test('toWireMessages maps tool calls and results to the OpenAI format', () => {
  const wire = toWireMessages({
    system: 'sys',
    tools: [],
    maxTokens: 10,
    turns: [
      { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'reading' }, { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a' } }] },
      { role: 'user', parts: [{ type: 'tool_result', id: 'c1', content: 'data', isError: true }] },
    ],
  });
  assert.deepEqual(wire[0], { role: 'system', content: 'sys' });
  assert.equal(wire[2].tool_calls[0].function.arguments, '{"path":"a"}');
  assert.deepEqual(wire[3], { role: 'tool', tool_call_id: 'c1', content: 'ERROR: data' });
});

test('OpenAI-compatible provider: tool calls, usage, invalid JSON arguments, HTTP errors', async () => {
  const { server, requests, url } = await mockServer((body, req, n) => {
    if (n === 1) {
      return [200, {
        model: 'local-1',
        choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
          { id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"x.ts"}' } },
          { id: 't2', type: 'function', function: { name: 'read_file', arguments: '{bad' } },
        ] } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }];
    }
    return [500, { error: 'down' }];
  });
  try {
    const p = new OpenAIProvider({ model: 'local-1', baseURL: `${url}/v1`, timeoutMs: 5000 });
    const r = await p.chat({ system: 's', turns: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }], tools, maxTokens: 100 });
    assert.equal(r.stop, 'tool_calls');
    assert.deepEqual(r.usage, { inputTokens: 11, outputTokens: 7 });
    assert.deepEqual(r.parts[0], { type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'x.ts' } });
    assert.ok('__invalid_json' in r.parts[1].input);
    assert.equal(requests[0].url, '/v1/chat/completions');
    assert.equal(requests[0].body.max_tokens, 100);
    assert.equal(requests[0].body.tools[0].function.name, 'read_file');
    await assert.rejects(p.chat({ system: 's', turns: [], tools, maxTokens: 1 }), (e) => e.retryable === true && /HTTP 500/.test(e.message));
  } finally {
    server.close();
  }
});

const claudeMessage = (content, stop = 'tool_use') => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop, stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 30 },
});

test('Anthropic provider: effort, refusal fallback, tool use and raw replay', async () => {
  const { server, requests, url } = await mockServer(() => [200, claudeMessage([
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: 'Let me read it.' },
    { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.spec.ts' } },
  ])]);
  try {
    const p = new AnthropicProvider({ apiKey: 'test-key', model: 'claude-opus-5-5', effort: 'medium', baseURL: url, fallbacks: true });
    const r = await p.chat({ system: 'sys', turns: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }], tools, maxTokens: 16000 });
    assert.equal(r.stop, 'tool_calls');
    assert.deepEqual(r.usage, { inputTokens: 120, outputTokens: 30 });
    assert.deepEqual(r.parts.map((x) => x.type), ['text', 'tool_call']);
    assert.equal(r.raw.length, 3, 'thinking block kept for replay');
    const sent = requests[0];
    assert.ok(sent.headers['x-api-key'] === 'test-key' || sent.headers.authorization === 'Bearer test-key', 'API key sent');
    assert.match(String(sent.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
    assert.equal(sent.body.fallbacks, 'default');
    assert.deepEqual(sent.body.output_config, { effort: 'medium' });
    assert.equal(sent.body.tools[0].input_schema.type, 'object');
    assert.equal(sent.body.tool_choice, undefined, 'no forced tool choice');
    assert.equal(sent.body.thinking, undefined, 'thinking left adaptive');

    await p.chat({
      system: 'sys',
      tools,
      maxTokens: 100,
      turns: [
        { role: 'user', parts: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', parts: r.parts, raw: r.raw },
        { role: 'user', parts: [{ type: 'tool_result', id: 'tu_1', content: 'file', isError: false }] },
      ],
    });
    const second = requests[1].body.messages;
    assert.equal(second[1].content[0].type, 'thinking', 'assistant content replayed unchanged');
    assert.deepEqual(second[2].content[0], { type: 'tool_result', tool_use_id: 'tu_1', content: 'file' });
  } finally {
    server.close();
  }
});

test('Anthropic provider: drops the fallback parameter when the API rejects it, and maps auth errors', async () => {
  const { server, requests, url } = await mockServer((body) =>
    body.fallbacks
      ? [400, { type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks: not supported for this account' } }]
      : [200, claudeMessage([{ type: 'text', text: 'done' }], 'end_turn')],
  );
  try {
    const p = new AnthropicProvider({ apiKey: 'k', model: 'claude-opus-5-5', effort: 'low', baseURL: url, fallbacks: true });
    const r = await p.chat({ system: 's', turns: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }], tools: [], maxTokens: 10 });
    assert.equal(r.stop, 'end');
    assert.equal(requests.length, 2);
    await p.chat({ system: 's', turns: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }], tools: [], maxTokens: 10 });
    assert.equal(requests.length, 3, 'no second fallback attempt after the first rejection');
  } finally {
    server.close();
  }
  const auth = await mockServer(() => [401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }]);
  try {
    const p = new AnthropicProvider({ apiKey: 'bad', model: 'claude-haiku-5-5', effort: 'low', baseURL: auth.url, fallbacks: true });
    await assert.rejects(p.chat({ system: 's', turns: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }], tools: [], maxTokens: 10 }), /rejected the API key/);
    assert.equal(auth.requests[0].body.fallbacks, undefined, 'haiku gets no fallback parameter');
  } finally {
    auth.server.close();
  }
});
