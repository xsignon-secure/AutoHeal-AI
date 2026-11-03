/**
 * Visual grounding: the screenshot of the page at the moment a test failed,
 * taken from the run's own artifacts (no browser, no network). It comes from
 * Playwright's `test-failed-*.png` attachment when there is one, otherwise
 * from the last screencast frame in the trace before the failing action ended.
 *
 * The image only ever goes to the AI provider you configured. It is never
 * written into a PR, issue, comment or the dashboard.
 */
export type ImageMediaType = 'image/png' | 'image/jpeg';
export interface Screenshot {
    mediaType: ImageMediaType;
    /** Base64 data. */
    data: string;
    width?: number;
    height?: number;
    source: 'attachment' | 'trace';
}
/** Images larger than this are skipped (providers cap images at about 5 MB of base64). */
export declare const MAX_IMAGE_BYTES: number;
/** Reads the entries of a zip file (stored or deflated), with size limits. */
export declare function readZip(buf: Buffer, wanted?: (name: string) => boolean): Map<string, Buffer>;
/** Width and height of a PNG, from its header. */
export declare function pngSize(buf: Buffer): {
    width: number;
    height: number;
} | undefined;
/** Width and height of a JPEG, from its first frame header. */
export declare function jpegSize(buf: Buffer): {
    width: number;
    height: number;
} | undefined;
/**
 * Input tokens an image costs, as Claude counts them (about width × height /
 * 750 after the long side is scaled to at most 1568 px). Unknown sizes count
 * as the maximum, so the budget check stays on the safe side.
 */
export declare function imageTokens(width?: number, height?: number): number;
/** The last screencast frame at or before the end of the first failing action. */
export declare function frameFromTrace(entries: Map<string, Buffer>): Screenshot | null;
/**
 * The screenshot for a failure whose trace is at `tracePath` (relative to the
 * project or absolute inside it). Returns null when there is none.
 */
export declare function failureScreenshot(root: string, tracePath: string | undefined): Promise<Screenshot | null>;
/** Whether to send screenshots: AUTOHEAL_VISION=true|false, default on for Anthropic and OpenAI, off for other endpoints. */
export declare function visionEnabled(providerName: string | undefined, env?: NodeJS.ProcessEnv): boolean;
