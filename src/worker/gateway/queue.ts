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
import { isNarraAgent, type Verdict } from './filter';
import { detectLang } from './lang';
import { splitPreview } from './split-preview';
import { remember } from './poller';
import { addSample, summarizeAll, type Samples } from './metrics';

export interface QueuedMessage {
  message: InboundMessage;
  verdict: Verdict;
  attempts: number;
  enqueuedAt: number;
  /** Event id of Penny's "one moment" note for this message, once it is posted. */
  ackId?: string;
  /** Penny's answer, once her turn is done, so a retry after a failed post resends it
   *  instead of running (and billing) another turn. */
  answer?: string;
  /** The room was told Penny is down for a moment (her turn keeps failing). */
  toldDown?: boolean;
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
  /** Post a short note at once (that she is on it, or that she is down for a moment).
   *  Returns its event id, so the answer can replace it. */
  ack?(item: QueuedMessage, text: string): Promise<string>;
  /** Replace the note's text: with the answer, or with a quiet 👌 when she says nothing. */
  patch?(item: QueuedMessage, ackId: string, text: string): Promise<void>;
  /** Show or stop "Penny is typing…". Resolves false when the room cannot show it. */
  typing?(item: QueuedMessage, on: boolean): Promise<boolean>;
  /** Mark the message read, so its sender sees Penny got it. */
  receipt?(item: QueuedMessage): Promise<void>;
  /** Whether an error is worth another try: false to give up, true for the usual backoff
   *  (up to MAX_ATTEMPTS, or TURN_RETRY_MS for a failed turn), or the delay in ms before the
   *  next try, for errors with a schedule of their own. `attempts` counts this failed one. */
  retryable(error: unknown, attempts: number): boolean | number;
  /** A timing sample in seconds: waitS (queued → turn starts), turnS (Penny's turn), answerS
   *  (message sent → answer posted). */
  timing?(name: 'waitS' | 'turnS' | 'answerS', seconds: number): void;
  log(line: string): void;
}

export const MAX_ATTEMPTS = 3;
/** Pauses between tries when Penny's turn itself fails, which mostly means her sandbox is down
 *  for a while (on 2026-11-18 Manyfold took 13 minutes to restart it). All within MAX_AGE_MS,
 *  so the person who asked gets an answer when she is back instead of having to ask again. */
export const TURN_RETRY_MS = [10_000, 30_000, 60_000, 120_000, 300_000, 600_000];
/** Typing shows for 30 seconds at a time; refresh it before then while the turn runs. */
const TYPING_REFRESH_MS = 20_000;
/** A message waiting longer than this is dropped: answering it now would only confuse. */
export const MAX_AGE_MS = 30 * 60_000;
const SEEN_TTL_MS = 24 * 60 * 60_000;
const MAX_QUEUE = 200;

const pad = (n: number) => String(n).padStart(16, '0');

/** Answers that mean "say nothing". Posting them would only put noise in the chat. */
const SILENCE =
  /^\s*(?:\(empty response\)|no[\s_-]+response(?:[\s_-]+requested)?|\[?\s*(?:no[\s_-]+reply|silence)\s*\]?)[.。]?\s*$|^\s*\.{0,3}\s*$/i;
// A short note to herself in brackets about saying nothing: "(No reply. Penny stays quiet here.)",
// "[silent]", "(No response needed)", "(No_reply)". Brackets with only that inside are never meant for the room.
const SILENT_NOTE =
  /^\s*[([（【]\s*(?:no[\s_-]+(?:reply|response|answer)|silen(?:t|ce)|stay(?:s|ing)?[\s_-]+(?:quiet|silent)|不回覆|不回复|不回應|不回应|保持安靜|保持安静)[^)\]）】\n]{0,80}[)\]）】][.。]?\s*$/i;

