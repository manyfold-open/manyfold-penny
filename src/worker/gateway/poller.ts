/**
 * Reads new messages from Narra and hands the ones worth a Penny turn to their room's queue.
 *
 * Narra only offers webhooks to agents that chose them when they were first bound, and
 * then only for @mentions, so the gateway reads instead: one Durable Object (NarraPoller)
 * wakes every few seconds and reads one room's new messages through the agent-runtime chat
 * API. Rooms with recent activity are read every few seconds, quiet ones every 20 seconds.
 *
 * Narra allows 30 message reads a minute per agent token, and Penny's own history reads
 * use the same allowance, so the poller makes at most one read per tick and ticks no
 * faster than TICK_MS (15 a minute), leaving the rest for Penny.
 *
 * The logic is `tick`, written against small interfaces so it runs in tests. The Durable
 * Object only wires it to storage, Narra and the room queues.
 */

import type { Env } from '../types';
import { classify, type Verdict } from './filter';
import { parseInbound, type InboundMessage } from './inbound';
import { narraApi, type NarraApi, type NarraRoom } from './narra-api';
import { NarraError } from './reply';
import type { Store } from './queue';
import { addSample, summarizeAll, type Samples } from './metrics';

export const TICK_MS = 4_000;
export const ACTIVE_EVERY_MS = 8_000;
export const IDLE_EVERY_MS = 20_000;
/** How long a room that Narra refused for good is left alone. */
const REFUSED_FOR_MS = 5 * 60_000;
const ACTIVE_FOR_MS = 15 * 60_000;
const ROOMS_EVERY_MS = 5 * 60_000;
const BACKOFF_MS = 30_000;

interface RoomsState {
  refreshedAt: number;
  agentId: string;
  rooms: NarraRoom[];
}

interface RoomState {
  cursor: string | null;
  nextPollAt: number;
  lastActivity: number;
}

export interface Sink {
  /** Names Penny answers to in this room, besides "Penny". */
  botNames(roomId: string): Promise<string[]>;
  deliver(message: InboundMessage, verdict: Verdict): Promise<void>;
  log(line: string): void;
  /** Seconds from a message being sent to the gateway reading it. */
  readLag?(seconds: number): void;
}

const roomKey = (id: string) => `room:${id}`;
const pennyKey = (id: string) => `penny:${id}`;
/** How many of Penny's own messages per room the poller keeps, to match replies and reactions. */
export const PENNY_REMEMBERS = 30;

interface PennyMessage {
  eventId: string;
  text: string;
}

/** One step. Returns how long to wait before the next one. */
export async function tick(store: Store, api: NarraApi, sink: Sink, now = Date.now()): Promise<number> {
  let state = await store.get<RoomsState>('rooms');
  if (!state || now - state.refreshedAt > ROOMS_EVERY_MS) {
    try {
      const { agentId, rooms } = await api.rooms();
      state = { refreshedAt: now, agentId, rooms };
      await store.put('rooms', state);
    } catch (error) {
      sink.log(`room list failed: ${(error as Error).message}`);
      if (!state) return BACKOFF_MS;
    }
  }

  // The room that is most overdue. New rooms start due now.
  let due: { room: NarraRoom; s: RoomState } | null = null;
  let soonest = Infinity;
  for (const room of state.rooms) {
    const s = (await store.get<RoomState>(roomKey(room.roomId))) ?? { cursor: null, nextPollAt: 0, lastActivity: 0 };
    if (s.nextPollAt <= now && (!due || s.nextPollAt < due.s.nextPollAt)) due = { room, s };
    soonest = Math.min(soonest, s.nextPollAt);
  }
  if (!due) return Math.max(TICK_MS, Math.min(soonest - now, IDLE_EVERY_MS));

  const { room, s } = due;
  try {
    if (!s.cursor) {
      // First sight of this room: start from now. Earlier messages stay in the history.
      s.cursor = await api.head(room.roomId);
      sink.log(`started reading ${room.roomId}${s.cursor ? '' : ' (no position yet)'}`);
      s.nextPollAt = now + ACTIVE_EVERY_MS;
    } else {
      const { events, next } = await api.after(room.roomId, s.cursor);
      const names = await sink.botNames(room.roomId);
      const mine = (await store.get<PennyMessage[]>(pennyKey(room.roomId))) ?? [];
      for (const event of events) {
        if (event.sender === state.agentId) {
          // Remember Penny's own recent messages, so a reply or 👍 to one reaches her. An edit
          // (her "one moment" note turned into the answer) updates the message it replaces.
          const relates = (event.content?.['m.relates_to'] ?? {}) as Record<string, unknown>;
          const replaced = relates.rel_type === 'm.replace' && typeof relates.event_id === 'string' ? relates.event_id : null;
          const newContent = (event.content?.['m.new_content'] ?? {}) as Record<string, unknown>;
          const body = typeof (replaced ? newContent.body : event.content?.body) === 'string' ? String(replaced ? newContent.body : event.content?.body) : '';
          const earlier = replaced ? mine.find((m) => m.eventId === replaced) : undefined;
          if (earlier) earlier.text = body.slice(0, 1000);
          else mine.push({ eventId: replaced ?? event.event_id, text: body.slice(0, 1000) });
          if (mine.length > PENNY_REMEMBERS) mine.splice(0, mine.length - PENNY_REMEMBERS);
          continue;
        }
        let message: InboundMessage | null = null;
        try {
          message = parseInbound({
            // The chat API leaves room_id off each event; it is the room we asked about.
            event: { ...event, room_id: room.roomId },
            room_name: room.title,
            chat_type: room.type,
            sender_name: room.names[event.sender] ?? '',
          });
        } catch {
          continue;
        }
        if (!message) continue;
        if (message.replyTo) {
          const hers = mine.find((m) => m.eventId === message.replyTo);
          if (hers) message.replyToPenny = hers.text;
        }
        s.lastActivity = now;
        const verdict = classify(message, { matrixId: state.agentId, names: ['Penny', ...names] });
        if (verdict !== 'skip') {
          await sink.deliver(message, verdict);
          sink.readLag?.((now - Date.parse(message.time)) / 1000);
          sink.log(`queued ${message.eventId} in ${room.roomId} (${verdict})`);
        }
      }
      await store.put(pennyKey(room.roomId), mine);
      if (events.length) sink.log(`read ${events.length} event(s) in ${room.roomId}`);
      if (next) s.cursor = next;
      s.nextPollAt = now + (now - s.lastActivity < ACTIVE_FOR_MS ? ACTIVE_EVERY_MS : IDLE_EVERY_MS);
    }
  } catch (error) {
    sink.log(`reading ${room.roomId} failed: ${(error as Error).message}`);
    s.nextPollAt = now + (error instanceof NarraError && !error.retryable ? REFUSED_FOR_MS : BACKOFF_MS);
  }
  await store.put(roomKey(room.roomId), s);
  return TICK_MS;
}

