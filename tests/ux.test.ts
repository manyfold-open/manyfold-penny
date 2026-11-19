/**
 * How Penny comes across in Narra Messenger: real @mentions, replies that quote the message,
 * "typing…" instead of a note, and sending through Matrix with the chat API as fallback.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pennyDeps } from '../src/worker/gateway/deps';
import type { InboundMessage } from '../src/worker/gateway/inbound';
import { editContent, messageContent, plainMentions, renderMentions } from '../src/worker/gateway/mentions';
import { drain, enqueue, type Deps, type QueuedMessage, type Store } from '../src/worker/gateway/queue';
import { NarraError } from '../src/worker/gateway/reply';
import type { MatrixOp, MatrixOpResult } from '../src/worker/gateway/sync';
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

const KEN = '@sp-ken1:matrix.netmind.chat';
const msg = (text: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({
  roomId: '!a:x',
  roomName: '',
  chatType: 'group',
  eventId: '$e1',
  senderId: '@mei:x',
  senderName: 'Mei',
  text,
  time: new Date().toISOString(),
  mentions: [],
  ...extra,
});

describe('mentions', () => {
  it('turns the markup into a pill, a push and plain "@Name" in the body', () => {
    const r = renderMentions(`#21 晚餐 £120 還在等 [@Ken](${KEN}) 回 OK\n<b>`);
    expect(r.body).toBe('#21 晚餐 £120 還在等 @Ken 回 OK\n<b>');
    expect(r.html).toBe(`#21 晚餐 £120 還在等 <a href="https://matrix.to/#/${KEN}">@Ken</a> 回 OK<br>&lt;b&gt;`);
    expect(r.userIds).toEqual([KEN]);
  });

  it('never mentions an agent, and leaves text without markup alone', () => {
    const r = renderMentions('問 [@AI Tarot](@agent-1234abcd:matrix.netmind.chat) 吧');
    expect(r).toEqual({ body: '問 AI Tarot 吧', html: null, userIds: [] });
    expect(renderMentions('[link](https://x.y) and @Ken')).toEqual({ body: '[link](https://x.y) and @Ken', html: null, userIds: [] });
  });

  it('builds a reply, an edit, and plain text for the chat API', () => {
    expect(messageContent('hi', '', '$q')).toEqual({ msgtype: 'm.text', body: 'hi', 'm.mentions': {}, 'm.relates_to': { 'm.in_reply_to': { event_id: '$q' } } });
    const edit = editContent('$note', `[@Ken](${KEN}) OK?`, '');
    expect(edit['m.relates_to']).toEqual({ rel_type: 'm.replace', event_id: '$note' });
    expect((edit['m.new_content'] as Record<string, unknown>).body).toBe('@Ken OK?');
    expect(edit['m.mentions']).toEqual({ user_ids: [KEN] });
    expect(plainMentions(`[@Ken](${KEN}) OK?`)).toBe('@Ken OK?');
  });
});

describe('sending as Penny', () => {
  afterEach(() => vi.unstubAllGlobals());
  const item = (m: InboundMessage, verdict: QueuedMessage['verdict'] = 'called'): QueuedMessage => ({ message: m, verdict, attempts: 0, enqueuedAt: Date.now() });
  const env = (answer: (op: MatrixOp) => MatrixOpResult) => {
    const ops: MatrixOp[] = [];
    const stub = {
      fetch: async (_url: string, init: RequestInit) => {
        const op = JSON.parse(String(init.body)) as MatrixOp;
        ops.push(op);
        return Response.json(answer(op));
      },
    };
    const e = {
      NARRA_AGENT_TOKEN: 'bearer',
      MATRIX_SYNC: { idFromName: () => 'id', get: () => stub },
    } as unknown as Env;
    return { e, ops };
  };

  it('sends through Matrix with smart quoting only when shouldQuote is true in a group', async () => {
    const { e, ops } = env(() => ({ ok: true, eventId: '$sent' }));
    // Latest human message in the room (shouldQuote false/omitted): no quote bubble.
    await pennyDeps(e).post(item(msg('@Penny 誰欠誰', { shouldQuote: false })), `[@Ken](${KEN}) 要轉 £30`);
    const latestOp = ops[0] as Extract<MatrixOp, { op: 'send' }>;
    expect(latestOp.content['m.relates_to']).toBeUndefined();
    expect(latestOp.content['m.mentions']).toEqual({ user_ids: [KEN] });

    // Older / non-latest message (shouldQuote true): quotes the message it answers.
    await pennyDeps(e).post(item(msg('@Penny 誰欠誰', { shouldQuote: true })), `[@Ken](${KEN}) 要轉 £30`);
    const quotedOp = ops[1] as Extract<MatrixOp, { op: 'send' }>;
    expect(quotedOp.content['m.relates_to']).toEqual({ 'm.in_reply_to': { event_id: '$e1' } });
    expect(quotedOp.content['m.mentions']).toEqual({ user_ids: [KEN] });

    // Never quotes in DM, for a nudge, for a reaction, for non-$ ids, or for @agent-* senders.
    await pennyDeps(e).post(item(msg('誰欠誰', { chatType: 'dm', shouldQuote: true })), 'x');
    await pennyDeps(e).post(item(msg('[penny nudge] pending #1', { eventId: 'nudge:pending:!a:x:1', shouldQuote: true }), 'nudge'), 'x');
    await pennyDeps(e).post(item(msg('👍', { kind: 'reaction', shouldQuote: true })), 'x');
    await pennyDeps(e).post(item(msg('hi', { eventId: 'local-1', shouldQuote: true })), 'x');
    await pennyDeps(e).post(item(msg('hi', { senderId: '@agent-1234abcd:matrix.netmind.chat', shouldQuote: true })), 'x');
    expect(ops.slice(2).map((o) => (o as Extract<MatrixOp, { op: 'send' }>).content['m.relates_to'])).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('falls back to the chat API, in plain text, only when Matrix sent nothing', async () => {
    const { e } = env(() => ({ ok: false, status: 0 }));
    const fetch = vi.fn(async () => Response.json({ status: 'ok', data: { event_id: '$api' } }));
    vi.stubGlobal('fetch', fetch);
    await pennyDeps(e).post(item(msg('@Penny 誰欠誰')), `[@Ken](${KEN}) 要轉 £30`);
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)).text).toBe('@Ken 要轉 £30');
  });

  it("reads Narra's refusal as one that clears up, and never tries another path", async () => {
    const { e } = env(() => ({ ok: false, status: 403, errcode: 'M_FORBIDDEN', narraCode: 'agent_chain_exhausted' }));
    vi.stubGlobal('fetch', vi.fn());
    const deps = pennyDeps(e);
    const error = await deps.post(item(msg('@Penny hi')), 'hi').catch((x: unknown) => x);
    expect(error).toBeInstanceOf(NarraError);
    expect((error as NarraError).code).toBe('agent_chain_exhausted');
    expect(deps.retryable(error, 1)).toBe(15_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('edits with a key per text, so a second edit is not taken for the first', async () => {
    const { e, ops } = env(() => ({ ok: true }));
    const deps = pennyDeps(e);
    await deps.patch!(item(msg('@Penny hi')), '$note', 'down');
    await deps.patch!(item(msg('@Penny hi')), '$note', 'answer');
    const [a, b] = ops as Extract<MatrixOp, { op: 'send' }>[];
    expect(a.txnId).not.toBe(b.txnId);
  });
});

describe('typing instead of a note', () => {
  const base = (overrides: Partial<Deps>): Deps & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      turn: async (i) => `re: ${i.message.text}`,
      post: async (_i, t) => {
        calls.push(`post ${t}`);
      },
      ack: async (_i, t) => {
        calls.push(`ack ${t.slice(0, 2)}`);
        return '$note';
      },
      patch: async (_i, id, t) => {
        calls.push(`patch ${id} ${t}`);
      },
      typing: async (_i, on) => {
        calls.push(`typing ${on}`);
        return true;
      },
      receipt: async () => {
        calls.push('read');
      },
      retryable: () => true,
      log: () => undefined,
      ...overrides,
    };
  };

  it('marks the message read and types where the room can show it, adding no message', async () => {
    const store = new MemoryStore();
    await enqueue(store, { message: msg('@Penny 誰欠誰'), verdict: 'called', enqueuedAt: Date.now() });
    const d = base({});
    await drain(store, d);
    expect(d.calls).toEqual(['read', 'typing true', 'typing false', 'post re: @Penny 誰欠誰']);
  });

  it('posts a note instead in a group with other agents, to hold her place', async () => {
    const store = new MemoryStore();
    await enqueue(store, { message: msg('@Penny 誰欠誰', { crowded: true }), verdict: 'called', enqueuedAt: Date.now() });
    const d = base({});
    await drain(store, d);
    expect(d.calls).toEqual(['read', 'ack 🐶', 'patch $note re: @Penny 誰欠誰']);
  });

  it('falls back to a note in the speaker\'s detectedLang when typing cannot show', async () => {
    const store = new MemoryStore();
    await enqueue(store, { message: msg('OK', { detectedLang: 'zh-Hans' }), verdict: 'called', enqueuedAt: Date.now() });
    const d = base({
      typing: async () => false,
      ack: async (_i, t) => {
        d.calls.push(`ack ${t}`);
        return '$note';
      },
    });
    await drain(store, d);
    expect(d.calls[0]).toBe('read');
    expect(['ack 🐶 好，处理中…', 'ack 🐶 收到～', 'ack 🐶 好哦，马上弄']).toContain(d.calls[1]);
    expect(d.calls[2]).toBe('patch $note re: OK');
  });

  it('neither types nor marks anything read for a nudge', async () => {
    const store = new MemoryStore();
    await enqueue(store, { message: msg('[penny nudge] pending #1', { eventId: 'nudge:pending:!a:x:1' }), verdict: 'nudge', enqueuedAt: Date.now() });
    const d = base({});
    await drain(store, d);
    expect(d.calls).toEqual(['post re: [penny nudge] pending #1']);
  });
});
