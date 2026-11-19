/**
 * Real-time reading through Matrix /sync: the reader, how the poller takes its batches, the
 * backstop, and Penny's early note in groups with other agents.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../src/worker/gateway/inbound';
import type { NarraApi, NarraEvent, NarraRoom } from '../src/worker/gateway/narra-api';
import { BACKSTOP_EVERY_MS, ingest, SYNC_FRESH_MS, tick, TICK_MS, type Sink } from '../src/worker/gateway/poller';
import { noteText, wantsNote, type Store } from '../src/worker/gateway/queue';
import { fetchLogin, SYNC_TIMEOUT_MS, SyncError, syncOnce, type MatrixLogin, type SyncDeps, type SyncResponse } from '../src/worker/gateway/sync';
import type { Env } from '../src/worker/types';

class MemoryStore implements Store {
  data = new Map<string, unknown>();
  async get<T>(key: string) {
    return this.data.get(key) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string) {
    return this.data.delete(key);
  }
  async list<T>({ prefix, limit }: { prefix: string; limit?: number }) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit ?? Infinity);
    return new Map(keys.map((k) => [k, this.data.get(k) as T]));
  }
}

const PENNY = '@agent-54ebea3a:matrix.netmind.chat';
const LOGIN: MatrixLogin = { homeserverUrl: 'https://matrix.netmind.chat', userId: PENNY, accessToken: 'secret' };
const text = (id: string, body: string, sender = '@mei:x'): NarraEvent => ({
  event_id: id,
  sender,
  origin_server_ts: 0,
  type: 'm.room.message',
  content: { msgtype: 'm.text', body },
});

describe('the /sync reader', () => {
  const deps = (responses: (SyncResponse | Error)[]) => {
    const calls: { since: string | null; timeout: number }[] = [];
    const forwarded: unknown[] = [];
    const logins = vi.fn(async () => LOGIN);
    const d: SyncDeps = {
      login: logins,
      sync: async (_login, since, timeout) => {
        calls.push({ since, timeout });
        const next = responses.shift()!;
        if (next instanceof Error) throw next;
        return next;
      },
      forward: async (rooms) => {
        forwarded.push(rooms);
      },
      log: () => undefined,
    };
    return { d, calls, forwarded, logins };
  };

  it('starts from now, then long-polls and forwards new events by room', async () => {
    const store = new MemoryStore();
    const { d, calls, forwarded } = deps([
      { next_batch: 's1', rooms: { join: { '!a:x': { timeline: { events: [text('$old', 'before Penny started')] } } } } },
      { next_batch: 's2', rooms: { join: { '!a:x': { timeline: { events: [text('$1', '@Penny 誰欠誰')] } }, '!b:x': { timeline: { events: [] } } } } },
      { next_batch: 's3' },
    ]);
    const cache: { login?: MatrixLogin } = {};
    expect(await syncOnce(store, d, cache)).toBe(0);
    expect(await syncOnce(store, d, cache)).toBe(0);
    expect(await syncOnce(store, d, cache)).toBe(0);
    expect(calls).toEqual([
      { since: null, timeout: 0 },
      { since: 's1', timeout: SYNC_TIMEOUT_MS },
      { since: 's2', timeout: SYNC_TIMEOUT_MS },
    ]);
    // The first /sync only finds the live end; an empty /sync still reports in.
    expect(forwarded).toEqual([[], [{ roomId: '!a:x', events: [text('$1', '@Penny 誰欠誰')], limited: false }], []]);
  });

  it('passes on a gap so the backstop can read it', async () => {
    const store = new MemoryStore();
    await store.put('sync', { since: 's1', failures: 0 });
    const { d, forwarded } = deps([{ next_batch: 's2', rooms: { join: { '!a:x': { timeline: { events: [], limited: true } } } } }]);
    await syncOnce(store, d, {});
    expect(forwarded).toEqual([[{ roomId: '!a:x', events: [], limited: true }]]);
  });

  it('backs off on failure, keeps its place, and fetches the login again after a 401', async () => {
    const store = new MemoryStore();
    await store.put('sync', { since: 's1', failures: 0 });
    const { d, calls, logins } = deps([new SyncError('homeserver refused the login (401)', true), new Error('timeout'), { next_batch: 's2' }]);
    const cache: { login?: MatrixLogin } = {};
    expect(await syncOnce(store, d, cache)).toBe(2_000);
    expect(cache.login).toBeUndefined();
    expect(await syncOnce(store, d, cache)).toBe(4_000);
    expect(await syncOnce(store, d, cache)).toBe(0);
    expect(calls.map((c) => c.since)).toEqual(['s1', 's1', 's1']);
    expect(logins).toHaveBeenCalledTimes(2);
    expect(await store.get('sync')).toEqual({ since: 's2', failures: 0 });
  });
});

describe('fetching the Matrix login', () => {
  afterEach(() => vi.unstubAllGlobals());
  const env = { NARRA_AGENT_TOKEN: 'bearer' } as Env;
  const answer = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it("reads Narra's answer, plain or wrapped", async () => {
    for (const wrap of [(x: unknown) => x, (x: unknown) => ({ status: 'ok', data: x })]) {
      answer(200, wrap({ homeserver_url: 'https://matrix.netmind.chat/', matrix_user_id: PENNY, access_token: 'tok' }));
      expect(await fetchLogin(env)).toEqual({ homeserverUrl: 'https://matrix.netmind.chat', userId: PENNY, accessToken: 'tok' });
    }
  });

  it('sends the token only to Narra\'s own homeserver over https', async () => {
    for (const url of ['http://matrix.netmind.chat', 'https://evil.example', 'https://netmind.chat.evil.example']) {
      answer(200, { homeserver_url: url, matrix_user_id: PENNY, access_token: 'tok' });
      await expect(fetchLogin(env), url).rejects.toThrow(SyncError);
    }
  });

  it('never repeats the answer in its error', async () => {
    answer(500, { access_token: 'leaked?' });
    await expect(fetchLogin(env)).rejects.toThrow(/^Narra matrix-credential failed: HTTP 500$/);
  });
});

describe('the poller with /sync', () => {
  const room = (roomId: string, names: Record<string, string> = {}): NarraRoom => ({ roomId, type: 'group', title: '倫敦', memberCount: 3, names });
  const setup = (names: Record<string, string> = {}) => {
    const pages: Record<string, NarraEvent[]> = { '!a:x': [] };
    const api: NarraApi = {
      rooms: async () => ({ agentId: PENNY, rooms: [room('!a:x', names)] }),
      head: async () => 't0',
      after: async (roomId) => {
        const events = pages[roomId].splice(0);
        return { events, next: events.length ? 't1' : null };
      },
    };
    const delivered: { message: InboundMessage; verdict: string }[] = [];
    const s: Sink = {
      botNames: async () => [],
      hasPending: async () => false,
      deliver: async (message, verdict) => {
        delivered.push({ message, verdict });
      },
      log: () => undefined,
    };
    return { store: new MemoryStore(), api, s, pages, delivered };
  };

  it('answers what /sync brings, and not again when the backstop reads it', async () => {
    const t = setup();
    let now = 1_000_000;
    await tick(t.store, t.api, t.s, now);
    await ingest(t.store, t.s, [{ roomId: '!a:x', events: [text('$1', '@Penny 誰欠誰')] }], now + 500);
    expect(t.delivered.map((d) => d.message.text)).toEqual(['@Penny 誰欠誰']);

    t.pages['!a:x'].push(text('$1', '@Penny 誰欠誰'), text('$2', '我剛付了晚餐 80'));
    now += BACKSTOP_EVERY_MS;
    await tick(t.store, t.api, t.s, now);
    expect(t.delivered.map((d) => d.message.text)).toEqual(['@Penny 誰欠誰', '我剛付了晚餐 80']);
  });

  it('reads each room only once a minute while /sync reports in, and as before when it stops', async () => {
    const t = setup();
    const now = 1_000_000;
    await tick(t.store, t.api, t.s, now);
    await ingest(t.store, t.s, [], now);
    await tick(t.store, t.api, t.s, now + 8_000);
    expect(((await t.store.get<{ nextPollAt: number }>('room:!a:x'))!.nextPollAt)).toBe(now + 8_000 + BACKSTOP_EVERY_MS);

    // /sync silent for longer than SYNC_FRESH_MS: back to reading every few seconds.
    const later = now + SYNC_FRESH_MS + 10_000;
    expect(await tick(t.store, t.api, t.s, later)).toBe(TICK_MS);
    expect(((await t.store.get<{ nextPollAt: number }>('room:!a:x'))!.nextPollAt) - later).toBeLessThan(BACKSTOP_EVERY_MS);
  });

  it('reads a room at once when /sync reports a gap', async () => {
    const t = setup();
    const now = 1_000_000;
    await tick(t.store, t.api, t.s, now);
    await ingest(t.store, t.s, [{ roomId: '!a:x', events: [], limited: true }], now + 1_000);
    expect(((await t.store.get<{ nextPollAt: number }>('room:!a:x'))!.nextPollAt)).toBe(now + 1_000);
  });

  it('leaves rooms it has not started to the poller', async () => {
    const t = setup();
    await t.store.put('rooms', { refreshedAt: 0, agentId: PENNY, rooms: [room('!a:x')] });
    await ingest(t.store, t.s, [{ roomId: '!a:x', events: [text('$1', '@Penny hi')] }, { roomId: '!z:x', events: [text('$2', '@Penny hi')] }]);
    expect(t.delivered).toEqual([]);
  });

  it('marks messages from a group that has other agents in it', async () => {
    const t = setup({ '@agent-1234abcd:x': 'AI Tarot', '@mei:x': 'Mei' });
    await tick(t.store, t.api, t.s, 1_000_000);
    await ingest(t.store, t.s, [{ roomId: '!a:x', events: [text('$1', '@Penny hello')] }], 1_000_500);
    expect(t.delivered[0].message.crowded).toBe(true);

    const quiet = setup({ [PENNY]: 'Penny', '@mei:x': 'Mei' });
    await tick(quiet.store, quiet.api, quiet.s, 1_000_000);
    await ingest(quiet.store, quiet.s, [{ roomId: '!a:x', events: [text('$1', '@Penny hello')] }], 1_000_500);
    expect(quiet.delivered[0].message.crowded).toBeUndefined();
  });
});

describe("Penny's note in a group with other agents", () => {
  const msg = (body: string, crowded?: boolean): InboundMessage => ({
    roomId: '!a:x',
    roomName: '',
    chatType: 'group',
    eventId: '$1',
    senderId: '@mei:x',
    senderName: 'Mei',
    text: body,
    time: '2026-11-17T11:00:00.000Z',
    mentions: [],
    ...(crowded ? { crowded } : {}),
  });

  it('posts a note even for small talk, to hold her place', () => {
    expect(noteText({ message: msg('@Penny hello') }, 'working')).toBeNull();
    expect(noteText({ message: msg('@Penny hello', true) }, 'working')).toMatch(/🐶/);
  });

  it('only posts a note when Penny was directly called, never for speculative unmentioned expenses or reactions', () => {
    expect(wantsNote({ message: msg('@Penny 晚餐 80', true), verdict: 'called' })).toBe(true);
    expect(wantsNote({ message: msg('我剛付了晚餐 80'), verdict: 'expense' })).toBe(false);
    expect(wantsNote({ message: msg('我剛付了晚餐 80', true), verdict: 'expense' })).toBe(false);
    expect(wantsNote({ message: { ...msg('👍', true), kind: 'reaction' }, verdict: 'called' })).toBe(false);
    expect(wantsNote({ message: msg('誰欠誰', true), verdict: 'question' })).toBe(false);
  });
});