const LOG_LINES = 30;

/** Keep the last few log lines in storage, so /api/gateway/status can show them. */
export async function remember(storage: DurableObjectStorage, line: string): Promise<void> {
  const log = (await storage.get<string[]>('log')) ?? [];
  log.push(`${new Date().toISOString()} ${line}`);
  await storage.put('log', log.slice(-LOG_LINES));
}

export function gatewayEnabled(env: Env): boolean {
  return (
    (env.NARRA_GATEWAY ?? '').trim() === 'poll' &&
    Boolean((env.NARRA_AGENT_TOKEN ?? '').trim()) &&
    Boolean((env.PENNY_AGENT_ID ?? '').trim()) &&
    Boolean(env.NARRA_POLLER && env.ROOM_QUEUE)
  );
}

/** The single poller. Addressed as env.NARRA_POLLER.idFromName('narra'). */
export class NarraPoller {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private store(): Store {
    const s = this.state.storage;
    return {
      get: (key) => s.get(key),
      put: (key, value) => s.put(key, value),
      delete: (key) => s.delete(key),
      list: (options) => s.list(options),
    };
  }

  /** Called by the cron trigger: make sure the loop is running (or stopped, if switched off).
   *  GET .../status reports what the poller last did, for /api/gateway/status. */
  async fetch(request?: Request): Promise<Response> {
    if (request && new URL(request.url).pathname.endsWith('/status')) {
      const rooms = (await this.state.storage.get<RoomsState>('rooms')) ?? null;
      const perRoom: Record<string, unknown> = {};
      for (const room of rooms?.rooms ?? []) {
        const s = await this.state.storage.get<RoomState>(roomKey(room.roomId));
        perRoom[room.roomId] = {
          type: room.type,
          title: room.title,
          started: Boolean(s?.cursor),
          lastActivity: s?.lastActivity ? new Date(s.lastActivity).toISOString() : null,
          nextPollAt: s?.nextPollAt ? new Date(s.nextPollAt).toISOString() : null,
        };
      }
      return Response.json({
        enabled: gatewayEnabled(this.env),
        alarm: await this.state.storage.getAlarm(),
        lastTick: (await this.state.storage.get<number>('lastTick')) ?? null,
        roomsRefreshedAt: rooms ? new Date(rooms.refreshedAt).toISOString() : null,
        agentId: rooms?.agentId ?? null,
        rooms: perRoom,
        log: (await this.state.storage.get<string[]>('log')) ?? [],
        metrics: summarizeAll(await this.state.storage.get<Samples>('metrics')),
        /** Worst wait before a quiet room is read, from the room count: one read every TICK_MS. */
        worstQuietReadS: Math.max(IDLE_EVERY_MS, (rooms?.rooms.length ?? 0) * TICK_MS) / 1000,
      });
    }
    if (!gatewayEnabled(this.env)) {
      await this.state.storage.deleteAlarm();
      return Response.json({ running: false });
    }
    if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(Date.now());
    return Response.json({ running: true });
  }

  async alarm(): Promise<void> {
    if (!gatewayEnabled(this.env)) return;
    const env = this.env;
    const storage = this.state.storage;
    let writes: Promise<void> = Promise.resolve();
    const later = (write: () => Promise<void>) => {
      writes = writes.then(write).catch(() => undefined);
    };
    const delay = await tick(this.store(), narraApi(env), {
      async botNames(roomId) {
        const row = await env.DB.prepare('SELECT bot_name FROM ledger_groups WHERE id = ?').bind(roomId).first<{ bot_name: string }>();
        return row?.bot_name ? [row.bot_name] : [];
      },
      async deliver(message, verdict) {
        const queue = env.ROOM_QUEUE!.get(env.ROOM_QUEUE!.idFromName(message.roomId));
        await queue.fetch('https://room-queue/enqueue', {
          method: 'POST',
          body: JSON.stringify({ message, verdict, enqueuedAt: Date.now() }),
        });
      },
      log: (line) => {
        console.log(`[poller] ${line}`);
        later(() => remember(storage, line));
      },
      readLag: (seconds) => later(() => addSample(storage, 'readLagS', seconds)),
    });
    await writes;
    await this.state.storage.put('lastTick', Date.now());
    await this.state.storage.setAlarm(Date.now() + delay);
  }
}
