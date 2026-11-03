// Fixes for the CodeQL alerts on main after 0.3.0.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cell, OpenAIProvider, relativeImports } from '../dist/index.js';

test('table cells escape backslashes before pipes, and drop line breaks', () => {
  assert.equal(cell('a|b'), 'a\\|b');
  assert.equal(cell('a\\|b'), 'a\\\\\\|b', 'a backslash cannot un-escape the pipe');
  assert.equal(cell('one\ntwo'), 'one two');
});

test('only the real OpenAI host counts as official', () => {
  const name = (baseURL) => new OpenAIProvider({ baseURL, model: 'm' }).name;
  assert.equal(name('https://api.openai.com/v1'), 'openai');
  assert.equal(name('https://api.openai.com.evil.example/v1'), 'openai-compatible');
  assert.equal(name('https://evil.example/api.openai.com/v1'), 'openai-compatible');
  assert.equal(name('http://localhost:11434/v1'), 'openai-compatible');
});

test('python relative imports still resolve, including a bare "from . import"', () => {
  assert.deepEqual(relativeImports('tests/test_a.py', 'from .pages.login import LoginPage\n'), ['tests/pages/login.py']);
  assert.deepEqual(relativeImports('tests/test_a.py', 'from . import helpers\n'), []);
});
