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

type Script = 'en' | 'hans' | 'hant';
type Intent = 'confirm' | 'record' | 'lookup' | 'photo' | 'other';

function scriptOf(text: string): Script {
  if (/[a-z]{3}/i.test(text) && !/[\u3400-\u9fff]/.test(text)) return 'en';
  return /[这们说帐账还么为钱谁吗过]/.test(text) ? 'hans' : 'hant';
}

/** Penny's "one moment" notes, by what the message asks of her. A person does not answer every
 *  message with the same words, so neither does she: one is picked per message. */
const NOTES: Record<Intent, Record<Script, string[]>> = {
  confirm: {
    hant: ['🐶 好，處理中…', '🐶 收到～', '🐶 好喔，馬上弄'],
    hans: ['🐶 好，处理中…', '🐶 收到～', '🐶 好哦，马上弄'],
    en: ['🐶 On it…', '🐶 Got it, one sec…'],
  },
  record: {
    hant: ['🐶 收到，我記一下…', '🐶 等我算一下～', '🐶 好，我來記…'],
    hans: ['🐶 收到，我记一下…', '🐶 等我算一下～', '🐶 好，我来记…'],
    en: ['🐶 Got it, writing it down…', '🐶 One sec, doing the maths…'],
  },
  lookup: {
    hant: ['🐶 我翻一下帳本…', '🐶 我查一下喔…', '🐶 等我對一下帳～'],
    hans: ['🐶 我翻一下账本…', '🐶 我查一下哦…', '🐶 等我对一下账～'],
    en: ['🐶 Let me check the books…', '🐶 Looking it up…'],
  },
  photo: {
    hant: ['🐶 我看一下這張…', '🐶 收到照片，我看看～'],
    hans: ['🐶 我看一下这张…', '🐶 收到照片，我看看～'],
    en: ['🐶 Let me take a look…', '🐶 Reading it…'],
  },
  other: {
    hant: ['🐶 嗯…我想一下', '🐶 等我一下喔～', '🐶 好，我看看'],
    hans: ['🐶 嗯…我想一下', '🐶 等我一下哦～', '🐶 好，我看看'],
    en: ['🐶 Hmm, one moment…', '🐶 Give me a sec…'],
  },
};

const FAILED: Record<Script, string> = {
  hant: '🐶 剛剛卡住了，請再說一次。',
  hans: '🐶 刚刚卡住了，请再说一次。',
  en: '🐶 Sorry, I got stuck on that one. Please try again.',
};

// What the message asks of Penny, read from its words alone.
const CONFIRM = /^\s*(?:全部\s*)?(?:ok|okay|yes|好|好的|好喔|好哦|對|对|沒錯|没错|確認|确认|可以|收到|\+1|👍|👌|✅|取消|改成|改為|改为|不要|先不要|算了)/i;
const LOOKUP =
  /欠|多少|結算|结算|帳|账|總共|总共|花在|誰付|谁付|查|明細|明细|紀錄|记录|summary|balance|owe|how much|who paid|settle|total|link|連結|链接|卡片|card/i;
const MONEY = /\d|付|花了|買|买|請客|请客|墊|垫|轉|转|還|还|AA|分帳|分账|平分|paid|spent|split/i;
// A greeting, thanks or a little chatter: a person would just answer, not say "let me check".
const CHAT =
  /^(?:嗨+|hi+|hey+|hello|哈囉|哈啰|你好|您好|早安?|午安|晚安|早上好|晚上好|在嗎|在吗|在不在|謝謝|谢谢|感謝|感谢|多謝|多谢|謝啦|谢啦|thx|thanks?|thank you|ty|讚|赞|棒|好棒|厲害|厉害|可愛|可爱|乖|哈哈+|呵呵|lol|haha+|😂|🤣|❤️|🥰|😊|🐶|你是誰|你是谁|who are you|bye|掰掰?|拜拜)[\s!！。.~～?？,，]*(?:penny|呀|啊|喔|哦|啦|囉|嘛|欸)?[\s!！。.~～?？]*$/i;

/** Drop the @mention and Penny's names, so "@Penny 嗨" reads as "嗨". */
function bare(text: string): string {
  return text
    .replace(/@\S+/g, ' ')
    .replace(/\bpenny\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function intentOf(item: Pick<QueuedMessage, 'message'>): Intent | 'chat' {
  const { message } = item;
  if (message.kind === 'image') return 'photo';
  const text = bare(message.text);
  if (!text) return 'chat';
  if (CHAT.test(text)) return 'chat';
  if (CONFIRM.test(text) && text.length <= 20) return 'confirm';
  if (LOOKUP.test(text)) return 'lookup';
  if (MONEY.test(text)) return 'record';
  // A few words with nothing about money ("你在幹嘛", "好可愛"): just talk.
  if (text.length <= 8) return 'chat';
  return 'other';
}

/** Same message, same pick: a retried note never changes its words. */
function pick<T>(list: T[], seed: string): T {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return list[h % list.length];
}

/** Penny's "one moment" note, and what it becomes if her turn fails for good. In the
 *  speaker's script when the message shows it; Traditional Chinese otherwise. Small talk gets
 *  no note at all (null): she just answers, as a person would. */
export function noteText(item: Pick<QueuedMessage, 'message'>, kind: 'working'): string | null;
export function noteText(item: Pick<QueuedMessage, 'message'>, kind: 'failed'): string;
export function noteText(item: Pick<QueuedMessage, 'message'>, kind: 'working' | 'failed'): string | null {
  const script = scriptOf(item.message.text);
  if (kind === 'failed') return FAILED[script];
  const intent = intentOf(item);
  if (intent === 'chat') return null;
  return pick(NOTES[intent][script], item.message.eventId);
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
      // Not for a reaction: a 👍 on a message with nothing pending gets no answer, and a note
      // that is posted and then deleted shows up in the room as "Penny recalled a message".
      // Not for small talk either: nobody says "let me check" before answering a "hi".
      if (item.verdict === 'called' && item.message.kind !== 'reaction' && !item.ackId && deps.ack && noteText(item, 'working')) {
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
