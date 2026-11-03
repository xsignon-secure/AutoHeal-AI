/**
 * Repo memory: one small JSON file per kept fix, committed with it
 * (.autoheal/memory/<id>.json). One file per fix means two open AutoHeal PRs
 * never conflict on memory. A legacy .autoheal/memory.json is still read. Past locator moves and root causes are handed to
 * the model on the next heal, so repeat problems cost fewer tokens and are
 * fixed the same way every time. Holds test titles and short locator
 * strings only, never whole files or secrets.
 */
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
export declare const MEMORY_DIR = ".autoheal/memory";
/** The single-file format of 0.1.0, still read. */
export declare const LEGACY_MEMORY_PATH = ".autoheal/memory.json";
export declare function loadMemory(projectRoot: string): Promise<MemoryFile>;
/** Where the entry for this fix is stored, relative to the project (forward slashes). */
export declare function memoryEntryPath(entry: Pick<MemoryEntry, 'file' | 'test'> & {
    after?: string;
}): string;
/** Saves one entry and returns its path relative to the project. */
export declare function remember(projectRoot: string, entry: Omit<MemoryEntry, 'at'>): Promise<string>;
/** The entries worth showing the model for this failure, newest first. */
export declare function relevantMemory(memory: MemoryFile, file: string, limit?: number): MemoryEntry[];
export declare function memoryText(entries: MemoryEntry[]): string;
