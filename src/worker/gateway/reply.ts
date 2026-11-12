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

/** Post Penny's answer into the room. txn_id is derived from the event, so a retry never posts twice. */
export async function postToRoom(env: Env, roomId: string, text: string, eventId: string): Promise<void> {
  const token = (env.NARRA_AGENT_TOKEN ?? '').trim();
  if (!token) throw new NarraError('NARRA_AGENT_TOKEN is not set.', false);
  const endpoint = (env.NARRA_API_ENDPOINT ?? 'https://api.netmind.chat').replace(/\/+$/, '');
  let response: Response;
  try {
    response = await fetch(`${endpoint}/api/agent-runtime/chat/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ room_id: roomId, text, txn_id: await txnId(eventId) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new NarraError(`Narra unreachable: ${safeErrorText(error instanceof Error ? error.message : error)}`, true);
  }
  if (!response.ok) {
    const detail = safeErrorText(await response.text());
    throw new NarraError(`Narra send failed: HTTP ${response.status}${detail ? ` · ${detail}` : ''}`, response.status === 429 || response.status >= 500);
  }
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
