/**
 * Visual grounding: the screenshot of the page at the moment a test failed,
 * taken from the run's own artifacts (no browser, no network). It comes from
 * Playwright's `test-failed-*.png` attachment when there is one, otherwise
 * from the last screencast frame in the trace before the failing action ended.
 *
 * The image only ever goes to the AI provider you configured. It is never
 * written into a PR, issue, comment or the dashboard.
 */
import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
/** Images larger than this are skipped (providers cap images at about 5 MB of base64). */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
/** Reads the entries of a zip file (stored or deflated), with size limits. */
export function readZip(buf, wanted) {
    const out = new Map();
    // End of central directory: the last 0x06054b50 within the final 64 KB.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0)
        return out;
    const count = buf.readUInt16LE(eocd + 10);
    let offset = buf.readUInt32LE(eocd + 16);
    for (let n = 0; n < Math.min(count, MAX_ENTRIES); n++) {
        if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50)
            break;
        const method = buf.readUInt16LE(offset + 10);
        const compressed = buf.readUInt32LE(offset + 20);
        const size = buf.readUInt32LE(offset + 24);
        const nameLen = buf.readUInt16LE(offset + 28);
        const extraLen = buf.readUInt16LE(offset + 30);
        const commentLen = buf.readUInt16LE(offset + 32);
        const local = buf.readUInt32LE(offset + 42);
        const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
        offset += 46 + nameLen + extraLen + commentLen;
        if (wanted && !wanted(name))
            continue;
        if (size > MAX_ENTRY_BYTES || local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50)
            continue;
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.subarray(start, start + compressed);
        try {
            if (method === 0)
                out.set(name, Buffer.from(raw));
            else if (method === 8)
                out.set(name, inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }));
        }
        catch {
            // A broken entry is skipped.
        }
    }
    return out;
}
/** Width and height of a PNG, from its header. */
export function pngSize(buf) {
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47)
        return undefined;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
/** Width and height of a JPEG, from its first frame header. */
export function jpegSize(buf) {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8)
        return undefined;
    let i = 2;
    while (i + 9 < buf.length) {
        if (buf[i] !== 0xff)
            return undefined;
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
    }
    return undefined;
}
function mediaTypeOf(buf) {
    if (pngSize(buf))
        return 'image/png';
    if (jpegSize(buf))
        return 'image/jpeg';
    return undefined;
}
/**
 * Input tokens an image costs, as Claude counts them (about width × height /
 * 750 after the long side is scaled to at most 1568 px). Unknown sizes count
 * as the maximum, so the budget check stays on the safe side.
 */