export const isSilence = (answer: string): boolean => {
  const trimmed = answer.trim().replace(/^`([^`]*)`([.。]?)$/, '$1$2');
  return SILENCE.test(trimmed) || SILENT_NOTE.test(trimmed);
};

/**
 * Penny's notes to herself sometimes reach the answer glued in front of it, with no space where
 * one text block ended and the next began: "Entry #3 is pending, so I'll cancel it.已改好，#3 取消…",
 * "Test format message: skip steps 0–1. Check pending.Ken is involved in #5.#5 計程車…". The tell
 * is a sentence ending in a lowercase letter and a period, run straight into a capital, a "#" or
 * Chinese. Only a leading English run on the first line is cut, and only when the cut ends at
 * such a seam, so a URL ("netmind-ai.workers.dev") or an amount ("£3.33") is never touched.
 */
const SEAM =
  /[a-z0-9)'"][.!?:](?=[A-Z#\u3400-\u9fff]|\[(?:NO[\s_-]+REPLY|no[\s_-]+reply|No[\s_-]+[Rr]eply|SILENCE|silence|Silence)\])/g;

export function stripLeakedNotes(answer: string): { text: string; cut: string } {
  const firstLine = answer.split('\n', 1)[0];
  if (!/^[A-Z]/.test(firstLine)) return { text: answer, cut: '' };
  // The note is English: it ends where the first Chinese or line break begins, at the latest.
  const cjk = firstLine.search(/[\u3400-\u9fff]/);
  const scope = cjk === -1 ? firstLine : firstLine.slice(0, cjk + 1);
  let end = -1;
  for (const seam of scope.matchAll(SEAM)) end = seam.index + 2;
  if (end < 0) return { text: answer, cut: '' };
  const cut = answer.slice(0, end);
  // A real note has a few words in it; "OK.#21" or "Hi!Zack" is not one.
  if (cut.trim().split(/\s+/).length < 4) return { text: answer, cut: '' };
  const text = answer.slice(end).trimStart();
  return text ? { text, cut } : { text: answer, cut: '' };
}

type Script = 'en' | 'hans' | 'hant';
type Intent = 'confirm' | 'record' | 'lookup' | 'photo' | 'other';

function scriptOf(message: Pick<InboundMessage, 'text' | 'detectedLang'>): Script {
  const lang = message.detectedLang ?? detectLang(message.text);
  if (lang === 'en') return 'en';
  return lang === 'zh-Hans' ? 'hans' : 'hant';
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

// For small talk in a group with other agents: Penny still needs a note there (see wantsNote).
const HELLO: Record<Script, string[]> = {
  hant: ['🐶 在～', '🐶 嗨～'],
  hans: ['🐶 在～', '🐶 嗨～'],
  en: ['🐶 Hi!', '🐶 Here!'],
};

const DOWN: Record<Script, string> = {
  hant: '🐶 我這邊暫時連不上，好了馬上回你。',
  hans: '🐶 我这边暂时连不上，好了马上回你。',
  en: "🐶 I can't reach my notebook right now. I'll answer as soon as I'm back.",
};

/** What a note becomes when Penny ends up saying nothing. Deleting it would show
 *  "Penny recalled a message" to everyone. */
export const QUIET_NOTE = '🐶👌';

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

/**
 * Whether Penny posts a note before her turn: when someone talked to her directly. Also for an
 * expense in a group with other Narra agents: they answer within seconds, and Narra refuses a
 * 7th agent message after the latest human one, but never an edit. The note goes out at once,
 * before the others' answers, and her answer then replaces it as an edit.
 */
export function wantsNote(item: Pick<QueuedMessage, 'message' | 'verdict'>): boolean {
  if (item.message.kind === 'reaction') return false;
  return item.verdict === 'called';
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
export function noteText(item: Pick<QueuedMessage, 'message'>, kind: 'failed' | 'down'): string;
export function noteText(item: Pick<QueuedMessage, 'message'>, kind: 'working' | 'failed' | 'down'): string | null {
  const script = scriptOf(item.message);
  if (kind === 'failed') return FAILED[script];
  if (kind === 'down') return DOWN[script];
  const intent = intentOf(item);
  if (intent === 'chat') return item.message.crowded ? pick(HELLO[script], item.message.eventId) : null;
  return pick(NOTES[intent][script], item.message.eventId);
}

const REDACTED_KEY = 'redacted';
const MAX_REDACTED = 200;

/** Record an event id that was redacted in the room so unposted queued copies are dropped cleanly. */
export async function redactEvent(store: Store, eventId: string): Promise<void> {
  if (!eventId) return;
  const list = (await store.get<string[]>(REDACTED_KEY)) ?? [];
  if (!list.includes(eventId)) {
    await store.put(REDACTED_KEY, [...list, eventId].slice(-MAX_REDACTED));
  }
}

export async function isRedacted(store: Store, eventId: string): Promise<boolean> {
  if (!eventId) return false;
  const list = (await store.get<string[]>(REDACTED_KEY)) ?? [];
  return list.includes(eventId);
}

/** When a newer non-agent human message arrives in the room, older queued group messages quote when answered. */
export async function markOlderUnquoted(store: Store, latestHumanEventId: string): Promise<void> {
  if (!latestHumanEventId) return;
  const entries = await store.list<QueuedMessage>({ prefix: 'q:', limit: MAX_QUEUE });
  for (const [key, item] of entries) {
    const m = item.message;
    if (
      m.eventId !== latestHumanEventId &&
      m.chatType === 'group' &&
      item.verdict !== 'nudge' &&
      m.kind !== 'reaction' &&
      !isNarraAgent(m.senderId) &&
      !m.shouldQuote
    ) {
      await store.put(key, { ...item, message: { ...m, shouldQuote: true } } satisfies QueuedMessage);
    }
  }
}

/** Add a message unless this event was seen already (Narra may deliver twice) or redacted. */
export async function enqueue(store: Store, item: Omit<QueuedMessage, 'attempts'>): Promise<'queued' | 'duplicate' | 'full' | 'redacted'> {
  if (await isRedacted(store, item.message.eventId)) return 'redacted';
  const seenKey = `seen:${item.message.eventId}`;
  const seen = await store.get<number>(seenKey);
  if (seen && Date.now() - seen < SEEN_TTL_MS) return 'duplicate';
  if ((await store.list({ prefix: 'q:', limit: MAX_QUEUE })).size >= MAX_QUEUE) return 'full';
  const next = ((await store.get<number>('next')) ?? 0) + 1;
  await store.put('next', next);
  const message =
    isNarraAgent(item.message.senderId) && item.message.shouldQuote
      ? { ...item.message, shouldQuote: false }
      : item.message;
  await store.put(`q:${pad(next)}`, { ...item, message, attempts: 0 } satisfies QueuedMessage);
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
      if (item.ackId && deps.patch) await deps.patch(item, item.ackId, noteText(item, 'failed')).catch(() => undefined);
      await store.delete(key);
      continue;
    }
    if (await isRedacted(store, item.message.eventId)) {
      deps.log(`dropped redacted message ${item.message.eventId}`);
      if (item.ackId && deps.patch) await deps.patch(item, item.ackId, QUIET_NOTE).catch(() => undefined);
      await store.delete(key);
      continue;
    }
    if (isNarraAgent(item.message.senderId) && item.message.shouldQuote) {
      item.message.shouldQuote = false;
    }
    const startedAt = Date.now();
    if (item.attempts === 0) {
      deps.timing?.('waitS', (startedAt - item.enqueuedAt) / 1000);
      if (item.verdict !== 'nudge' && item.message.kind !== 'reaction') await deps.receipt?.(item).catch(() => undefined);
    }
    let phase: 'turn' | 'post' = 'post';
    try {
      let answer = item.answer;
      if (answer === undefined) {
        // Show that Penny is on it before her turn starts (see showWorking).
        const stop = await showWorking(store, key, item, deps);
        phase = 'turn';
        const turnStarted = Date.now();
        try {
          answer = (item.verdict === 'question' || item.verdict === 'called' ? splitPreview(item.message) : null)
            ?? await deps.turn(item);
        } finally {
          await stop();
        }
        phase = 'post';
        deps.timing?.('turnS', (Date.now() - turnStarted) / 1000);
        const { text, cut } = stripLeakedNotes(answer);
        if (cut) deps.log(`cut a leaked note from the answer to ${item.message.eventId} (${cut.length} chars)`);
        answer = text;
        const fresh = await store.get<QueuedMessage>(key);
        if (fresh?.message.shouldQuote && !isNarraAgent(item.message.senderId)) {
          item.message.shouldQuote = true;
        }
        item.answer = answer;
        await store.put(key, item);
      }
      if (await isRedacted(store, item.message.eventId)) {
        deps.log(`dropped redacted message ${item.message.eventId} before posting`);
        if (item.ackId && deps.patch) await deps.patch(item, item.ackId, QUIET_NOTE).catch(() => undefined);
        await store.delete(key);
        continue;
      }
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
      } else if (item.ackId && deps.patch) {
        await deps.patch(item, item.ackId, QUIET_NOTE).catch(() => undefined);
      }
      deps.log(`answered ${item.message.eventId} (${posted ? 'posted' : 'silent'})`);
      if (posted) deps.timing?.('answerS', (Date.now() - Date.parse(item.message.time)) / 1000);
      await store.delete(key);
    } catch (error) {
      const attempts = item.attempts + 1;
      const message = error instanceof Error ? error.message : String(error);
      const retry = deps.retryable(error, attempts);
      const turnDelay = phase === 'turn' && retry === true ? TURN_RETRY_MS[attempts - 1] : undefined;
      if (retry === false || (retry === true && (phase === 'turn' ? turnDelay === undefined : attempts >= MAX_ATTEMPTS))) {
        deps.log(`gave up on ${item.message.eventId} after ${attempts} attempt(s): ${message}`);
        if (item.ackId && deps.patch) {
          await deps.patch(item, item.ackId, noteText(item, 'failed')).catch(() => undefined);
        }
        await store.delete(key);
        continue;
      }
      deps.log(`retrying ${item.message.eventId} (attempt ${attempts}): ${message}`);
      const next: QueuedMessage = { ...item, attempts };
      // Her turn failed twice: someone is waiting, so say she is down for a moment. The answer
      // replaces this note when she is back.
      if (phase === 'turn' && attempts >= 2 && !item.toldDown && wantsNote(item)) {
        next.toldDown = true;
        try {
          if (item.ackId && deps.patch) await deps.patch(item, item.ackId, noteText(item, 'down'));
          else if (deps.ack) next.ackId = (await deps.ack(item, noteText(item, 'down'))) || undefined;
        } catch (e) {
          deps.log(`could not say Penny is down for ${item.message.eventId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      await store.put(key, next);
      // Hold the whole room: the next message may depend on this one.
      return typeof retry === 'number' ? retry : (turnDelay ?? 5_000 * 2 ** (attempts - 1));
    }
  }
  const [left] = await store.list({ prefix: 'q:', limit: 1 });
  return left ? 0 : null;
}

