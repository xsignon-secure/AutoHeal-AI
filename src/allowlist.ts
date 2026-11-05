/**
 * The structural guard: a fix may change how an element is found or waited
 * for, and nothing else.
 *
 * Both versions of the file are split into tokens (comments dropped,
 * strings kept whole, so a fake comment inside a string cannot hide code),
 * the token streams are diffed, and every changed region must be made only
 * of an allowlisted vocabulary: string and number literals, simple
 * punctuation, locator and wait method names, and identifiers the file
 * already used. A small set of names (process, require, request, route,
 * evaluate, eval, globalThis, os, subprocess...) is never allowed in a
 * change, even if the file already uses it. String concatenation,
 * template expressions, arrow functions and new declarations are not in the
 * vocabulary, so built-up names like '.gi' + 't/config' cannot be written.
 *
 * This is an allowlist: anything it does not know is blocked.
 */

export type Lang = 'js' | 'py';

export interface Token {
  kind: 'str' | 'tmplexpr' | 'num' | 'ident' | 'punct' | 'regex';
  value: string;
}

const JS_PUNCT = ['===', '!==', '**=', '...', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>'];
const PY_PUNCT = ['**=', '//=', '==', '!=', '<=', '>=', '->', ':=', '**', '//', '+=', '-=', '*=', '/=', '%=', '<<', '>>'];

function isIdentStart(c: string): boolean {
  return /[A-Za-z_$À-￿]/.test(c);
}
function isIdentPart(c: string): boolean {
  return /[\w$À-￿]/.test(c);
}

/** True when a `/` at this point starts a regex literal rather than division. */
function regexAllowed(prev: Token | undefined): boolean {
  if (!prev) return true;
  if (prev.kind === 'punct') return !/^[)\]}]$/.test(prev.value);
  if (prev.kind === 'ident') return /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(prev.value);
  return false;
}

export function tokenizeJs(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out.push({ kind: 'str', value: src.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let expr = false;
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '$' && src[j + 1] === '{') {
          expr = true;
          // Skip the expression, counting nested braces.
          let depth = 1;
          j += 2;
          while (j < n && depth > 0) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            j++;
          }
          continue;
        }
        j++;
      }
      out.push({ kind: expr ? 'tmplexpr' : 'str', value: src.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j] as string)) j++;
      out.push({ kind: 'num', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j] as string)) j++;
      out.push({ kind: 'ident', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '/' && regexAllowed(out[out.length - 1])) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(src[j] as string)) j++;
      out.push({ kind: 'regex', value: src.slice(i, j) });
      i = j;
      continue;
    }
    const multi = JS_PUNCT.find((p) => src.startsWith(p, i));
    out.push({ kind: 'punct', value: multi ?? c });
    i += multi ? multi.length : 1;
  }
  return out;
}

export function tokenizePy(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i] as string;
    if (/\s/.test(c) || c === '\\') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    const prefix = /^[rbuf]{0,2}(?='|")/i.exec(src.slice(i, i + 3));
    if (prefix && (isIdentStart(c) ? true : c === '"' || c === "'")) {
      const p = prefix[0];
      const q0 = i + p.length;
      const quote = src[q0] as string;
      if (quote === '"' || quote === "'") {
        const triple = src.startsWith(quote.repeat(3), q0);
        const delim = triple ? quote.repeat(3) : quote;
        let j = q0 + delim.length;
        while (j < n && !src.startsWith(delim, j)) {
          if (!triple && src[j] === '\n') break;
          j += src[j] === '\\' ? 2 : 1;
        }
        const value = src.slice(i, j + delim.length);
        const fexpr = /f/i.test(p) && /\{(?!\{)/.test(value.replace(/\{\{|\}\}/g, ''));
        out.push({ kind: fexpr ? 'tmplexpr' : 'str', value });
        i = j + delim.length;
        continue;
      }
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j] as string)) j++;
      out.push({ kind: 'num', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j] as string)) j++;
      out.push({ kind: 'ident', value: src.slice(i, j) });
      i = j;
      continue;
    }
    const multi = PY_PUNCT.find((p) => src.startsWith(p, i));
    out.push({ kind: 'punct', value: multi ?? c });
    i += multi ? multi.length : 1;
  }
  return out;
}

