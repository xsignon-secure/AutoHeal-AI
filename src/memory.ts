/**
 * Repo memory: one small JSON file per kept fix, committed with it
 * (.autoheal/memory/<id>.json). One file per fix means two open AutoHeal PRs
 * never conflict on memory. A legacy .autoheal/memory.json is still read. Past locator moves and root causes are handed to
 * the model on the next heal, so repeat problems cost fewer tokens and are
 * fixed the same way every time. Holds test titles and short locator
 * strings only, never whole files or secrets.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface MemoryEntry {
  at: string;
  file: string;
  test: string;
  rootCause: string;
  before?: string;
  after?: string;
  note?: string;
}

export interface MemoryFile {
  version: 1;
  entries: MemoryEntry[];
}

/** Folder of memory entries (one JSON file each). */
export const MEMORY_DIR = '.autoheal/memory';
/** The single-file format of 0.1.0, still read. */
export const LEGACY_MEMORY_PATH = '.autoheal/memory.json';
const MAX_ENTRIES = 200;
const MAX_SNIPPET = 300;

function valid(e: unknown): e is MemoryEntry {
  const x = e as Partial<MemoryEntry> | null;
  return !!x && typeof x.file === 'string' && typeof x.test === 'string' && typeof x.at === 'string' && typeof x.rootCause === 'string';
}

export async function loadMemory(projectRoot: string): Promise<MemoryFile> {
  const entries: MemoryEntry[] = [];
  try {
    const legacy = JSON.parse(await readFile(path.join(projectRoot, LEGACY_MEMORY_PATH), 'utf8')) as Partial<MemoryFile>;
    if (legacy?.version === 1 && Array.isArray(legacy.entries)) entries.push(...legacy.entries.filter(valid));
  } catch {
    // No legacy file.
  }
  try {
    const dir = path.join(projectRoot, MEMORY_DIR);
    for (const name of (await readdir(dir)).filter((n) => n.endsWith('.json')).slice(0, 5000)) {
      try {
        const entry = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as unknown;
        if (valid(entry)) entries.push(entry);
      } catch {
        // Skip a broken entry.
      }
    }
  } catch {
    // No memory folder yet.
  }
  entries.sort((x, y) => x.at.localeCompare(y.at));
  return { version: 1, entries: entries.slice(-MAX_ENTRIES) };
}

/** Where the entry for this fix is stored, relative to the project (forward slashes). */
export function memoryEntryPath(entry: Pick<MemoryEntry, 'file' | 'test'> & { after?: string }): string {
  const id = createHash('sha256').update(`${entry.file}\n${entry.test}\n${clip(entry.after) ?? ''}`).digest('hex').slice(0, 16);
  return `${MEMORY_DIR}/${id}.json`;
}

let lastAt = 0;

function clip(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const one = value.trim();
  return one.length > MAX_SNIPPET ? `${one.slice(0, MAX_SNIPPET)}…` : one;
}

/** Saves one entry and returns its path relative to the project. */
export async function remember(projectRoot: string, entry: Omit<MemoryEntry, 'at'>): Promise<string> {
  lastAt = Math.max(Date.now(), lastAt + 1); // strictly increasing, so order survives a fast loop
  const clean: MemoryEntry = { at: new Date(lastAt).toISOString(), file: entry.file, test: entry.test, rootCause: entry.rootCause };
  const before = clip(entry.before);
  const after = clip(entry.after);
  const note = clip(entry.note);
  if (before !== undefined) clean.before = before;
  if (after !== undefined) clean.after = after;
  if (note !== undefined) clean.note = note;
  const rel = memoryEntryPath(clean);
  await mkdir(path.join(projectRoot, MEMORY_DIR), { recursive: true });
  await writeFile(path.join(projectRoot, rel), `${JSON.stringify(clean, null, 2)}\n`);
  return rel;
}

/** The entries worth showing the model for this failure, newest first. */
export function relevantMemory(memory: MemoryFile, file: string, limit = 12): MemoryEntry[] {
  const same = memory.entries.filter((e) => e.file === file);
  const other = memory.entries.filter((e) => e.file !== file && e.before !== undefined);
  return [...same.reverse(), ...other.reverse()].slice(0, limit);
}

export function memoryText(entries: MemoryEntry[]): string {
  if (!entries.length) return 'No earlier fixes are recorded for this repo.';
  return entries
    .map((e) => `- ${e.at.slice(0, 10)} ${e.file} › ${e.test}: ${e.rootCause}${e.before && e.after ? ` (${e.before} → ${e.after})` : ''}${e.note ? ` — ${e.note}` : ''}`)
    .join('\n');
}
