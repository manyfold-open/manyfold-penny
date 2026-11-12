/**
 * The Narra gateway: parsing, the filter, the per-room queue and the webhook route.
 */
import { describe, expect, it, vi } from 'vitest';
import app from '../src/worker/index';
import { classify } from '../src/worker/gateway/filter';
import { parseInbound, type InboundMessage } from '../src/worker/gateway/inbound';
import { drain, enqueue, MAX_ATTEMPTS, type Deps, type QueuedMessage, type Store } from '../src/worker/gateway/queue';
import { txnId } from '../src/worker/gateway/reply';
import { FakeD1 } from './support/fake-d1';

const BOT = { matrixId: '@agent-54ebea3a:matrix.netmind.chat', names: ['Penny', '小胖'] };

let counter = 0;
const msg = (text: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({
  roomId: '!room:x',
  roomName: '',
  chatType: 'group',
  eventId: `$event-${++counter}`,
  senderId: '@zack:x',
  senderName: 'Zack',
  text,
  time: '2026-11-12T17:00:00.000Z',
  mentions: [],
  ...extra,
});

describe('parsing', () => {
  it('reads a Matrix room event', () => {
    const m = parseInbound({
      event: {
        type: 'm.room.message',
        room_id: '!a:x',
        event_id: '$e1',
        sender: '@mei:x',
        origin_server_ts: Date.parse('2026-11-12T10:00:00Z'),
        content: { msgtype: 'm.text', body: '晚餐 80 我付', 'm.mentions': { user_ids: [BOT.matrixId] } },
      },
      room_name: '倫敦',
      sender_name: 'Mei',
    });
    expect(m).toMatchObject({
      roomId: '!a:x',
      eventId: '$e1',
      senderId: '@mei:x',
      text: '晚餐 80 我付',
      roomName: '倫敦',
      senderName: 'Mei',
      chatType: 'group',
      mentions: [BOT.matrixId],
      time: '2026-11-12T10:00:00.000Z',
    });
  });

  it('ignores events that are not text messages', () => {
    expect(parseInbound({ type: 'm.reaction', room_id: '!a:x', event_id: '$e', sender: '@a:x', content: {} })).toBeNull();
    expect(parseInbound({ room_id: '!a:x', event_id: '$e', sender: '@a:x', content: { msgtype: 'm.image', body: 'x.png' } })).toBeNull();
  });

  it('rejects a payload without room, event or sender', () => {
    expect(() => parseInbound({ text: 'hi' })).toThrow();
    expect(() => parseInbound('nope')).toThrow();
  });
});

describe('the filter', () => {
  it('calls Penny when she is mentioned, by name, renamed name, id or m.mentions', () => {
    expect(classify(msg('@Penny 誰欠誰'), BOT)).toBe('called');
    expect(classify(msg('penny 幫我記一下'), BOT)).toBe('called');
    expect(classify(msg('@小胖 你記得什麼'), BOT)).toBe('called');
    expect(classify(msg('hi', { mentions: [BOT.matrixId] }), BOT)).toBe('called');
  });

  it('calls Penny for answers to a proposal', () => {
    for (const text of ['OK', 'ok #21', '好', '對', '全部 OK', '取消 #3', '改成 50', '#21 OK']) {
      expect(classify(msg(text), BOT), text).toBe('called');
    }
  });

  it('passes on money talk without a mention', () => {
    for (const text of ['我剛付了晚餐 80', '計程車我出的 25', 'I paid £40 for the tickets', '我轉給 Mei 175 了']) {
      expect(classify(msg(text), BOT), text).toBe('expense');
    }
  });

  it('skips chatter, links and money talk with no amount', () => {
    for (const text of ['好啊今天去哪吃', '明天 8 點集合', '晚餐要付現嗎', 'https://arena42.ai 看一下', 'pennyworth 是誰']) {
      expect(classify(msg(text), BOT), text).toBe('skip');
    }
  });

  it('never calls Penny for her own messages, and always in a private chat', () => {
    expect(classify(msg('@Penny OK', { senderId: BOT.matrixId }), BOT)).toBe('skip');
    expect(classify(msg('今天天氣', { chatType: 'dm' }), BOT)).toBe('called');
  });
});

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
    const keys = [...this.data.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort()
      .slice(0, limit ?? Infinity);
    return new Map(keys.map((k) => [k, this.data.get(k) as T]));
  }
}

const deps = (overrides: Partial<Deps> = {}): Deps & { posted: string[] } => {
  const posted: string[] = [];
  return {
    posted,
    turn: async (item) => `re: ${item.message.text}`,
    post: async (_item, text) => {
      posted.push(text);
    },
    retryable: () => true,
    log: () => undefined,
    ...overrides,
  };
};

