/**
 * The parts of Narra's agent-runtime chat API the poller reads, with Penny's Narra agent
 * token. Shapes follow the backend's chat proxy (chat-proxy.controller.ts):
 *
 *   GET /api/agent-runtime/chat/rooms?conversation_type=all&include_members=true
 *     data: { agent: { matrix_user_id }, rooms: [{ room_id, conversation_type, title,
 *             member_count, members: [{ matrix_user_id, display_name }] }] }
 *   GET /api/agent-runtime/chat/messages?room_id&dir&from&limit
 *     data: { messages: [{ event_id, sender, origin_server_ts, type, content }],
 *             pagination: { next_batch, prev_batch } }
 *
 * Every response is wrapped in { command, status: "ok" | "error", data, issues }.
 * Rate limits are per agent token: 30 message reads and 60 room reads a minute.
 */

import { safeErrorText } from '../a2a';
import type { Env } from '../types';
import { NarraError } from './reply';

export interface NarraRoom {
  roomId: string;
  type: 'group' | 'dm';
  title: string;
  memberCount: number;
  /** Matrix user id → display name */
  names: Record<string, string>;
}

export interface NarraEvent {
  event_id: string;
  sender: string;
  origin_server_ts?: number;
  type: string;
  content: Record<string, unknown>;
}

export interface NarraApi {
  rooms(): Promise<{ agentId: string; rooms: NarraRoom[] }>;
  /** Newest event's position, to start reading from "now". */
  head(roomId: string): Promise<string | null>;
  /** Events after `from`, oldest first, and the cursor to continue from (null: nothing new). */
  after(roomId: string, from: string): Promise<{ events: NarraEvent[]; next: string | null }>;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function narraApi(env: Env): NarraApi {
  const token = (env.NARRA_AGENT_TOKEN ?? '').trim();
  const base = (env.NARRA_API_ENDPOINT ?? 'https://api.netmind.chat').replace(/\/+$/, '');

  async function get(path: string, query: Record<string, string>): Promise<Record<string, unknown>> {
    if (!token) throw new NarraError('NARRA_AGENT_TOKEN is not set.', false);
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let response: Response;
    try {
      response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new NarraError(`Narra unreachable: ${safeErrorText(error instanceof Error ? error.message : error)}`, true);
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !body || body.status !== 'ok') {
      const detail = safeErrorText(JSON.stringify(body?.issues ?? body ?? ''));
      throw new NarraError(`Narra ${path} failed: HTTP ${response.status} ${detail}`, response.status === 429 || response.status >= 500);
    }
    return (body.data ?? {}) as Record<string, unknown>;
  }

  return {
    async rooms() {
      const data = await get('/api/agent-runtime/chat/rooms', { conversation_type: 'all', include_members: 'true' });
      const agent = (data.agent ?? {}) as Record<string, unknown>;
      const rooms = Array.isArray(data.rooms) ? (data.rooms as Record<string, unknown>[]) : [];
      return {
        agentId: str(agent.matrix_user_id),
        rooms: rooms
          .filter((r) => str(r.room_id))
          .map((r) => {
            const names: Record<string, string> = {};
            for (const m of Array.isArray(r.members) ? (r.members as Record<string, unknown>[]) : []) {
              if (str(m.matrix_user_id)) names[str(m.matrix_user_id)] = str(m.display_name);
            }
            return {
              roomId: str(r.room_id),
              type: r.conversation_type === 'dm' ? 'dm' : 'group',
              title: str(r.title),
              memberCount: typeof r.member_count === 'number' ? r.member_count : 0,
              names,
            } satisfies NarraRoom;
          }),
      };
    },

    async head(roomId) {
      const data = await get('/api/agent-runtime/chat/messages', { room_id: roomId, dir: 'b', limit: '1' });
      const pagination = (data.pagination ?? {}) as Record<string, unknown>;
      // With dir=b, prev_batch is the token at the live end of the timeline.
      return str(pagination.prev_batch) || null;
    },

    async after(roomId, from) {
      const data = await get('/api/agent-runtime/chat/messages', { room_id: roomId, dir: 'f', from, limit: '50' });
      const pagination = (data.pagination ?? {}) as Record<string, unknown>;
      const events = Array.isArray(data.messages) ? (data.messages as NarraEvent[]) : [];
      return { events, next: str(pagination.next_batch) || null };
    },
  };
}
