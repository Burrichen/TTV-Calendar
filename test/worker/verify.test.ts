import { describe, expect, it } from 'vitest';

import { MAX_REQUEST_AGE_SECONDS, verifySlackRequest } from '../../worker/slack/verify.ts';
import { signSlackRequest } from './support/slack-signing.ts';

/**
 * Slack request signature verification.
 *
 * This is the Worker's only public door, so these tests are about what gets turned
 * away. Every case here is something an attacker or a misconfiguration could actually
 * produce: a forged signature, a captured request replayed later, a body altered in
 * flight, a wrong secret.
 */

const SECRET = 'slack-signing-secret';
const NOW = new Date('2026-09-29T12:00:00Z');
const BODY = 'payload=%7B%22type%22%3A%22block_actions%22%7D';

const verify = async (
  overrides: Partial<{ signature: string; timestamp: string; body: string; now: Date }> = {},
): ReturnType<typeof verifySlackRequest> => {
  const signed = await signSlackRequest(SECRET, overrides.body ?? BODY, NOW);

  return verifySlackRequest({
    signingSecret: SECRET,
    signature: overrides.signature ?? signed.signature,
    timestamp: overrides.timestamp ?? signed.timestamp,
    body: overrides.body ?? BODY,
    now: overrides.now ?? NOW,
  });
};

describe('a genuine Slack request', () => {
  it('is accepted', async () => {
    expect(await verify()).toEqual({ ok: true });
  });

  it('is accepted at the edge of the replay window', async () => {
    const now = new Date(NOW.getTime() + MAX_REQUEST_AGE_SECONDS * 1000);
    expect(await verify({ now })).toEqual({ ok: true });
  });

  it('is accepted when the body contains characters that need encoding', async () => {
    const body = 'payload=%7B%22text%22%3A%22caf%C3%A9%20%2B%20100%25%22%7D';
    expect(await verify({ body })).toEqual({ ok: true });
  });
});

describe('a forged or altered request', () => {
  it('is rejected when the signature is wrong', async () => {
    const result = await verify({ signature: `v0=${'0'.repeat(64)}` });
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('is rejected when the body was altered after signing', async () => {
    // The signature is computed over the original body; the request carries another.
    const signed = await signSlackRequest(SECRET, BODY, NOW);

    const result = await verifySlackRequest({
      signingSecret: SECRET,
      signature: signed.signature,
      timestamp: signed.timestamp,
      body: `${BODY}&injected=1`,
      now: NOW,
    });

    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('is rejected when signed with a different secret', async () => {
    const signed = await signSlackRequest('someone-elses-secret', BODY, NOW);

    const result = await verifySlackRequest({
      signingSecret: SECRET,
      signature: signed.signature,
      timestamp: signed.timestamp,
      body: BODY,
      now: NOW,
    });

    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('is rejected when the timestamp is changed, since it is part of what was signed', async () => {
    const signed = await signSlackRequest(SECRET, BODY, NOW);
    const shifted = String(Number(signed.timestamp) + 1);

    const result = await verifySlackRequest({
      signingSecret: SECRET,
      signature: signed.signature,
      timestamp: shifted,
      body: BODY,
      now: NOW,
    });

    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });
});

describe('replay protection', () => {
  it('rejects a request older than the window', async () => {
    // A captured request stays cryptographically valid forever; only age stops it.
    const now = new Date(NOW.getTime() + (MAX_REQUEST_AGE_SECONDS + 1) * 1000);
    expect(await verify({ now })).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a request replayed a day later', async () => {
    const now = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    expect(await verify({ now })).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a request from too far in the future', async () => {
    // A clock skewed far ahead would otherwise widen the window indefinitely.
    const now = new Date(NOW.getTime() - (MAX_REQUEST_AGE_SECONDS + 1) * 1000);
    expect(await verify({ now })).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('malformed input', () => {
  it('rejects a missing signature header', async () => {
    const signed = await signSlackRequest(SECRET, BODY, NOW);
    const result = await verifySlackRequest({
      signingSecret: SECRET,
      signature: null,
      timestamp: signed.timestamp,
      body: BODY,
      now: NOW,
    });

    expect(result).toEqual({ ok: false, reason: 'missing-headers' });
  });

  it('rejects a missing timestamp header', async () => {
    const signed = await signSlackRequest(SECRET, BODY, NOW);
    const result = await verifySlackRequest({
      signingSecret: SECRET,
      signature: signed.signature,
      timestamp: null,
      body: BODY,
      now: NOW,
    });

    expect(result).toEqual({ ok: false, reason: 'missing-headers' });
  });

  it.each([
    ['empty', ''],
    ['non-numeric', 'yesterday'],
    ['fractional', '1759142400.5'],
  ])('rejects a %s timestamp', async (_label, timestamp) => {
    const result = await verify({ timestamp });
    expect(result.ok).toBe(false);
  });

  it.each([
    ['no version prefix', 'abc123'],
    ['wrong version', `v1=${'a'.repeat(64)}`],
    ['odd-length hex', 'v0=abc'],
    ['non-hex characters', `v0=${'z'.repeat(64)}`],
    ['empty after prefix', 'v0='],
  ])('rejects a signature with %s', async (_label, signature) => {
    const result = await verify({ signature });
    expect(result.ok).toBe(false);
    expect(result).not.toEqual({ ok: true });
  });

  it('rejects a signature of the wrong length rather than comparing a prefix', async () => {
    const signed = await signSlackRequest(SECRET, BODY, NOW);
    const truncated = signed.signature.slice(0, -2);

    expect(await verify({ signature: truncated })).toEqual({ ok: false, reason: 'bad-signature' });
  });
});
