/**
 * HMAC-SHA256 request signing shared by the uploader and the dashboard.
 * The signature covers the timestamp and the exact body, so a captured
 * request cannot be changed or replayed after the time window.
 */
export declare const SIGNATURE_HEADER = "x-autoheal-signature";
export declare const TIMESTAMP_HEADER = "x-autoheal-timestamp";
export declare const MAX_SKEW_SECONDS = 300;
export declare const MIN_SECRET_LENGTH = 32;
export declare function sign(secret: string, timestamp: number, body: string): string;
export type VerifyFailure = 'missing' | 'stale' | 'mismatch';
export declare function verifySignature(secret: string, body: string, signature: string | undefined, timestamp: string | undefined, now?: number): VerifyFailure | null;
