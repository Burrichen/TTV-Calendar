/**
 * Produces the signature Slack would send, so tests can exercise the real verification
 * path rather than stubbing it out.
 *
 * Deliberately an independent implementation of Slack's documented procedure — if it
 * merely called the same helper the Worker uses, a bug in that helper would cancel
 * itself out and every test would still pass.
 */

export interface SignedRequest {
  readonly body: string;
  readonly signature: string;
  readonly timestamp: string;
}

/** `v0=` + hex(HMAC_SHA256(secret, "v0:" + timestamp + ":" + body)). */
export async function signSlackRequest(
  secret: string,
  body: string,
  at: Date,
): Promise<SignedRequest> {
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`v0:${timestamp}:${body}`));
  const hex = [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

  return { body, signature: `v0=${hex}`, timestamp };
}

/** Encodes a block_actions payload the way Slack posts it: form-encoded, not JSON. */
export const encodePayload = (payload: unknown): string =>
  new URLSearchParams({ payload: JSON.stringify(payload) }).toString();

export interface ButtonClickOptions {
  readonly actionId: string;
  readonly userId: string;
  readonly channelId?: string | null;
  readonly teamId?: string | null;
  readonly type?: string;
}

/** A minimal but realistic `block_actions` payload. */
export function buttonClick(options: ButtonClickOptions): Record<string, unknown> {
  return {
    type: options.type ?? 'block_actions',
    team: options.teamId === null ? null : { id: options.teamId ?? 'T_WORKSPACE' },
    user: { id: options.userId, username: 'tester' },
    channel: options.channelId === null ? null : { id: options.channelId ?? 'C_TENNIS' },
    trigger_id: '123.456.abc',
    actions: [{ action_id: options.actionId, type: 'button', value: 'x' }],
  };
}
