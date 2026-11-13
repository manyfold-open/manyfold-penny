/**
 * The two outside calls one queued message needs: a Penny turn over A2A, and posting her
 * answer into the Narra room.
 */

import { A2AError, consumeA2AStream, safeErrorText } from '../a2a';
import { credentialFor } from '../connect';
import type { Env } from '../types';

const TURN_TIMEOUT_MS = 5 * 60_000;

/**
 * One Penny turn in a fresh A2A context: no contextId, so nothing from earlier messages
 * or other rooms rides along. Penny keeps nothing between messages anyway (the ledger and
 * the room's history hold everything). messageId comes from the Matrix event id, so a
 * retried delivery of the same message cannot bill a second turn.
 */
export async function runPennyTurn(env: Env, text: string, eventId: string): Promise<string> {
  const agentId = (env.PENNY_AGENT_ID ?? '').trim();
  if (!agentId) throw new A2AError('PENNY_AGENT_ID is not set.', false);
  const cred = await credentialFor(env, agentId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  try {
    const snapshot = await consumeA2AStream({
      cred,
      signal: controller.signal,
      params: {
        message: {
          kind: 'message',
          role: 'user',
          messageId: `penny-gw-${await shortHash(eventId)}`,
          parts: [{ kind: 'text', text }],
        },
        configuration: { acceptedOutputModes: ['text/plain'] },
      },
    });
    if (snapshot.state && !['completed', 'input-required'].includes(snapshot.state)) {
      throw new A2AError(`Penny stopped at "${snapshot.state}".`, snapshot.state !== 'rejected');
    }
    return snapshot.text.trim();
  } finally {
    clearTimeout(timer);
  }
}

export class NarraError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'NarraError';
    this.retryable = retryable;
  }
}

async function narraPost(env: Env, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = (env.NARRA_AGENT_TOKEN ?? '').trim();
  if (!token) throw new NarraError('NARRA_AGENT_TOKEN is not set.', false);
  const endpoint = (env.NARRA_API_ENDPOINT ?? 'https://api.netmind.chat').replace(/\/+$/, '');
  let response: Response;
  try {
    response = await fetch(`${endpoint}/api/agent-runtime/chat/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new NarraError(`Narra unreachable: ${safeErrorText(error instanceof Error ? error.message : error)}`, true);
  }
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !parsed || parsed.status !== 'ok') {
    const detail = safeErrorText(JSON.stringify(parsed?.issues ?? parsed ?? ''));
    throw new NarraError(`Narra ${path} failed: HTTP ${response.status}${detail ? ` · ${detail}` : ''}`, response.status === 429 || response.status >= 500);
  }
  return (parsed.data ?? {}) as Record<string, unknown>;
}

/** Post a message into the room and return its event id. txn_id is derived from `key`, so a
 *  retry never posts twice. */
export async function postToRoom(env: Env, roomId: string, text: string, key: string): Promise<string> {
  const data = await narraPost(env, 'send', { room_id: roomId, text, txn_id: await txnId(key) });
  return typeof data.event_id === 'string' ? data.event_id : '';
}

/** Replace the text of one of Penny's own messages (her "one moment" note becomes the answer). */
export async function patchInRoom(env: Env, roomId: string, messageId: string, text: string, key: string): Promise<void> {
  await narraPost(env, 'messages/patch', { room_id: roomId, message_id: messageId, content: text, txn_id: await txnId(key) });
}

/** Delete one of Penny's own messages (her "one moment" note, when she ends up saying nothing). */
export async function deleteInRoom(env: Env, roomId: string, messageId: string, key: string): Promise<void> {
  await narraPost(env, 'messages/delete', { room_id: roomId, message_id: messageId, txn_id: await txnId(key) });
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function shortHash(value: string): Promise<string> {
  return [...(await digest(value)).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A UUID v4-shaped id that is the same for the same event, for Narra's txn_id. */
export async function txnId(eventId: string): Promise<string> {
  const b = (await digest(`penny-gw:${eventId}`)).slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
