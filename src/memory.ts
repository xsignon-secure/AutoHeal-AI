/**
 * Repo memory: a small JSON file committed with the fixes
 * (.autoheal/memory.json). Past locator moves and root causes are handed to
 * the model on the next heal, so repeat problems cost fewer tokens and are
 * fixed the same way every time. Holds test titles and short locator
 * strings only, never whole files or secrets.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

export const MEMORY_PATH = path.join('.autoheal', 'memory.json');
const MAX_ENTRIES = 200;
const MAX_SNIPPET = 300;

export async function loadMemory(projectRoot: string): Promise<MemoryFile> {
  try {
    const parsed = JSON.parse(await readFile(path.join(projectRoot, MEMORY_PATH), 'utf8')) as Partial<MemoryFile>;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
      return { version: 1, entries: parsed.entries.filter((e): e is MemoryEntry => typeof e?.file === 'string' && typeof e?.test === 'string') };
    }
  } catch {
    // Missing or unreadable: start empty.
  }
  return { version: 1, entries: [] };
}

function clip(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const one = value.trim();
  return one.length > MAX_SNIPPET ? `${one.slice(0, MAX_SNIPPET)}…` : one;
}

export async function remember(projectRoot: string, entry: Omit<MemoryEntry, 'at'>): Promise<void> {
  const memory = await loadMemory(projectRoot);
  const clean: MemoryEntry = { at: new Date().toISOString(), file: entry.file, test: entry.test, rootCause: entry.rootCause };
  const before = clip(entry.before);
  const after = clip(entry.after);
  const note = clip(entry.note);
  if (before !== undefined) clean.before = before;
  if (after !== undefined) clean.after = after;
  if (note !== undefined) clean.note = note;
  memory.entries.push(clean);
  memory.entries = memory.entries.slice(-MAX_ENTRIES);
  await mkdir(path.join(projectRoot, '.autoheal'), { recursive: true });
  await writeFile(path.join(projectRoot, MEMORY_PATH), `${JSON.stringify(memory, null, 2)}\n`);
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