export function detectLang(file: string | undefined, source: string): Lang {
  if (file) return /\.py$/i.test(file) ? 'py' : 'js';
  return /^\s*def\s+\w+\s*\(/m.test(source) && !/=>|;\s*$/m.test(source) ? 'py' : 'js';
}

/** Locator, wait and readiness vocabulary a fix may add. */
const ALLOWED = new Set(
  [
    // Playwright locators (JS and Python names)
    'page', 'frame', 'locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId',
    'frameLocator', 'contentFrame', 'owner', 'first', 'last', 'nth', 'filter', 'and', 'has', 'hasText', 'hasNot', 'hasNotText', 'visible',
    'get_by_role', 'get_by_text', 'get_by_label', 'get_by_placeholder', 'get_by_alt_text', 'get_by_title', 'get_by_test_id', 'frame_locator',
    'content_frame', 'has_text', 'has_not', 'has_not_text', 'and_',
    // locator options
    'name', 'exact', 'level', 'checked', 'pressed', 'selected', 'expanded', 'disabled', 'includeHidden', 'include_hidden', 'state',
    // waits and readiness checks
    'await', 'expect', 'waitFor', 'wait_for', 'waitForURL', 'wait_for_url', 'waitForLoadState', 'wait_for_load_state', 'waitForSelector',
    'wait_for_selector', 'toBeVisible', 'toBeHidden', 'toBeAttached', 'toBeEnabled', 'toBeEditable', 'toBeInViewport', 'to_be_visible',
    'to_be_hidden', 'to_be_attached', 'to_be_enabled', 'to_be_editable', 'to_be_in_viewport', 'timeout',
    // actions (a fix may retarget or change the action, never add logic)
    'click', 'dblclick', 'fill', 'press', 'pressSequentially', 'press_sequentially', 'check', 'uncheck', 'setChecked', 'set_checked', 'hover',
    'focus', 'blur', 'clear', 'selectOption', 'select_option', 'tap', 'scrollIntoViewIfNeeded', 'scroll_into_view_if_needed',
    // Cypress commands that find elements (and .should, which waits for a condition)
    'cy', 'get', 'contains', 'find', 'within', 'eq', 'parent', 'parents', 'closest', 'children', 'siblings', 'next', 'prev', 'shadow',
    'should', 'select', 'rightclick', 'scrollIntoView', 'includeShadowDom', 'matchCase',
    // plain values and receivers
    'true', 'false', 'True', 'False', 'None', 'null', 'undefined', 'this', 'self',
  ],
);

/** Never allowed in a change, even when the file already uses them. */
const DENY = new Set([
  'process', 'require', 'import', 'from', 'export', 'module', 'exports', 'fetch', 'request', 'APIRequestContext', 'apiRequest', 'api_request',
  'XMLHttpRequest', 'WebSocket', 'navigator', 'eval', 'Function', 'globalThis', 'global', 'window', 'document', 'constructor', 'prototype',
  '__proto__', 'Reflect', 'Proxy', 'Buffer', 'atob', 'btoa', 'child_process', 'fs', 'os', 'sys', 'subprocess', 'socket', 'shutil', 'pathlib',
  'open', 'exec', 'execSync', 'spawn', 'spawnSync', '__import__', 'getattr', 'setattr', 'globals', 'locals', 'importlib', '__builtins__',
  'requests', 'urllib', 'httpx', 'route', 'routeFromHAR', 'route_from_har', 'unroute', 'fulfill', 'evaluate', 'evaluateHandle', 'evaluate_handle',
  'addInitScript', 'add_init_script', 'exposeFunction', 'expose_function', 'exposeBinding', 'expose_binding', 'setContent', 'set_content',
  'addScriptTag', 'add_script_tag', 'setExtraHTTPHeaders', 'set_extra_http_headers', 'context', 'browser', 'storageState', 'storage_state',
  'setInputFiles', 'set_input_files', 'download', 'saveAs', 'save_as', 'env', 'environ', 'getenv', 'String', 'fromCharCode', 'chr', 'ord',
  'skip', 'only', 'fixme', 'fail', 'slow', 'setTimeout', 'waitForTimeout', 'wait_for_timeout', 'sleep', 'force', 'retries', 'not', 'not_to_be_visible',
  'catch', 'try', 'except', 'finally', 'pass', 'if', 'else', 'elif', 'while', 'for', 'const', 'let', 'var', 'new', 'lambda', 'class', 'with', 'yield',
  'delete', 'void', 'typeof', 'instanceof', 'debugger', 'or', 'or_', 'goto', 'newPage', 'new_page', 'waitForNavigation', 'expect_navigation',
  // Cypress: faking the app, its clock or the network, running commands, and changing pages
  'Cypress', 'intercept', 'stub', 'spy', 'clock', 'tick', 'invoke', 'task', 'readFile', 'writeFile', 'visit', 'origin', 'session', 'wrap',
  'then', 'on', 'wait', 'config',
]);

/** Removing these means removing a check or a test. */
const PROTECTED = new Set([
  'expect', 'assert', 'test', 'it', 'describe', 'step', 'soft', 'poll', 'should', 'specify', 'context',
  'toHaveText', 'toContainText', 'toHaveValue', 'toHaveValues', 'toHaveURL', 'toHaveTitle', 'toHaveCount', 'toHaveAttribute', 'toHaveClass',
  'toHaveCSS', 'toHaveId', 'toHaveJSProperty', 'toHaveAccessibleName', 'toHaveAccessibleDescription', 'toHaveRole', 'toEqual', 'toStrictEqual',
  'toBe', 'toMatch', 'toContain', 'toHaveLength', 'toHaveProperty', 'toBeTruthy', 'toBeFalsy', 'toBeDefined', 'toBeNull', 'toBeChecked',
  'toBeDisabled', 'toBeEmpty', 'toBeFocused', 'toHaveScreenshot', 'toMatchAriaSnapshot', 'toMatchSnapshot', 'toBeVisible', 'toBeHidden',
  'to_have_text', 'to_contain_text', 'to_have_value', 'to_have_values', 'to_have_url', 'to_have_title', 'to_have_count', 'to_have_attribute',
  'to_have_class', 'to_have_css', 'to_have_id', 'to_have_js_property', 'to_have_accessible_name', 'to_have_role', 'to_be_checked',
  'to_be_disabled', 'to_be_empty', 'to_be_focused', 'to_be_visible', 'to_be_hidden', 'to_match_aria_snapshot', 'to_have_screenshot',
]);

const SAFE_PUNCT = new Set(['(', ')', '{', '}', '[', ']', ',', ':', '.', ';', '?.']);

export interface AllowlistResult {
  ok: boolean;
  problems: string[];
}

/** Longest common subsequence diff of two token streams, as changed regions. */
function changedRegions(a: Token[], b: Token[]): Array<{ removed: Token[]; added: Token[] }> | null {
  const same = (x: Token, y: Token) => x.kind === y.kind && x.value === y.value;
  let start = 0;
  while (start < a.length && start < b.length && same(a[start] as Token, b[start] as Token)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && same(a[endA - 1] as Token, b[endB - 1] as Token)) {
    endA--;
    endB--;
  }
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  if (!A.length && !B.length) return [];
  if (A.length * B.length > 25_000_000) return null;
  const m = A.length;
  const n = B.length;
  const width = n + 1;
  const table = new Uint32Array((m + 1) * width);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      table[i * width + j] = same(A[i] as Token, B[j] as Token)
        ? (table[(i + 1) * width + j + 1] as number) + 1
        : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
    }
  }
  const regions: Array<{ removed: Token[]; added: Token[] }> = [];
  let current: { removed: Token[]; added: Token[] } | null = null;
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && same(A[i] as Token, B[j] as Token)) {
      if (current) regions.push(current);
      current = null;
      i++;
      j++;
    } else if (j < n && (i >= m || (table[i * width + j + 1] as number) >= (table[(i + 1) * width + j] as number))) {
      current ??= { removed: [], added: [] };
      current.added.push(B[j] as Token);
      j++;
    } else {
      current ??= { removed: [], added: [] };
      current.removed.push(A[i] as Token);
      i++;
    }
  }
  if (current) regions.push(current);
  return regions;
}

