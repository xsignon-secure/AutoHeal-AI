/**
 * Reads the DOM snapshots inside a Playwright trace (the ones the trace
 * viewer shows), so AutoHeal can see which element each step acted on and
 * what the page looked like when a locator stopped matching.
 *
 * Snapshots are stored incrementally: a node can be a reference
 * [[snapshotsAgo, nodeIndex]] to a node of an earlier snapshot of the same
 * frame, where nodeIndex counts that snapshot's nodes in post-order. This
 * module resolves those references the same way the trace viewer does.
 */

export interface El {
  tag: string;
  attrs: Record<string, string>;
  children: Array<El | string>;
  parent?: El;
}

/** One resolved DOM snapshot of a frame, taken for one call. */
export interface DomSnapshot {
  callId: string;
  /** before, action, after (or the older before@/input@/after@ names). */
  phase: string;
  frameUrl?: string;
  root: El;
}

type RawNode = string | [[number, number]] | [string, Record<string, string>?, ...unknown[]];

interface RawSnapshot {
  callId?: string;
  phase?: string;
  snapshotName?: string;
  frameId?: string;
  pageId?: string;
  frameUrl?: string;
  html?: unknown;
}

const MAX_NODES = 30_000;
const SKIP_TEXT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

function isRef(n: unknown): n is [[number, number]] {
  return Array.isArray(n) && Array.isArray(n[0]);
}

function isElement(n: unknown): n is [string, Record<string, string>?, ...unknown[]] {
  return Array.isArray(n) && typeof n[0] === 'string';
}

/** Post-order list of a raw snapshot's own nodes (references are not counted). */
function postOrder(html: unknown, cache: Map<unknown, unknown[]>): unknown[] {
  const hit = cache.get(html);
  if (hit) return hit;
  const nodes: unknown[] = [];
  const visit = (n: unknown, depth: number): void => {
    if (nodes.length > MAX_NODES || depth > 400) return;
    if (typeof n === 'string') nodes.push(n);
    else if (isElement(n)) {
      for (const child of n.slice(2)) visit(child, depth + 1);
      nodes.push(n);
    }
  };
  visit(html, 0);
  cache.set(html, nodes);
  return nodes;
}

function phaseOf(s: RawSnapshot): string {
  if (s.phase) return s.phase;
  const name = s.snapshotName ?? '';
  const at = name.indexOf('@');
  return at > 0 ? name.slice(0, at) : name;
}

/**
 * Resolves every frame snapshot in the trace lines. `wanted` limits which
 * calls get a resolved tree (resolving is the expensive part).
 */
export function readSnapshots(lines: Array<{ type?: string; snapshot?: RawSnapshot }>, wanted?: (callId: string, phase: string) => boolean): DomSnapshot[] {
  const byFrame = new Map<string, RawSnapshot[]>();
  const order: Array<{ frame: string; index: number }> = [];
  for (const l of lines) {
    if (l.type !== 'frame-snapshot' || !l.snapshot) continue;
    const s = l.snapshot;
    const frame = `${s.pageId ?? ''}/${s.frameId ?? ''}`;
    const list = byFrame.get(frame) ?? [];
    list.push(s);
    byFrame.set(frame, list);
    order.push({ frame, index: list.length - 1 });
  }
  const cache = new Map<unknown, unknown[]>();
  const out: DomSnapshot[] = [];
  for (const { frame, index } of order) {
    const list = byFrame.get(frame) as RawSnapshot[];
    const s = list[index] as RawSnapshot;
    const phase = phaseOf(s);
    if (!s.callId || (wanted && !wanted(s.callId, phase))) continue;
    let count = 0;
    const build = (n: unknown, at: number, depth: number, parent?: El): El | string | null => {
      if (++count > MAX_NODES || depth > 400) return null;
      if (typeof n === 'string') return n;
      if (isRef(n)) {
        const ref = at - n[0][0];
        if (ref < 0 || ref > at) return null;
        const nodes = postOrder((list[ref] as RawSnapshot).html, cache);
        const target = nodes[n[0][1]];
        return target === undefined ? null : build(target, ref, depth, parent);
      }
      if (!isElement(n)) return null;
      const attrs: Record<string, string> = {};
      const rawAttrs = n[1];
      if (rawAttrs && typeof rawAttrs === 'object' && !Array.isArray(rawAttrs)) {
        for (const [k, v] of Object.entries(rawAttrs)) if (typeof v === 'string') attrs[k] = v;
      }
      const el: El = { tag: n[0].toUpperCase(), attrs, children: [], ...(parent ? { parent } : {}) };
      for (const child of n.slice(2)) {
        const c = build(child, at, depth + 1, el);
        if (c !== null) el.children.push(c);
      }
      return el;
    };
    const root = build(s.html, index, 0);
    if (root && typeof root !== 'string') out.push({ callId: s.callId, phase, ...(s.frameUrl ? { frameUrl: s.frameUrl } : {}), root });
  }
  return out;
}

