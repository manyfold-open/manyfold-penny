/**
 * One queue per chat room, as a Durable Object.
 *
 * The poller hands each message to its room's queue and moves on at once, so reading Narra
 * never waits on Penny. The queue then works through its messages in order, one Penny
 * turn at a time, from an alarm (which may run for minutes, unlike work after a response).
 * Rooms have separate queues, so different groups are served in parallel, while the
 * messages of one group never overtake each other: "OK" is never handled before the
 * proposal it answers.
 *
 * The queueing logic is `drain`, written against a small Store interface so it can be
 * tested without the Workers runtime. `RoomQueue` only wires it to Durable Object storage.
 */

import type { Env } from '../types';
import { pennyDeps } from './deps';
import type { InboundMessage } from './inbound';
import type { Verdict } from './filter';
import { remember } from './poller';
import { addSample, summarizeAll, type Samples } from './metrics';

export interface QueuedMessage {
  message: InboundMessage;
  verdict: Verdict;
  attempts: number;
  enqueuedAt: number;
  /** Event id of Penny's "one moment" note for this message, once it is posted. */
  ackId?: string;
}

export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>;
}

export interface Deps {
  /** Run a Penny turn for one message, return her answer ('' means stay silent). */
  turn(item: QueuedMessage): Promise<string>;
  /** Post an answer into the room. */
  post(item: QueuedMessage, text: string): Promise<void>;
  /** Post a short "one moment" note at once, so nobody waits in silence. Returns its event id. */
  ack?(item: QueuedMessage): Promise<string>;
  /** Turn the note into the answer. */
  patch?(item: QueuedMessage, ackId: string, text: string): Promise<void>;
  /** Remove the note when Penny says nothing. */
  remove?(item: QueuedMessage, ackId: string): Promise<void>;
  /** Whether an error is worth another try. */
  retryable(error: unknown): boolean;
  /** A timing sample in seconds: waitS (queued → turn starts), turnS (Penny's turn), answerS
   *  (message sent → answer posted). */
  timing?(name: 'waitS' | 'turnS' | 'answerS', seconds: number): void;
  log(line: string): void;
}

export const MAX_ATTEMPTS = 3;
/** A message waiting longer than this is dropped: answering it now would only confuse. */
export const MAX_AGE_MS = 30 * 60_000;
const SEEN_TTL_MS = 24 * 60 * 60_000;
const MAX_QUEUE = 200;

const pad = (n: number) => String(n).padStart(16, '0');

/** Answers that mean "say nothing". Posting them would only put noise in the chat. */
const SILENCE = /^\s*(?:\(empty response\)|no response(?: requested)?\.?|\[no reply\]|\.{0,3})\s*$/i;
export const isSilence = (answer: string) => SILENCE.test(answer);

/** Penny's "one moment" note, and what it becomes if her turn fails for good. In the
 *  speaker's script when the message shows it; Chinese otherwise. */
export function noteText(item: Pick<QueuedMessage, 'message'>, kind: 'working' | 'failed'): string {
  const text = item.message.text;
  const english = /[a-z]{3}/i.test(text) && !/[\u3400-\u9fff]/.test(text);
  const simplified = /[这们说帐账还么为]/.test(text);
  if (kind === 'working') return english ? '🐶 One moment, checking…' : simplified ? '🐶 我看一下账本…' : '🐶 我看一下帳本…';
  return english ? '🐶 Sorry, I got stuck on that one. Please try again.' : simplified ? '🐶 刚刚卡住了，请再说一次。' : '🐶 剛剛卡住了，請再說一次。';
}

/** Add a message unless this event was seen already (Narra may deliver twice). */
export async function enqueue(store: Store, item: Omit<QueuedMessage, 'attempts'>): Promise<'queued' | 'duplicate' | 'full'> {
  const seenKey = `seen:${item.message.eventId}`;
  const seen = await store.get<number>(seenKey);
  if (seen && Date.now() - seen < SEEN_TTL_MS) return 'duplicate';
  if ((await store.list({ prefix: 'q:', limit: MAX_QUEUE })).size >= MAX_QUEUE) return 'full';
  const next = ((await store.get<number>('next')) ?? 0) + 1;
  await store.put('next', next);
  await store.put(`q:${pad(next)}`, { ...item, attempts: 0 } satisfies QueuedMessage);
  await store.put(seenKey, Date.now());
  return 'queued';
}