function show(tokens: Token[]): string {
  const text = tokens.map((t) => t.value).join(' ');
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/**
 * Checks that `after` differs from `before` only in locators, waits and
 * literals. Returns the problems found (empty when the change is allowed).
 */
export function checkAllowlist(before: string, after: string, file?: string): AllowlistResult {
  const lang = detectLang(file, before + after);
  const tokenize = lang === 'py' ? tokenizePy : tokenizeJs;
  const a = tokenize(before);
  const b = tokenize(after);
  const known = new Set(a.filter((t) => t.kind === 'ident').map((t) => t.value));
  const regions = changedRegions(a, b);
  if (regions === null) return { ok: false, problems: ['the change is too large to verify token by token'] };
  const problems: string[] = [];
  for (const { removed, added } of regions) {
    for (const t of added) {
      let bad: string | null = null;
      if (t.kind === 'tmplexpr') bad = `a template or f-string with an expression (${t.value.slice(0, 40)})`;
      else if (t.kind === 'ident') {
        if (DENY.has(t.value) || (lang === 'js' && t.value === 'self')) bad = `\`${t.value}\` (never allowed in a fix)`;
        else if (!ALLOWED.has(t.value) && !known.has(t.value)) bad = `\`${t.value}\` (not a locator, wait or name the file already uses)`;
      } else if (t.kind === 'punct') {
        const okPunct = SAFE_PUNCT.has(t.value) || (lang === 'py' && t.value === '=');
        if (!okPunct) bad = `the operator \`${t.value}\``;
      }
      if (bad) {
        problems.push(`adds ${bad} in "${show(added)}"`);
        break;
      }
    }
    const lost = removed.find((t) => t.kind === 'ident' && PROTECTED.has(t.value));
    if (lost) problems.push(`removes \`${lost.value}\` in "${show(removed)}"`);
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)].slice(0, 5) };
}