export function elements(root: El): El[] {
  const out: El[] = [];
  const walk = (e: El): void => {
    if (out.length > MAX_NODES) return;
    out.push(e);
    for (const c of e.children) if (typeof c !== 'string') walk(c);
  };
  walk(root);
  return out;
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function textOf(e: El, max = 300): string {
  let text = '';
  const walk = (n: El | string): void => {
    if (text.length > max) return;
    if (typeof n === 'string') text += n;
    else if (!SKIP_TEXT.has(n.tag)) {
      if (n.tag === 'INPUT' && (n.attrs.type === 'submit' || n.attrs.type === 'button')) text += ` ${n.attrs.value ?? ''} `;
      for (const c of n.children) walk(c);
      if (/^(?:BR|P|DIV|LI|TD|TH|H[1-6])$/.test(n.tag)) text += ' ';
    }
  };
  walk(e);
  return collapse(text).slice(0, max);
}

/** The element a call acted on: marked __playwright_target__ in that call's snapshot. */
export function targetOf(snapshot: DomSnapshot): El | null {
  for (const e of elements(snapshot.root)) {
    const mark = e.attrs.__playwright_target__;
    if (mark !== undefined && (mark === '' || mark === snapshot.callId)) return e;
  }
  return null;
}

const INPUT_ROLES: Record<string, string> = {
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  number: 'spinbutton',
  search: 'searchbox',
  email: 'textbox',
  tel: 'textbox',
  text: 'textbox',
  url: 'textbox',
  password: '',
  hidden: '',
  file: '',
};

const TAG_ROLES: Record<string, string> = {
  BUTTON: 'button',
  TEXTAREA: 'textbox',
  H1: 'heading',
  H2: 'heading',
  H3: 'heading',
  H4: 'heading',
  H5: 'heading',
  H6: 'heading',
  NAV: 'navigation',
  MAIN: 'main',
  UL: 'list',
  OL: 'list',
  LI: 'listitem',
  TABLE: 'table',
  TR: 'row',
  TD: 'cell',
  TH: 'columnheader',
  DIALOG: 'dialog',
  OPTION: 'option',
  P: 'paragraph',
  ARTICLE: 'article',
  ASIDE: 'complementary',
  HEADER: 'banner',
  FOOTER: 'contentinfo',
  PROGRESS: 'progressbar',
  SUMMARY: 'button',
};

export function roleOf(e: El): string {
  const explicit = e.attrs.role?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  if (e.tag === 'A' || e.tag === 'AREA') return e.attrs.href !== undefined ? 'link' : '';
  if (e.tag === 'INPUT') return INPUT_ROLES[(e.attrs.type ?? 'text').toLowerCase()] ?? 'textbox';
  if (e.tag === 'SELECT') return e.attrs.multiple !== undefined || Number(e.attrs.size ?? 0) > 1 ? 'listbox' : 'combobox';
  if (e.tag === 'IMG') return e.attrs.alt === '' ? 'presentation' : 'img';
  if (e.tag === 'SECTION') return e.attrs['aria-label'] || e.attrs['aria-labelledby'] ? 'region' : '';
  if (e.tag === 'FORM') return e.attrs['aria-label'] || e.attrs['aria-labelledby'] ? 'form' : '';
  return TAG_ROLES[e.tag] ?? '';
}

const NAME_FROM_CONTENT = new Set(['button', 'link', 'heading', 'cell', 'columnheader', 'rowheader', 'option', 'tab', 'menuitem', 'checkbox', 'radio', 'switch', 'treeitem', 'listitem', 'tooltip']);

function root(e: El): El {
  let r = e;
  while (r.parent) r = r.parent;
  return r;
}

function byId(top: El, id: string): El | undefined {
  return elements(top).find((x) => x.attrs.id === id);
}

/** The text of the <label> for a form control. */
export function labelOf(e: El): string {
  if (!/^(?:INPUT|SELECT|TEXTAREA|METER|PROGRESS|OUTPUT)$/.test(e.tag)) return '';
  const id = e.attrs.id;
  if (id) {
    const label = elements(root(e)).find((x) => x.tag === 'LABEL' && x.attrs.for === id);
    if (label) return textOf(label);
  }
  for (let p = e.parent; p; p = p.parent) if (p.tag === 'LABEL') return textOf(p);
  return '';
}

/** A close approximation of the accessible name. */
export function nameOf(e: El, role = roleOf(e)): string {
  const labelledBy = e.attrs['aria-labelledby'];
  if (labelledBy) {
    const top = root(e);
    const text = labelledBy
      .split(/\s+/)
      .map((id) => byId(top, id))
      .filter((x): x is El => !!x)
      .map((x) => textOf(x))
      .join(' ');
    if (collapse(text)) return collapse(text);
  }
  if (e.attrs['aria-label']?.trim()) return collapse(e.attrs['aria-label']);
  const label = labelOf(e);
  if (label) return label;
  if (e.tag === 'INPUT' && /^(?:submit|button|reset)$/.test(e.attrs.type ?? '')) return collapse(e.attrs.value ?? (e.attrs.type === 'submit' ? 'Submit' : e.attrs.type === 'reset' ? 'Reset' : ''));
  if (e.tag === 'IMG' || (e.tag === 'INPUT' && e.attrs.type === 'image')) return collapse(e.attrs.alt ?? '');
  if (NAME_FROM_CONTENT.has(role)) {
    const t = textOf(e);
    if (t) return t;
  }
  return collapse(e.attrs.title ?? e.attrs.placeholder ?? '');
}

/** What identifies an element, saved so it can be found again after the app changes. */
export interface Fingerprint {
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  testId?: string;
  id?: string;
  nameAttr?: string;
  type?: string;
  label?: string;
  placeholder?: string;
  href?: string;
  /** The nearest heading, legend or labelled landmark around it. */
  near?: string;
}

const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];

