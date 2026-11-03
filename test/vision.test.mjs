// 0.3.0 visual grounding: screenshots from the run's own artifacts.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { estimateTokens, failureScreenshot, frameFromTrace, imageTokens, jpegSize, openingParts, pngSize, readZip, visionEnabled } from '../dist/index.js';
import { toWireMessages } from '../dist/providers/openai.js';

/** A tiny PNG header (the size is all the code reads). */
function png(width, height, pad = 2000) {
  const b = Buffer.alloc(24 + pad);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** A minimal JPEG: SOI, then an SOF0 segment with the size. */
function jpeg(width, height, tag = 0) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(1500, tag), Buffer.from([0xff, 0xd9])]);
}

/** Builds a zip (deflated entries) the way Playwright writes trace.zip. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(content));
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Buffer.from(content).length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(Buffer.from(content).length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const traceLines = (events) => events.map((e) => JSON.stringify(e)).join('\n');

test('image sizes and token cost', () => {
  assert.deepEqual(pngSize(png(1280, 720)), { width: 1280, height: 720 });
  assert.deepEqual(jpegSize(jpeg(800, 600)), { width: 800, height: 600 });
  assert.equal(pngSize(Buffer.from('hello')), undefined);
  assert.equal(imageTokens(1280, 720), 1229);
  assert.equal(imageTokens(4000, 4000), 1600);
  assert.equal(imageTokens(), 1600);
});

test('readZip reads deflated entries and filters by name', () => {
  const entries = readZip(zip({ 'trace.trace': 'a', 'resources/x.jpeg': 'b', 'other.txt': 'c' }), (n) => n !== 'other.txt');
  assert.deepEqual([...entries.keys()], ['trace.trace', 'resources/x.jpeg']);
  assert.equal(entries.get('resources/x.jpeg').toString(), 'b');
  assert.equal(readZip(Buffer.from('not a zip')).size, 0);
});

test('the trace frame is the last one before the failing action ended', () => {
  const entries = readZip(
    zip({
      'trace.trace': traceLines([
        { type: 'screencast-frame', sha1: 'f1.jpeg', timestamp: 100 },
        { type: 'before', callId: 'c1', startTime: 150 },
        { type: 'screencast-frame', sha1: 'f2.jpeg', timestamp: 200 },
        { type: 'after', callId: 'c1', endTime: 300, error: { message: 'Timeout' } },
        { type: 'screencast-frame', sha1: 'f3.jpeg', timestamp: 900 }, // teardown, after the failure
      ]),
      'resources/f1.jpeg': jpeg(640, 480, 1),
      'resources/f2.jpeg': jpeg(1280, 720, 2),
      'resources/f3.jpeg': jpeg(320, 200, 3),
    }),
  );
  const shot = frameFromTrace(entries);
  assert.equal(shot.mediaType, 'image/jpeg');
  assert.equal(shot.width, 1280);
  assert.equal(shot.source, 'trace');
});

test('newer traces name the frame file directly (screencast/…)', () => {
  const entries = readZip(
    zip({
      '1-trace.trace': traceLines([{ type: 'screencast-frame', file: 'screencast/page@a-1.jpeg', width: 800, height: 600, timestamp: 10 }]),
      'test.trace': traceLines([{ type: 'after', callId: 'pw:api@1', endTime: 20, error: { message: 'Timeout' } }]),
      'screencast/page@a-1.jpeg': jpeg(800, 600),
    }),
  );
  assert.equal(frameFromTrace(entries)?.width, 800);
});

test('failureScreenshot prefers the test-failed png, falls back to the trace, stays inside the project', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'autoheal-vis-'));
  const dir = path.join(root, 'test-results', 'login-chromium');
  mkdirSync(dir, { recursive: true });
  const trace = zip({ 'trace.trace': traceLines([{ type: 'screencast-frame', sha1: 'f.jpeg', timestamp: 1 }]), 'resources/f.jpeg': jpeg(1024, 768) });
  writeFileSync(path.join(dir, 'trace.zip'), trace);
  const fromTrace = await failureScreenshot(root, 'test-results/login-chromium/trace.zip');
  assert.equal(fromTrace.source, 'trace');
  writeFileSync(path.join(dir, 'test-failed-1.png'), png(1280, 720));
  const fromPng = await failureScreenshot(root, path.join(dir, 'trace.zip'));
  assert.equal(fromPng.source, 'attachment');
  assert.equal(fromPng.mediaType, 'image/png');

  const outside = mkdtempSync(path.join(os.tmpdir(), 'autoheal-out-'));
  writeFileSync(path.join(outside, 'trace.zip'), trace);
  assert.equal(await failureScreenshot(root, path.join(outside, 'trace.zip')), null, 'a trace outside the project is ignored');
  assert.equal(await failureScreenshot(root, undefined), null);
  assert.equal(await failureScreenshot(root, 'missing/trace.zip'), null);
});

test('vision is on for Anthropic and OpenAI, off for other endpoints, and can be forced', () => {
  assert.equal(visionEnabled('anthropic', {}), true);
  assert.equal(visionEnabled('openai', {}), true);
  assert.equal(visionEnabled('openai-compatible', {}), false);
  assert.equal(visionEnabled('openai-compatible', { AUTOHEAL_VISION: 'true' }), true);
  assert.equal(visionEnabled('anthropic', { AUTOHEAL_VISION: 'false' }), false);
});

test('images are counted by size in the budget estimate, not by their base64 length', () => {
  const shot = { mediaType: 'image/png', data: 'A'.repeat(3_000_000), width: 1280, height: 720, source: 'attachment' };
  const turns = [{ role: 'user', parts: openingParts('hello', shot) }];
  const tokens = estimateTokens('sys', turns, []);
  assert.ok(tokens > 1229 && tokens < 1600, String(tokens));
  assert.equal(openingParts('hello', null).length, 1);
});

test('OpenAI wire format carries the image as a data URL', () => {
  const shot = { mediaType: 'image/jpeg', data: 'QUJD', source: 'trace' };
  const msgs = toWireMessages({ system: 's', turns: [{ role: 'user', parts: openingParts('fix it', shot) }], tools: [], maxTokens: 10 });
  const user = msgs[1];
  assert.ok(Array.isArray(user.content));
  assert.equal(user.content[0].type, 'text');
  assert.equal(user.content[1].image_url.url, 'data:image/jpeg;base64,QUJD');
});