describe('the room queue', () => {
  it('answers messages in the order they arrived', async () => {
    const store = new MemoryStore();
    for (const text of ['晚餐 80 我付', 'OK', '誰欠誰']) {
      await enqueue(store, { message: msg(text), verdict: 'called', enqueuedAt: Date.now() });
    }
    const d = deps();
    expect(await drain(store, d)).toBeNull();
    expect(d.posted).toEqual(['re: 晚餐 80 我付', 're: OK', 're: 誰欠誰']);
  });

  it('drops a second delivery of the same event', async () => {
    const store = new MemoryStore();
    const m = msg('OK');
    expect(await enqueue(store, { message: m, verdict: 'called', enqueuedAt: Date.now() })).toBe('queued');
    expect(await enqueue(store, { message: m, verdict: 'called', enqueuedAt: Date.now() })).toBe('duplicate');
  });

  it('posts nothing when Penny chooses silence', async () => {
    const store = new MemoryStore();
    await enqueue(store, { message: msg('我剛付了 8 塊停車'), verdict: 'expense', enqueuedAt: Date.now() });
    const d = deps({ turn: async () => '' });
    await drain(store, d);
    expect(d.posted).toEqual([]);
  });

  it('holds the room and retries a failed turn, then gives up', async () => {
    const store = new MemoryStore();
    await enqueue(store, { message: msg('first'), verdict: 'called', enqueuedAt: Date.now() });
    await enqueue(store, { message: msg('second'), verdict: 'called', enqueuedAt: Date.now() });
    const turn = vi.fn(async (item: QueuedMessage) => {
      if (item.message.text === 'first') throw new Error('agent busy');
      return 'ok';
    });
    const d = deps({ turn });
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect(await drain(store, d)).toBeGreaterThan(0);
      expect(d.posted).toEqual([]);
    }
    expect(await drain(store, d)).toBeNull();
    expect(d.posted).toEqual(['ok']);
    expect(turn).toHaveBeenCalledTimes(MAX_ATTEMPTS + 1);
  });

  it('drops messages that waited too long', async () => {
    const store = new MemoryStore();
    await enqueue(store, { message: msg('old'), verdict: 'called', enqueuedAt: Date.now() - 60 * 60_000 });
    const d = deps();
    await drain(store, d);
    expect(d.posted).toEqual([]);
  });
});

describe('txn ids', () => {
  it('are UUID v4 shaped and stable per event', async () => {
    const a = await txnId('$e1');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await txnId('$e1')).toBe(a);
    expect(await txnId('$e2')).not.toBe(a);
  });
});

describe('the webhook', () => {
  const SECRET = 'narra-webhook-secret-0123456789';
  const queued: unknown[] = [];
  const ROOM_QUEUE = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (_url: string, init: RequestInit) => {
        queued.push(JSON.parse(String(init.body)));
        return Response.json({ result: 'queued' });
      },
    }),
  };
  const env = {
    DB: new FakeD1(),
    ASSETS: { fetch: async () => new Response('') },
    NARRA_WEBHOOK_SECRET: SECRET,
    ROOM_QUEUE,
  };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const post = (body: unknown, key: string | null = SECRET, envOverride: object = {}) =>
    app.fetch(
      new Request('https://penny.test/api/narra/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
      }),
      { ...env, ...envOverride },
      ctx,
    );
  const event = (body: string) => ({
    room_id: '!r:x',
    event_id: `$${body}`,
    sender: '@mei:x',
    content: { msgtype: 'm.text', body },
  });

  it('is off without a secret and needs the right one', async () => {
    expect((await post(event('@Penny hi'), SECRET, { NARRA_WEBHOOK_SECRET: undefined })).status).toBe(503);
    expect((await post(event('@Penny hi'), null)).status).toBe(401);
    expect((await post(event('@Penny hi'), 'wrong')).status).toBe(401);
  });

  it('queues what Penny should see and answers at once', async () => {
    queued.length = 0;
    const res = await post(event('@Penny 誰欠誰'));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ result: 'queued', verdict: 'called' });
    expect(queued).toHaveLength(1);
  });

  it('skips chatter without queueing anything', async () => {
    queued.length = 0;
    const res = await post(event('今晚吃什麼'));
    expect(await res.json()).toEqual({ result: 'skipped' });
    expect(queued).toHaveLength(0);
  });

  it('rejects a malformed event', async () => {
    expect((await post({ hello: 'world' })).status).toBe(400);
  });
});