function testIdOf(e: El): { attr: string; value: string } | null {
  for (const attr of TEST_ID_ATTRS) if (e.attrs[attr]) return { attr, value: e.attrs[attr] };
  return null;
}

/** Heading, legend or labelled container text around the element. */
function nearOf(e: El): string {
  for (let p = e.parent, depth = 0; p && depth < 6; p = p.parent, depth++) {
    if (p.attrs['aria-label']?.trim()) return collapse(p.attrs['aria-label']).slice(0, 80);
    for (const c of p.children) {
      if (typeof c === 'string' || c === e) continue;
      if (/^(?:H[1-6]|LEGEND|CAPTION)$/.test(c.tag)) return textOf(c, 80);
    }
  }
  return '';
}

const clip = (s: string, n: number): string | undefined => {
  const t = collapse(s);
  return t ? t.slice(0, n) : undefined;
};

export function fingerprintOf(e: El): Fingerprint {
  const role = roleOf(e);
  const fp: Fingerprint = { tag: e.tag };
  const set = <K extends keyof Fingerprint>(k: K, v: Fingerprint[K] | undefined) => {
    if (v !== undefined && v !== '') fp[k] = v;
  };
  set('role', role || undefined);
  set('name', clip(nameOf(e, role), 120));
  set('text', clip(textOf(e, 160), 120));
  set('testId', testIdOf(e)?.value);
  set('id', e.attrs.id);
  set('nameAttr', e.attrs.name);
  set('type', e.attrs.type);
  set('label', clip(labelOf(e), 120));
  set('placeholder', clip(e.attrs.placeholder ?? '', 120));
  set('href', e.attrs.href?.slice(0, 200));
  set('near', clip(nearOf(e), 80));
  return fp;
}

