/**
 * HMAC-SHA256 request signing shared by the uploader and the dashboard.
 * The signature covers the timestamp and the exact body, so a captured
 * request cannot be changed or replayed after the time window.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
export const SIGNATURE_HEADER = 'x-autoheal-signature';
export const TIMESTAMP_HEADER = 'x-autoheal-timestamp';
export const MAX_SKEW_SECONDS = 300;
export const MIN_SECRET_LENGTH = 32;
export function sign(secret, timestamp, body) {
    return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}
export function verifySignature(secret, body, signature, timestamp, now = Math.floor(Date.now() / 1000)) {
    if (!signature || !timestamp || !/^\d{9,12}$/.test(timestamp))
        return 'missing';
    const ts = Number(timestamp);
    if (Math.abs(now - ts) > MAX_SKEW_SECONDS)
        return 'stale';
    const expected = Buffer.from(sign(secret, ts, body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
        return 'mismatch';
    return null;
}
//# sourceMappingURL=signing.js.map