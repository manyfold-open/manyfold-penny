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
import { defuse } from './envelope';
import { classify, isNarraAgent, type Verdict } from './filter';
import { parseInbound, parseRedaction, type InboundMessage } from './inbound';
import { detectExplicitLang, detectLang, dominantLang, type DetectedLang } from './lang';
import { narraApi, type NarraApi, type NarraEvent, type NarraRoom } from './narra-api';
import { NarraError } from './reply';
import type { Store } from './queue';
import { addSample, summarizeAll, type Samples } from './metrics';
import { dailyFromLedger } from './daily';

export const TICK_MS = 4_000;
export const ACTIVE_EVERY_MS = 8_000;
export const IDLE_EVERY_MS = 20_000;
/** How long a room that Narra refused for good is left alone. */
const REFUSED_FOR_MS = 5 * 60_000;
const ACTIVE_FOR_MS = 15 * 60_000;
const ROOMS_EVERY_MS = 5 * 60_000;
const BACKOFF_MS = 30_000;
/** While /sync has reported within this long, it is the main reader... */
export const SYNC_FRESH_MS = 90_000;
/** ...and each room is read only this often, to catch what /sync may hold back. */
export const BACKSTOP_EVERY_MS = 60_000;
/** An entry waiting this long for its OK gets one reminder, the next time someone talks. */
export const PENDING_STALE_MS = 3 * 60 * 60_000;
/** At most one reminder per room in this long. */
export const NUDGE_EVERY_MS = 3 * 60 * 60_000;

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
  /** Whether this group has an expense or repayment waiting for someone's OK. */
  hasPending(roomId: string): Promise<boolean>;
  /** Entry numbers in this group that are still pending and were proposed before `before`
   *  (ISO time). Without it, Penny sends no reminders. */
  stalePending?(roomId: string, before: string): Promise<number[]>;
  /** Groups due their daily recap now (see daily.ts). Without it, Penny sends none. */
  dailyDue?(now: number): Promise<{ roomId: string; date: string }[]>;
  /** Whether the ledger already has this group. Without it, Penny sends no welcome. */
  knownGroup?(roomId: string): Promise<boolean>;
  deliver(message: InboundMessage, verdict: Verdict): Promise<void>;
  /** Notify the room's queue that an event was redacted so unposted copies can be dropped. */
  redact?(roomId: string, eventId: string): Promise<void>;
  /** Notify the room's queue that a newer non-agent human message arrived in the room. */
  humanActivity?(roomId: string, eventId: string): Promise<void>;
  log(line: string): void;
  /** Seconds from a message being sent to the gateway reading it. */
  readLag?(seconds: number): void;
}

const roomKey = (id: string) => `room:${id}`;
const nudgedKey = (id: string) => `nudged:${id}`;
const welcomedKey = (id: string) => `welcomed:${id}`;
const dailyKey = (id: string) => `daily:${id}`;
/** How often the poller asks the ledger which groups are due their daily recap. */
export const DAILY_CHECK_MS = 60_000;

interface Nudged {
  at: number;
  /** Entries already reminded about, so each gets one reminder. */
  seqs: number[];
}

/** A message nobody wrote: the gateway asking Penny to speak up in a group on her own. */
function nudgeMessage(
  room: NarraRoom,
  kind: 'pending' | 'welcome' | 'daily',
  now: number,
  about: (number | string)[] = [],
  detectedLang?: DetectedLang,
): InboundMessage {
  return {
    roomId: room.roomId,
    roomName: room.title,
    chatType: 'group',
    // Derived from what it is about, so the same nudge cannot be queued or billed twice.
    eventId: `nudge:${kind}:${room.roomId}${about.length ? `:${about.join(',')}` : ''}`,
    senderId: '',
    senderName: '',
    text: `[penny nudge] ${kind}${about.map((a) => (typeof a === 'number' ? ` #${a}` : ` ${a}`)).join('')}`,
    time: new Date(now).toISOString(),
    mentions: [],
    nudge: kind,
    ...(detectedLang ? { detectedLang } : {}),
  };
}