export function imageTokens(width, height) {
    if (!width || !height)
        return 1600;
    const scale = Math.min(1, 1568 / Math.max(width, height));
    return Math.min(1600, Math.ceil((width * scale * (height * scale)) / 750));
}
function toScreenshot(buf, source) {
    if (buf.length > MAX_IMAGE_BYTES)
        return null;
    const mediaType = mediaTypeOf(buf);
    if (!mediaType)
        return null;
    const size = mediaType === 'image/png' ? pngSize(buf) : jpegSize(buf);
    return { mediaType, data: buf.toString('base64'), ...(size ?? {}), source };
}
/** The last screencast frame at or before the end of the first failing action. */
export function frameFromTrace(entries) {
    const frames = [];
    let failedAt;
    for (const [name, buf] of entries) {
        if (!name.endsWith('.trace'))
            continue;
        for (const line of buf.toString('utf8').split('\n')) {
            if (!line.startsWith('{'))
                continue;
            let event;
            try {
                event = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (event.type === 'screencast-frame' && typeof event.timestamp === 'number') {
                const entry = typeof event.file === 'string' ? event.file : typeof event.sha1 === 'string' ? `resources/${event.sha1}` : undefined;
                if (entry)
                    frames.push({ entry, timestamp: event.timestamp });
            }
            else if (event.type === 'after' && event.error && typeof event.endTime === 'number' && failedAt === undefined) {
                failedAt = event.endTime;
            }
        }
    }
    return pickFrame(entries, frames, failedAt);
}
function screencastFrames(entries) {
    const frames = [];
    for (const [name, buf] of entries) {
        if (!name.endsWith('.trace'))
            continue;
        for (const line of buf.toString('utf8').split('\n')) {
            if (!line.startsWith('{') || !line.includes('screencast-frame'))
                continue;
            try {
                const event = JSON.parse(line);
                const entry = typeof event.file === 'string' ? event.file : typeof event.sha1 === 'string' ? `resources/${event.sha1}` : undefined;
                if (event.type === 'screencast-frame' && typeof event.timestamp === 'number' && entry)
                    frames.push({ entry, timestamp: event.timestamp });
            }
            catch {
                // skip
            }
        }
    }
    return frames;
}
/** The last screencast frame at or before `until` (a trace timestamp), or the last frame. */
export function frameAt(entries, until) {
    return pickFrame(entries, screencastFrames(entries), until);
}
function pickFrame(entries, frames, until) {
    frames.sort((a, b) => a.timestamp - b.timestamp);
    const candidates = until === undefined ? frames : frames.filter((f) => f.timestamp <= until + 250);
    for (const frame of [...(candidates.length ? candidates : frames)].reverse()) {
        const image = entries.get(frame.entry);
        if (image) {
            const shot = toScreenshot(image, 'trace');
            if (shot)
                return shot;
        }
    }
    return null;
}
/** Reads a regular file through one handle (no symlinks, size checked on the open file), or null. */
async function readSmallFile(file, maxBytes) {
    let fh;
    try {
        fh = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const st = await fh.stat();
        if (!st.isFile() || st.size > maxBytes)
            return null;
        return await fh.readFile();
    }
    catch {
        return null;
    }
    finally {
        await fh?.close();
    }
}
async function insideRoot(root, file) {
    try {
        const realRoot = await realpath(root);
        const real = await realpath(path.resolve(root, file));
        return real === realRoot || real.startsWith(realRoot + path.sep) ? real : null;
    }
    catch {
        return null;
    }
}
/**
 * The screenshot for a failure whose trace is at `tracePath` (relative to the
 * project or absolute inside it). Returns null when there is none.
 */
export async function failureScreenshot(root, tracePath) {
    if (!tracePath)
        return null;
    const trace = await insideRoot(root, tracePath);
    if (!trace)
        return null;
    // 1. Playwright's own failure screenshot next to the trace.
    try {
        const dir = path.dirname(trace);
        const names = (await readdir(dir)).filter((n) => /^test-failed-\d+\.png$/.test(n)).sort();
        for (const name of names.reverse()) {
            const buf = await readSmallFile(path.join(dir, name), MAX_IMAGE_BYTES);
            const shot = buf && toScreenshot(buf, 'attachment');
            if (shot)
                return shot;
        }
    }
    catch {
        // No attachment folder.
    }
    // 2. The last screencast frame in the trace.
    try {
        const buf = await readSmallFile(trace, MAX_ZIP_BYTES);
        if (!buf)
            return null;
        const entries = readZip(buf, (name) => name.endsWith('.trace') || name.startsWith('resources/') || name.startsWith('screencast/'));
        return frameFromTrace(entries);
    }
    catch {
        return null;
    }
}
/** Whether to send screenshots: AUTOHEAL_VISION=true|false, default on for Anthropic and OpenAI, off for other endpoints. */
export function visionEnabled(providerName, env = process.env) {
    const setting = (env.AUTOHEAL_VISION ?? 'auto').toLowerCase();
    if (setting === 'false' || setting === '0' || setting === 'off')
        return false;
    if (setting === 'true' || setting === '1' || setting === 'on')
        return true;
    return providerName === 'anthropic' || providerName === 'openai' || providerName === 'scripted';
}
/** The screenshot at `until` (trace clock) from a trace.zip on disk, or null. */
export async function frameFromFile(file, until) {
    try {
        const buf = await readSmallFile(file, MAX_ZIP_BYTES);
        if (!buf)
            return null;
        return frameAt(readZip(buf, (name) => name.endsWith('.trace') || name.startsWith('resources/') || name.startsWith('screencast/')), until);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=vision.js.map