/**
 * Work through the queue in order. Returns the delay before the next run if a message
 * should be retried later, or null when the queue is empty.
 */
export async function drain(store: Store, deps: Deps, budgetMs = 10 * 60_000): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    const [entry] = await store.list<QueuedMessage>({ prefix: 'q:', limit: 1 });
    if (!entry) break;
    const [key, item] = entry;
    if (Date.now() - item.enqueuedAt > MAX_AGE_MS) {
      deps.log(`dropped stale message ${item.message.eventId}`);
      await store.delete(key);
      continue;
    }
    const startedAt = Date.now();
    if (item.attempts === 0) deps.timing?.('waitS', (startedAt - item.enqueuedAt) / 1000);
    try {
      // Someone talked to Penny directly: show that she is on it before her turn starts.
      if (item.verdict === 'called' && !item.ackId && deps.ack) {
        try {
          const ackId = await deps.ack(item);
          if (ackId) {
            item.ackId = ackId;
            await store.put(key, item);
          }
        } catch (error) {
          deps.log(`could not post the note for ${item.message.eventId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const turnStarted = Date.now();
      const answer = await deps.turn(item);
      deps.timing?.('turnS', (Date.now() - turnStarted) / 1000);
      const posted = Boolean(answer) && !isSilence(answer);
      if (posted && item.ackId && deps.patch) {
        try {
          await deps.patch(item, item.ackId, answer);
        } catch (error) {
          deps.log(`could not edit the note for ${item.message.eventId}, posting instead: ${error instanceof Error ? error.message : String(error)}`);
          await deps.post(item, answer);
        }
      } else if (posted) {
        await deps.post(item, answer);
      } else if (item.ackId && deps.remove) {
        await deps.remove(item, item.ackId).catch(() => undefined);
      }
      deps.log(`answered ${item.message.eventId} (${posted ? 'posted' : 'silent'})`);
      if (posted) deps.timing?.('answerS', (Date.now() - Date.parse(item.message.time)) / 1000);
      await store.delete(key);
    } catch (error) {
      const attempts = item.attempts + 1;
      const message = error instanceof Error ? error.message : String(error);
      if (attempts >= MAX_ATTEMPTS || !deps.retryable(error)) {
        deps.log(`gave up on ${item.message.eventId} after ${attempts} attempt(s): ${message}`);
        if (item.ackId && deps.patch) {
          await deps.patch(item, item.ackId, noteText(item, 'failed')).catch(() => undefined);
        }
        await store.delete(key);
        continue;
      }
      deps.log(`retrying ${item.message.eventId} (attempt ${attempts}): ${message}`);
      await store.put(key, { ...item, attempts });
      // Hold the whole room: the next message may depend on this one.
      return 5_000 * 2 ** (attempts - 1);
    }
  }
  const [left] = await store.list({ prefix: 'q:', limit: 1 });
  return left ? 0 : null;
}

/** The Durable Object. Addressed by room id: env.ROOM_QUEUE.idFromName(roomId). */
export class RoomQueue {
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

  async fetch(request: Request): Promise<Response> {
    if (request.method === 'GET') {
      const queued = await this.state.storage.list({ prefix: 'q:', limit: 200 });
      return Response.json({
        queued: queued.size,
        alarm: await this.state.storage.getAlarm(),
        log: (await this.state.storage.get<string[]>('log')) ?? [],
        metrics: summarizeAll(await this.state.storage.get<Samples>('metrics')),
      });
    }
    const item = (await request.json()) as Omit<QueuedMessage, 'attempts'>;
    const result = await enqueue(this.store(), item);
    if (result === 'queued' && (await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now());
    }
    return Response.json({ result });
  }

  async alarm(): Promise<void> {
    const base = pennyDeps(this.env);
    const storage = this.state.storage;
    // Log lines and timings are written in order, one after another, so none is lost.
    let writes: Promise<void> = Promise.resolve();
    const later = (write: () => Promise<void>) => {
      writes = writes.then(write).catch(() => undefined);
    };
    const delay = await drain(this.store(), {
      ...base,
      log: (line) => {
        base.log(line);
        later(() => remember(storage, line));
      },
      timing: (name, seconds) => later(() => addSample(storage, name, seconds)),
    });
    await writes;
    if (delay !== null) await this.state.storage.setAlarm(Date.now() + delay);
  }
}
