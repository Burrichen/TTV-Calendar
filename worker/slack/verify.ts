/**
 * Slack request signature verification.
 *
 * This is the Worker's only public door, so it is the one place where getting the
 * details right actually matters. Slack's documented procedure
 * (https://api.slack.com/authentication/verifying-requests-from-slack):
 *
 *   basestring = "v0:" + X-Slack-Request-Timestamp + ":" + raw request body
 *   expected   = "v0=" + hex(HMAC_SHA256(signing_secret, basestring))
 *   compare    against X-Slack-Signature, in constant time
 *
 * Three details are easy to get wrong and are handled explicitly:
 *
 *  - **the body must be the bytes Slack signed.** The caller passes the raw text,
 *    read once, before any parsing. Re-encoding a parsed form would change the
 *    percent-encoding and silently break every signature.
 *  - **the timestamp bounds replay.** A captured request stays cryptographically
 *    valid forever; only the age check stops it being replayed.
 *  - **the comparison must not short-circuit.** `===` on strings leaks how much of a
 *    forged signature was correct, so the comparison is done by `crypto.subtle.verify`,
 *    which is constant-time by construction.
 */

/** Slack's own recommendation. Generous enough for clock skew, short enough to matter. */
export const MAX_REQUEST_AGE_SECONDS = 60 * 5;

export type VerificationFailure =
  'missing-headers' | 'malformed-timestamp' | 'expired' | 'malformed-signature' | 'bad-signature';

export type VerificationResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: VerificationFailure };

export interface VerifyOptions {
  readonly signingSecret: string;
  readonly signature: string | null;
  readonly timestamp: string | null;
  /** Exactly the bytes Slack hashed. */
  readonly body: string;
  /** Injectable so the replay window can be tested without waiting. */
  readonly now?: Date;
  readonly maxAgeSeconds?: number;
}

export async function verifySlackRequest(options: VerifyOptions): Promise<VerificationResult> {
  const { signature, timestamp } = options;

  if (signature === null || signature === '' || timestamp === null || timestamp === '') {
    return { ok: false, reason: 'missing-headers' };
  }

  const sentAt = Number(timestamp);
  if (!Number.isInteger(sentAt)) return { ok: false, reason: 'malformed-timestamp' };

  const now = options.now ?? new Date();
  const ageSeconds = Math.abs(Math.floor(now.getTime() / 1000) - sentAt);
  // Absolute value, so a request from the future is rejected too: a clock far enough
  // ahead would otherwise widen the replay window indefinitely.
  if (ageSeconds > (options.maxAgeSeconds ?? MAX_REQUEST_AGE_SECONDS)) {
    return { ok: false, reason: 'expired' };
  }

  if (!signature.startsWith('v0=')) return { ok: false, reason: 'malformed-signature' };

  const provided = decodeHex(signature.slice('v0='.length));
  if (provided === null) return { ok: false, reason: 'malformed-signature' };

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(options.signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    provided,
    encoder.encode(`v0:${timestamp}:${options.body}`),
  );

  return valid ? { ok: true } : { ok: false, reason: 'bad-signature' };
}

/** Strict hex decode. Returns null rather than guessing at malformed input. */
function decodeHex(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(value)) return null;

  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