/**
 * Someone talked in a group, and Penny was not asked anything. If an entry there has waited
 * hours for its OK, have Penny remind the group once. Tied to someone talking, so she never
 * posts into a quiet chat, and people are there to read it.
 */
async function remindPending(store: Store, sink: Sink, room: NarraRoom, now: number): Promise<void> {
  if (!sink.stalePending) return;
  const nudged = (await store.get<Nudged>(nudgedKey(room.roomId))) ?? { at: 0, seqs: [] };
  if (now - nudged.at < NUDGE_EVERY_MS) return;
  const seqs = (await sink.stalePending(room.roomId, new Date(now - PENDING_STALE_MS).toISOString())).filter(
    (n) => !nudged.seqs.includes(n),
  );
  if (seqs.length === 0) return;
  const roomLang = (await store.get<RoomLangState>(roomLangKey(room.roomId)))?.dominant;
  await sink.deliver(nudgeMessage(room, 'pending', now, seqs, roomLang), 'nudge');
  await store.put(nudgedKey(room.roomId), { at: now, seqs: [...nudged.seqs, ...seqs].slice(-200) } satisfies Nudged);
  sink.log(`reminding ${room.roomId} of pending ${seqs.map((n) => `#${n}`).join(' ')}`);
}
const pennyKey = (id: string) => `penny:${id}`;
const recentKey = (id: string) => `recent:${id}`;
const redactedKey = (id: string) => `redacted:${id}`;
const latestKey = (id: string) => `latest:${id}`;
const userLangKey = (roomId: string, senderId: string) => `userLang:${roomId}:${senderId}`;
const roomLangKey = (id: string) => `roomLang:${id}`;
/** How many of Penny's own messages per room the poller keeps, to match replies and reactions. */
export const PENNY_REMEMBERS = 30;
/** How many recent human/non-Penny messages per room the poller keeps for reply context. */
export const RECENT_REMEMBERS = 30;
const REDACTED_REMEMBERS = 200;
const ROOM_LANG_REMEMBERS = 30;

interface PennyMessage {
  eventId: string;
  text: string;
}

interface RecentMessage {
  eventId: string;
  senderId: string;
  senderName: string;
  text: string;
}

interface RoomLangState {
  recent: DetectedLang[];
  dominant: DetectedLang;
}

const cleanLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

function isReplaceEdit(event: NarraEvent): boolean {
  const relates = (event.content?.['m.relates_to'] ?? {}) as Record<string, unknown>;
  return relates.rel_type === 'm.replace';
}

function isHiddenCompoundHint(event: NarraEvent): boolean {
  const hint = event.content?.['ai.netmind.hint'] as { kind?: string } | undefined;
  const visibility = event.content?.['ai.netmind.visibility'] as { status?: string } | undefined;
  return hint?.kind === 'compound_trigger' && visibility?.status === 'hidden';
}

function isHumanMessageEvent(event: NarraEvent, agentId: string, redactedSet: Set<string>): boolean {
  if (redactedSet.has(event.event_id)) return false;
  if (event.sender === agentId || isNarraAgent(event.sender) || !event.sender.startsWith('@')) return false;
  if (event.type && event.type !== 'm.room.message') return false;
  if (isReplaceEdit(event) || isHiddenCompoundHint(event)) return false;
  const msgtype = typeof event.content?.msgtype === 'string' ? event.content.msgtype : '';
  if (msgtype && msgtype !== 'm.text' && msgtype !== 'm.notice' && msgtype !== 'm.image' && msgtype !== 'm.file' && msgtype !== 'm.video' && msgtype !== 'm.audio') {
    return false;
  }
  if ((!msgtype || msgtype === 'm.text' || msgtype === 'm.notice') && typeof event.content?.body === 'string' && !event.content.body.trim()) {
    return false;
  }
  return true;
}

const handledKey = (id: string) => `handled:${id}`;
/** Event ids per room already handled, so a message that both /sync and the backstop read is
 *  handled once. Comfortably more than one read returns (50). */
const HANDLED_REMEMBERS = 300;

/**
 * Handle new events of one room, from either reader: remember Penny's own messages, sort the
 * rest, queue what Penny should answer, and remind of waiting OKs. Returns whether anyone
 * other than Penny wrote something.
 */
export async function handleEvents(
  store: Store,
  sink: Sink,
  room: NarraRoom,
  agentId: string,
  events: NarraEvent[],
  now: number,
): Promise<boolean> {
  const handled = (await store.get<string[]>(handledKey(room.roomId))) ?? [];
  const fresh = events.filter((e) => e.event_id && !handled.includes(e.event_id));
  if (fresh.length === 0) return false;
  await store.put(handledKey(room.roomId), [...handled, ...fresh.map((e) => e.event_id)].slice(-HANDLED_REMEMBERS));

  const names = await sink.botNames(room.roomId);
  const mine = (await store.get<PennyMessage[]>(pennyKey(room.roomId))) ?? [];
  const recent = (await store.get<RecentMessage[]>(recentKey(room.roomId))) ?? [];
  const redacted = (await store.get<string[]>(redactedKey(room.roomId))) ?? [];
  let latestEventId = await store.get<string>(latestKey(room.roomId));
  let roomLangState = await store.get<RoomLangState>(roomLangKey(room.roomId));
  let roomLangDirty = false;
  const userLangCache = new Map<string, DetectedLang | undefined>();

  // Record redactions first so any same-batch or queued message matching them is dropped cleanly.
  let redactedDirty = false;
  let activity = false;
  for (const event of fresh) {
    const r = parseRedaction({ event: { ...event, room_id: room.roomId } });
    if (!r) continue;
    if (r.senderId !== agentId && !isNarraAgent(r.senderId)) activity = true;
    if (!redacted.includes(r.redacts)) {
      redacted.push(r.redacts);
      redactedDirty = true;
    }
    const recentIdx = recent.findIndex((m) => m.eventId === r.redacts);
    if (recentIdx !== -1) recent.splice(recentIdx, 1);
    const mineIdx = mine.findIndex((m) => m.eventId === r.redacts);
    if (mineIdx !== -1) mine.splice(mineIdx, 1);
    if (latestEventId === r.redacts) latestEventId = recent.at(-1)?.eventId;
    await sink.redact?.(room.roomId, r.redacts);
  }
  if (redactedDirty) {
    await store.put(redactedKey(room.roomId), redacted.slice(-REDACTED_REMEMBERS));
  }
  const redactedSet = new Set(redacted);

  // Other Narra agents in the room. With them around, Narra refuses a 7th agent message in a row
  // (see queue.ts), so Penny posts her note at once to hold her place.
  const crowded = room.type === 'group' && Object.keys(room.names).some((id) => id !== agentId && isNarraAgent(id));
  // Whether a person spoke without asking Penny anything, and whether Penny already has
  // something to answer here: a reminder is only for the first case without the second.
  let personSpoke = false;
  let answering = false;
  let latestHumanInBatch: string | undefined;

  for (let i = 0; i < fresh.length; i++) {
    const event = fresh[i];
    if (event.sender === agentId) {
      // Remember Penny's own recent messages, so a reply or 👍 to one reaches her. An edit
      // (her "one moment" note turned into the answer) updates the message it replaces.
      const relates = (event.content?.['m.relates_to'] ?? {}) as Record<string, unknown>;
      const replaced = relates.rel_type === 'm.replace' && typeof relates.event_id === 'string' ? relates.event_id : null;
      const newContent = (event.content?.['m.new_content'] ?? {}) as Record<string, unknown>;
      const body = typeof (replaced ? newContent.body : event.content?.body) === 'string' ? String(replaced ? newContent.body : event.content?.body) : '';
      const earlier = mine.find((m) => m.eventId === (replaced ?? event.event_id));
      if (earlier) earlier.text = body.slice(0, 1000);
      else mine.push({ eventId: replaced ?? event.event_id, text: body.slice(0, 1000) });
      if (mine.length > PENNY_REMEMBERS) mine.splice(0, mine.length - PENNY_REMEMBERS);
      if (!replaced && !redactedSet.has(event.event_id)) latestEventId = event.event_id;
      continue;
    }
    if (event.type === 'm.room.redaction' || redactedSet.has(event.event_id)) continue;

    let message: InboundMessage | null = null;
    try {
      message = parseInbound({
        // Neither reader puts room_id on each event; it is the room they were read from.
        event: { ...event, room_id: room.roomId },
        room_name: room.title,
        chat_type: room.type,
        sender_name: room.names[event.sender] ?? '',
      });
    } catch {
      continue;
    }
    if (!message) continue;
    // Narra sends a separate hidden hint for native mentions on captioned photos.
    // Keep that path for addressed compounds so the same photo is processed once.
    if (event.content?.msgtype === 'ai.netmind.compound' && message.mentions.length > 0) continue;
    const compoundHint = isHiddenCompoundHint(event);
    if (compoundHint && !message.mentions.includes(agentId)) continue;
    activity = true;
    // Never quote, record, or pass on other @agent-* messages.
    if (isNarraAgent(message.senderId)) continue;

    if (crowded) message.crowded = true;
    if (message.replyTo) {
      const hers = mine.find((m) => m.eventId === message.replyTo);
      if (hers) {
        message.replyToPenny = hers.text;
      } else if (message.kind !== 'reaction') {
        const other = recent.find((r) => r.eventId === message.replyTo);
        if (other) {
          const sender = cleanLine(other.senderName || other.senderId).slice(0, 80);
          const snippet = cleanLine(defuse(other.text)).slice(0, 300);
          message.replyToOther = `${sender}: ${snippet}`;
        }
      }
    }

    if (!userLangCache.has(message.senderId)) {
      userLangCache.set(message.senderId, await store.get<DetectedLang>(userLangKey(room.roomId, message.senderId)));
    }
    const userHistoryLang = userLangCache.get(message.senderId);
    const roomHistoryLang = roomLangState?.dominant;
    if (message.kind === 'reaction') {
      message.detectedLang = userHistoryLang ?? roomHistoryLang ?? 'zh-Hant';
    } else {
      const detected = detectLang(message.text, userHistoryLang, roomHistoryLang);
      message.detectedLang = detected;
      if (detectExplicitLang(message.text) !== null) {
        userLangCache.set(message.senderId, detected);
        await store.put(userLangKey(room.roomId, message.senderId), detected);
        const nextRecent = [...(roomLangState?.recent ?? []), detected].slice(-ROOM_LANG_REMEMBERS);
        roomLangState = { recent: nextRecent, dominant: dominantLang(nextRecent, roomLangState?.dominant) };
        roomLangDirty = true;
      }
    }

    if (message.chatType === 'group' && message.kind !== 'reaction') {
      const hasNewerHumanInBatch = fresh.slice(i + 1).some((later) => isHumanMessageEvent(later, agentId, redactedSet));
      const repliesToOlder = Boolean(message.replyTo && latestEventId && message.replyTo !== latestEventId);
      message.shouldQuote = hasNewerHumanInBatch || repliesToOlder;
    }

    if (message.kind !== 'reaction' && !compoundHint) {
      if (isReplaceEdit(event)) {
        const relates = (event.content?.['m.relates_to'] ?? {}) as Record<string, unknown>;
        const target = typeof relates.event_id === 'string' ? relates.event_id : '';
        const earlier = recent.find((r) => r.eventId === target);
        if (earlier) earlier.text = message.text.slice(0, 1000);
      } else {
        recent.push({
          eventId: message.eventId,
          senderId: message.senderId,
          senderName: message.senderName,
          text: message.text.slice(0, 1000),
        });
        if (recent.length > RECENT_REMEMBERS) recent.splice(0, recent.length - RECENT_REMEMBERS);
        latestEventId = message.eventId;
        latestHumanInBatch = message.eventId;
      }
    }

    const classified = classify(message, { matrixId: agentId, names: ['Penny', ...names] });
    // A bare "好" or "OK" is an answer to Penny only while she is waiting for one.
    const verdict: Verdict = classified === 'answer' ? ((await sink.hasPending(room.roomId)) ? 'called' : 'skip') : classified;
    if (verdict === 'skip' && message.chatType === 'group' && message.kind !== 'reaction' && !isNarraAgent(message.senderId)) {
      personSpoke = true;
    }
    if (verdict !== 'skip') {
      answering = true;
      await sink.deliver(message, verdict);
      sink.readLag?.((now - Date.parse(message.time)) / 1000);
      sink.log(`queued ${message.eventId} in ${room.roomId} (${verdict})`);
    }
  }
  await store.put(pennyKey(room.roomId), mine);
  await store.put(recentKey(room.roomId), recent);
  if (latestEventId) await store.put(latestKey(room.roomId), latestEventId);
  if (roomLangDirty && roomLangState) await store.put(roomLangKey(room.roomId), roomLangState);
  if (latestHumanInBatch) await sink.humanActivity?.(room.roomId, latestHumanInBatch);
  if (personSpoke && !answering && room.type === 'group') await remindPending(store, sink, room, now);
  return activity;
}

/** How long until a room is read again. While /sync is delivering, reading is only a backstop. */
async function nextReadIn(store: Store, s: RoomState, now: number): Promise<number> {
  const syncAt = (await store.get<number>('syncAt')) ?? 0;
  if (now - syncAt < SYNC_FRESH_MS) return BACKSTOP_EVERY_MS;
  return now - s.lastActivity < ACTIVE_FOR_MS ? ACTIVE_EVERY_MS : IDLE_EVERY_MS;
}

export interface SyncedRoom {
  roomId: string;
  events: NarraEvent[];
  /** /sync left events out (a gap): the backstop reads the room right away. */
  limited?: boolean;
}

/**
 * New events from Matrix /sync (see sync.ts). Rooms the poller has not started yet are left
 * to it: it starts each room from "now" and welcomes new groups.
 */
export async function ingest(store: Store, sink: Sink, rooms: SyncedRoom[], now = Date.now()): Promise<void> {
  await store.put('syncAt', now);
  const state = await store.get<RoomsState>('rooms');
  if (!state) return;
  for (const synced of rooms) {
    const room = state.rooms.find((r) => r.roomId === synced.roomId);
    const s = await store.get<RoomState>(roomKey(synced.roomId));
    if (!room || !s?.cursor) continue;
    if (await handleEvents(store, sink, room, state.agentId, synced.events, now)) s.lastActivity = now;
    if (synced.limited) s.nextPollAt = now;
    await store.put(roomKey(synced.roomId), s);
  }
}

/** Once a minute: queue the daily recap for each group that is due it and has not had today's. */
async function sendDaily(store: Store, sink: Sink, rooms: NarraRoom[], now: number): Promise<void> {
  if (!sink.dailyDue || now - ((await store.get<number>('dailyAt')) ?? 0) < DAILY_CHECK_MS) return;
  await store.put('dailyAt', now);
  let due: { roomId: string; date: string }[];
  try {
    due = await sink.dailyDue(now);
  } catch (error) {
    sink.log(`daily check failed: ${(error as Error).message}`);
    return;
  }
  for (const { roomId, date } of due) {
    const room = rooms.find((r) => r.roomId === roomId && r.type === 'group');
    if (!room || (await store.get<string>(dailyKey(roomId))) === date) continue;
    const roomLang = (await store.get<RoomLangState>(roomLangKey(roomId)))?.dominant;
    await sink.deliver(nudgeMessage(room, 'daily', now, [date], roomLang), 'nudge');
    await store.put(dailyKey(roomId), date);
    sink.log(`daily recap for ${roomId} (${date})`);
  }
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

  await sendDaily(store, sink, state.rooms, now);

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
      // Penny was just added to a group the ledger does not know: say hello without waiting
      // for someone to call her.
      if (room.type === 'group' && sink.knownGroup && !(await store.get(welcomedKey(room.roomId))) && !(await sink.knownGroup(room.roomId))) {
        await sink.deliver(nudgeMessage(room, 'welcome', now), 'nudge');
        await store.put(welcomedKey(room.roomId), now);
        sink.log(`welcoming ${room.roomId}`);
      }
    } else {
      const { events, next } = await api.after(room.roomId, s.cursor);
      if (await handleEvents(store, sink, room, state.agentId, events, now)) s.lastActivity = now;
      if (events.length) sink.log(`read ${events.length} event(s) in ${room.roomId}`);
      if (next) s.cursor = next;
      s.nextPollAt = now + (await nextReadIn(store, s, now));
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
    const path = request ? new URL(request.url).pathname : '';
    if (request?.method === 'POST' && path.endsWith('/events')) {
      // A batch from MatrixSync. One at a time, so two batches never interleave.
      const body = (await request.json().catch(() => null)) as { rooms?: SyncedRoom[] } | null;
      if (!body || !Array.isArray(body.rooms)) return new Response('bad batch', { status: 400 });
      await this.state.blockConcurrencyWhile(async () => {
        const { sink, flush } = this.sink();
        await ingest(this.store(), sink, body.rooms!);
        await flush();
      });
      return Response.json({ ok: true });
    }
    if (request?.method === 'POST' && path.endsWith('/log')) {
      const body = (await request.json().catch(() => null)) as { line?: unknown } | null;
      if (typeof body?.line === 'string') await remember(this.state.storage, body.line.slice(0, 500));
      return Response.json({ ok: true });
    }
    if (request && path.endsWith('/status')) {
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

  /** What tick and ingest call out to. Log lines and timings are written after the step, in order. */
  private sink(): { sink: Sink; flush: () => Promise<void> } {
    const env = this.env;
    const storage = this.state.storage;
    let writes: Promise<void> = Promise.resolve();
    const later = (write: () => Promise<void>) => {
      writes = writes.then(write).catch(() => undefined);
    };
    const sink: Sink = {
      async hasPending(roomId) {
        const row = await env.DB.prepare(
          "SELECT 1 AS p FROM ledger_expenses WHERE group_id = ? AND status = 'pending' UNION ALL SELECT 1 FROM ledger_settlements WHERE group_id = ? AND status = 'pending' LIMIT 1",
        )
          .bind(roomId, roomId)
          .first<{ p: number }>();
        return Boolean(row);
      },
      async stalePending(roomId, before) {
        const { results } = await env.DB.prepare(
          "SELECT seq FROM ledger_expenses WHERE group_id = ? AND status = 'pending' AND created_at <= ? UNION SELECT seq FROM ledger_settlements WHERE group_id = ? AND status = 'pending' AND created_at <= ? ORDER BY seq LIMIT 20",
        )
          .bind(roomId, before, roomId, before)
          .all<{ seq: number }>();
        return results.map((r) => r.seq);
      },
      dailyDue: (now) => dailyFromLedger(env, now),
      async knownGroup(roomId) {
        return Boolean(await env.DB.prepare('SELECT 1 AS g FROM ledger_groups WHERE id = ?').bind(roomId).first());
      },
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
      async redact(roomId, eventId) {
        const queue = env.ROOM_QUEUE!.get(env.ROOM_QUEUE!.idFromName(roomId));
        await queue.fetch('https://room-queue/redact', {
          method: 'POST',
          body: JSON.stringify({ eventId }),
        });
      },
      async humanActivity(roomId, eventId) {
        const queue = env.ROOM_QUEUE!.get(env.ROOM_QUEUE!.idFromName(roomId));
        await queue.fetch('https://room-queue/human-event', {
          method: 'POST',
          body: JSON.stringify({ eventId }),
        });
      },
      log: (line) => {
        console.log(`[poller] ${line}`);
        later(() => remember(storage, line));
      },
      readLag: (seconds) => later(() => addSample(storage, 'readLagS', seconds)),
    };
    return { sink, flush: () => writes };
  }

  async alarm(): Promise<void> {
    if (!gatewayEnabled(this.env)) return;
    const { sink, flush } = this.sink();
    const delay = await tick(this.store(), narraApi(this.env), sink);
    await flush();
    await this.state.storage.put('lastTick', Date.now());
    await this.state.storage.setAlarm(Date.now() + delay);
  }
}
