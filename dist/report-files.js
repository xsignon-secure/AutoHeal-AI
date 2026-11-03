/**
 * Finds the Playwright report inside a downloaded artifacts folder: a JSON
 * report (has "suites" and "config") or a blob-report folder (report-*.zip).
 */
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
async function head(file, bytes = 4096) {
    const handle = await open(file, 'r');
    try {
        const buf = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(buf, 0, bytes, 0);
        return buf.subarray(0, bytesRead).toString('utf8');
    }
    finally {
        await handle.close();
    }
}
export async function findReport(dir, maxDepth = 6) {
    const json = [];
    const blobs = [];
    const traceDirs = new Set();
    async function walk(current, depth) {
        if (depth > maxDepth)
            return;
        let entries;
        try {
            entries = await readdir(current, { withFileTypes: true });
        }
        catch {
            return;
        }
        if (entries.some((e) => e.isFile() && /^report-.*\.zip$/.test(e.name)))
            blobs.push(current);
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name.startsWith('.'))
                    continue;
                await walk(full, depth + 1);
            }
            else if (entry.isFile()) {
                if (entry.name === 'trace.zip')
                    traceDirs.add(path.dirname(path.dirname(full)));
                if (entry.name.endsWith('.json')) {
                    try {
                        const text = await head(full);
                        if (/"config"\s*:/.test(text) && /"suites"\s*:/.test(text))
                            json.push(full);
                        else if (/^\s*\{\s*"config"\s*:/.test(text))
                            json.push(full);
                    }
                    catch {
                        // unreadable file: skip
                    }
                }
            }
        }
    }
    await walk(path.resolve(dir), 0);
    const traces = [...traceDirs];
    const pick = json.sort((a, b) => a.length - b.length)[0];
    if (pick)
        return { report: pick, kind: 'json', traceDirs: traces };
    const blob = blobs.sort((a, b) => a.length - b.length)[0];
    if (blob)
        return { report: blob, kind: 'blob', traceDirs: traces };
    return null;
}
//# sourceMappingURL=report-files.js.map