const norm = (s: string | undefined): string => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

function words(s: string): Set<string> {
  return new Set(norm(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

/** 0..1 word overlap. */
export function similarity(a: string | undefined, b: string | undefined): number {
  if (!a || !b) return 0;
  if (norm(a) === norm(b)) return 1;
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

export interface Match {
  element: El;
  fingerprint: Fingerprint;
  /** 0..1, share of the saved fingerprint that the element still has. */
  score: number;
  /** How far ahead of the next best element it is. */
  margin: number;
  /** Signals that matched, for the PR. */
  signals: string[];
}

export interface MatchOptions {
  /**
   * The value an assertion checks. Text equal to it never counts toward a
   * match, so a fingerprint cannot steer a check onto another element that
   * happens to show the expected value.
   */
  expected?: string;
  /** The failing step is an action (click, fill…), not an assertion. */
  action?: boolean;
}

/** Finds the element that best matches a saved fingerprint, or null when no match is clear. */
export function bestMatch(saved: Fingerprint, candidates: El[], options: MatchOptions = {}): Match | null {
  const expected = options.expected !== undefined ? norm(options.expected) : undefined;
  const usable = (s: string | undefined) => s !== undefined && (expected === undefined || (!norm(s).includes(expected) && !expected.includes(norm(s))));
  const weights: Array<[keyof Fingerprint, number, boolean]> = [
    ['testId', 6, true],
    ['id', 4, true],
    ['nameAttr', 3, true],
    ['label', 3, usable(saved.label)],
    ['placeholder', 2, true],
    ['href', 2, true],
    ['role', 2, true],
    ['type', 1, true],
    ['tag', 1, true],
    ['near', 1, true],
    ['name', 3, usable(saved.name)],
    ['text', 2, usable(saved.text)],
  ];
  let max = 0;
  for (const [k, w, use] of weights) if (use && saved[k] !== undefined) max += w;
  if (max === 0) return null;
  const scored: Array<{ e: El; fp: Fingerprint; score: number; signals: string[]; structural: number }> = [];
  for (const e of candidates) {
    if (e.tag === 'HTML' || e.tag === 'HEAD' || e.tag === 'BODY') continue;
    const fp = fingerprintOf(e);
    if (saved.role && fp.role && saved.role !== fp.role) continue; // a button never becomes a link
    if (saved.tag !== fp.tag && !(saved.role && saved.role === fp.role)) continue;
    let score = 0;
    let structural = 0;
    const signals: string[] = [];
    for (const [k, w, use] of weights) {
      if (!use || saved[k] === undefined || fp[k] === undefined) continue;
      const s = k === 'name' || k === 'text' || k === 'label' || k === 'near' ? similarity(saved[k], fp[k]) : saved[k] === fp[k] ? 1 : 0;
      if (s <= 0) continue;
      score += w * s;
      if (s === 1) signals.push(k);
      if (s === 1 && ['testId', 'id', 'nameAttr', 'label', 'placeholder', 'href'].includes(k)) structural++;
    }
    scored.push({ e, fp, score: score / max, signals, structural });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0] as (typeof scored)[number];
  const second = scored[1]?.score ?? 0;
  const margin = best.score - second;
  // Clear winners only: most of the fingerprint still matches, well ahead of the rest.
  const strong = best.score >= 0.5 && margin >= 0.15 && (best.structural > 0 || best.signals.includes('name') || best.signals.includes('text'));
  // An action on the only element of its role and kind left in the same place (a renamed button, say).
  // Later assertions in the test still check what the action did.
  const sameKind = scored.filter((x) => x.fp.role === best.fp.role && x.fp.tag === best.fp.tag && (x.fp.near ?? '') === (best.fp.near ?? ''));
  const lone = options.action === true && !!saved.role && best.fp.role === saved.role && sameKind.length === 1 && best.score >= 0.3 && (saved.near === undefined || best.fp.near === saved.near);
  if (!strong && !lone) return null;
  return { element: best.e, fingerprint: best.fp, score: Math.round(best.score * 100) / 100, margin: Math.round(margin * 100) / 100, signals: best.signals };
}