/**
 * Before Penny's turn: "Penny is typing…" where the room can show it, which adds no message.
 * A note instead in a group with other agents (it holds her place, see wantsNote), or for
 * someone who called her where typing cannot show. Returns what stops the typing afterwards.
 */
async function showWorking(store: Store, key: string, item: QueuedMessage, deps: Deps): Promise<() => Promise<void>> {
  const done = async () => undefined;
  if (item.ackId || item.verdict === 'nudge') return done;
  const note = wantsNote(item) ? noteText(item, 'working') : null;
  let typing = false;
  if (!(item.message.crowded && note) && deps.typing) typing = await deps.typing(item, true).catch(() => false);
  if (!typing && note && deps.ack) {
    try {
      const ackId = await deps.ack(item, note);
      if (ackId) {
        item.ackId = ackId;
        await store.put(key, item);
      }
    } catch (error) {
      deps.log(`could not post the note for ${item.message.eventId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!typing) return done;
  const timer = setInterval(() => void deps.typing?.(item, true).catch(() => false), TYPING_REFRESH_MS);
  return async () => {
    clearInterval(timer);
    await deps.typing?.(item, false).catch(() => false);
  };
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
    const path = new URL(request.url).pathname;
    if (request.method === 'GET') {
      const queued = await this.state.storage.list({ prefix: 'q:', limit: 200 });
      return Response.json({
        queued: queued.size,
        alarm: await this.state.storage.getAlarm(),
        log: (await this.state.storage.get<string[]>('log')) ?? [],
        metrics: summarizeAll(await this.state.storage.get<Samples>('metrics')),
      });
    }
    if (path.endsWith('/redact')) {
      const body = (await request.json().catch(() => null)) as { eventId?: unknown } | null;
      if (typeof body?.eventId === 'string' && body.eventId) {
        await redactEvent(this.store(), body.eventId);
      }
      return Response.json({ ok: true });
    }
    if (path.endsWith('/human-event')) {
      const body = (await request.json().catch(() => null)) as { eventId?: unknown } | null;
      if (typeof body?.eventId === 'string' && body.eventId) {
        await markOlderUnquoted(this.store(), body.eventId);
      }
      return Response.json({ ok: true });
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
