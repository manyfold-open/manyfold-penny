/**
 * Group use cases, edge cases and stress, run against the real routes on in-memory SQLite.
 * Every test asserts the behaviour we WANT; a failure here is a finding, not a flaky test.
 */
import { describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import { FakeD1 } from './support/fake-d1';
import { classify } from '../src/worker/gateway/filter';
import type { InboundMessage } from '../src/worker/gateway/inbound';
import { computeShares } from '../src/worker/ledger/money';

const KEY = 'test-ledger-key-0123456789';
const env = {
  DB: new FakeD1(),
  PENNY_API_KEY: KEY,
  CONFIG_ENCRYPTION_KEY: 'a-test-encryption-key-that-is-long-enough',
  ASSETS: { fetch: async () => new Response('asset') },
} as unknown as Record<string, unknown>;
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

async function call(method: string, path: string, body?: unknown) {
  const res = await app.fetch(
    new Request(`https://penny.test/api/ledger${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
  );
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

const enc = encodeURIComponent;
const id = (name: string) => `@${name}:x`;
let rooms = 0;

async function group(names: string[], currency = 'TWD') {
  const path = `/groups/${enc(`!room${++rooms}:x`)}`;
  expect((await call('PUT', path, { name: `room ${rooms}`, currency })).status).toBe(200);
  expect((await call('PUT', `${path}/members`, { members: names.map((n) => ({ id: id(n), name: n })) })).status).toBe(200);
  return path;
}

async function add(path: string, body: Record<string, unknown>, by = id('mei')) {
  const p = await call('POST', `${path}/expenses`, body);
  expect(p.status, JSON.stringify(p.json)).toBe(201);
  const c = await call('POST', `${path}/entries/${p.json.entry.seq}/confirm`, { by });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  return p.json.entry.seq as number;
}

const net = (b: Record<string, any>, who: string) => b.nets.find((n: any) => n.member === id(who))?.amount ?? 0;

/* ───────── use cases ───────── */

describe('use case: 4-person trip to Tokyo', () => {
  it('dinner, taxi, hotel with two payers, receipt without alcohol, refund, guest, then settle up to zero', async () => {
    const g = await group(['zack', 'mei', 'ken', 'ray'], 'JPY');
    const Z = id('zack');
    await add(g, { createdBy: Z, description: '燒肉', category: 'food', amount: 24000, paidBy: Z });
    await add(g, { createdBy: id('ken'), description: 'taxi', category: 'transport', amount: 3500, paidBy: id('ken') });
    await add(g, {
      createdBy: Z,
      description: 'hotel',
      category: 'accommodation',
      amount: 80000,
      payers: [
        { member: Z, amount: 50000 },
        { member: id('mei'), amount: 30000 },
      ],
    });
    // Izakaya receipt: Ken and Ray skip the beer, 10% service on top.
    await add(g, {
      createdBy: id('ray'),
      description: 'izakaya',
      category: 'food',
      amount: 11000,
      paidBy: id('ray'),
      split: {
        method: 'items',
        everyone: [Z, id('mei'), id('ken'), id('ray')],
        items: [
          { amount: 8000, label: 'food' },
          { amount: 2000, label: 'beer', members: [Z, id('mei')] },
        ],
        extra: 1000,
      },
    });
    await add(g, { createdBy: Z, description: 'ticket refund', kind: 'refund', category: 'tickets', amount: 4000, paidBy: Z });
    const guest = await call('POST', `${g}/guests`, { name: 'Ken 女友', sponsorId: id('ken') });
    expect(guest.status).toBe(201);
    await add(g, {
      createdBy: Z,
      description: 'karaoke',
      category: 'other',
      amount: 10000,
      paidBy: Z,
      split: { method: 'equal', members: [Z, id('mei'), id('ken'), id('ray'), guest.json.guest.id] },
    });

    let b = (await call('GET', `${g}/balances`)).json;
    expect(b.nets.reduce((a: number, n: any) => a + n.amount, 0)).toBe(0);
    expect(b.transfers.length).toBeLessThanOrEqual(3);
    expect(b.nets.some((n: any) => n.member.startsWith('guest:'))).toBe(false);

    // Everyone pays the plan, receivers confirm.
    for (const t of b.transfers) {
      const s = await call('POST', `${g}/settlements`, { createdBy: t.from, from: t.from, to: t.to, amount: t.amount });
      expect(s.status).toBe(201);
      expect((await call('POST', `${g}/entries/${s.json.entry.seq}/confirm`, { by: t.to })).status).toBe(200);
    }
    b = (await call('GET', `${g}/balances`)).json;
    expect(b.nets).toEqual([]);
    expect(b.transfers).toEqual([]);
  });
});

describe('use case: roommates', () => {
  it('rent by room size (shares), utilities by percent, one roommate moves out', async () => {
    const g = await group(['a', 'b', 'c']);
    await add(g, {
      createdBy: id('a'),
      category: 'rent',
      amount: 30000,
      paidBy: id('a'),
      split: { method: 'shares', shares: { [id('a')]: 1.5, [id('b')]: 1, [id('c')]: 1 } },
    }, id('b'));
    await add(
      g,
      {
        createdBy: id('b'),
        category: 'utilities',
        amount: 1001,
        paidBy: id('b'),
        split: { method: 'percent', percents: { [id('a')]: 33.33, [id('b')]: 33.33, [id('c')]: 33.34 } },
      },
      id('a'),
    );
    // c moves out: chat sync without c.
    const sync = await call('PUT', `${g}/members`, {
      members: [
        { id: id('a'), name: 'a' },
        { id: id('b'), name: 'b' },
      ],
      complete: true,
    });
    expect(sync.json.members.find((m: any) => m.id === id('c')).active).toBe(false);
    const b = (await call('GET', `${g}/balances`)).json;
    expect(net(b, 'c')).toBeLessThan(0); // c still owes after leaving
    expect(b.nets.reduce((a: number, n: any) => a + n.amount, 0)).toBe(0);
  });
});

/* ───────── edge cases ───────── */

describe('edge: inputs', () => {
  it('rejects bad amounts with a 400, not a 500', async () => {
    const g = await group(['a', 'b']);
    for (const amount of [0, -1, 12.5, '100', null, 10_000_000_001, Number.MAX_SAFE_INTEGER, 1e400]) {
      const r = await call('POST', `${g}/expenses`, { createdBy: id('a'), paidBy: id('a'), amount });
      expect(r.status, `amount ${amount}`).toBe(400);
    }
  });

  it('rejects impossible calendar dates', async () => {
    const g = await group(['a', 'b']);
    const r = await call('POST', `${g}/expenses`, { createdBy: id('a'), paidBy: id('a'), amount: 100, spentOn: '2026-02-30' });
    expect(r.status).toBe(400);
  });

  it('answers a non-numeric ?limit with a page, not a 500', async () => {
    const g = await group(['a', 'b']);
    const r = await call('GET', `${g}/expenses?limit=abc`);
    expect(r.status).toBe(200);
  });

  it('rejects malformed JSON and arrays', async () => {
    const g = await group(['a', 'b']);
    const r = await app.fetch(
      new Request(`https://penny.test/api/ledger${g}/expenses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: '{bad',
      }),
      env,
      ctx,
    );
    expect(r.status).toBe(400);
    expect((await call('POST', `${g}/expenses`, [1, 2])).status).toBe(400);
  });

  it('keeps a long receipt (items x amount) exact at the top of the range', () => {
    // Large items + large service charge: extra * subtotal goes past 2^53.
    const shares = computeShares(9_000_000_000, {
      method: 'items',
      everyone: ['a', 'b', 'c'],
      items: [
        { amount: 3_000_000_001 },
        { amount: 2_999_999_999, members: ['a'] },
      ],
      extra: 3_000_000_000,
    });
    expect(Object.values(shares).reduce((x, y) => x + y, 0)).toBe(9_000_000_000);
  });

  it('a 1-cent expense split among 60 people still adds up', async () => {
    const names = Array.from({ length: 60 }, (_, i) => `m${i}`);
    const g = await group(names);
    await add(g, { createdBy: id('m0'), paidBy: id('m0'), amount: 1 }, id('m1'));
    const b = (await call('GET', `${g}/balances`)).json;
    expect(b.nets.reduce((a: number, n: any) => a + n.amount, 0)).toBe(0);
    expect((await call('PUT', `${g}/members`, { members: [...names, 'x'].map((n) => ({ id: id(n), name: n })) })).status).toBe(400);
  });
});

describe('edge: people leave', () => {
  it('a typo in an old expense can still be fixed after someone in it leaves the chat', async () => {
    const g = await group(['a', 'b', 'c']);
    const seq = await add(g, { createdBy: id('a'), paidBy: id('a'), amount: 900, description: 'dinnr' }, id('b'));
    await call('PUT', `${g}/members`, { members: [{ id: id('a'), name: 'a' }, { id: id('b'), name: 'b' }], complete: true });
    const r = await call('POST', `${g}/expenses/${seq}/edit`, { createdBy: id('a'), description: 'dinner' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
  });

  it('a group default split naming someone who left does not block every new expense', async () => {
    const g = await group(['a', 'b', 'c']);
    await call('PUT', g, { defaultSplit: { method: 'shares', shares: { [id('a')]: 2, [id('b')]: 1, [id('c')]: 1 } } });
    await call('PUT', `${g}/members`, { members: [{ id: id('a'), name: 'a' }, { id: id('b'), name: 'b' }], complete: true });
    const r = await call('POST', `${g}/expenses`, { createdBy: id('a'), paidBy: id('a'), amount: 400 });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
  });

  it('someone who left cannot confirm', async () => {
    const g = await group(['a', 'b', 'c']);
    const p = await call('POST', `${g}/expenses`, { createdBy: id('a'), paidBy: id('a'), amount: 300 });
    await call('PUT', `${g}/members`, { members: [{ id: id('a'), name: 'a' }, { id: id('b'), name: 'b' }], complete: true });
    expect((await call('POST', `${g}/entries/${p.json.entry.seq}/confirm`, { by: id('c') })).status).toBe(400);
  });
});

describe('edge: lifecycle', () => {
  it('confirm twice, cancel after confirm, edit a voided entry: all clean 4xx', async () => {
    const g = await group(['a', 'b']);
    const seq = await add(g, { createdBy: id('a'), paidBy: id('a'), amount: 500 }, id('b'));
    expect((await call('POST', `${g}/entries/${seq}/confirm`, { by: id('b') })).status).toBe(404);
    expect((await call('POST', `${g}/entries/${seq}/cancel`, { by: id('b') })).status).toBe(404);
    await call('POST', `${g}/expenses/${seq}/delete`, { createdBy: id('a') });
    expect((await call('POST', `${g}/entries/${seq}/confirm`, { by: id('b') })).status).toBe(200);
    expect((await call('POST', `${g}/expenses/${seq}/edit`, { createdBy: id('a'), amount: 1 })).status).toBe(409);
    expect((await call('POST', `${g}/expenses/9999/edit`, { createdBy: id('a'), amount: 1 })).status).toBe(404);
  });

  it('changing the amount of an exact split is refused with a clear 400 (Penny must resend the split)', async () => {
    const g = await group(['a', 'b']);
    const seq = await add(g, {
      createdBy: id('a'),
      paidBy: id('a'),
      amount: 1000,
      split: { method: 'exact', amounts: { [id('a')]: 300, [id('b')]: 700 } },
    }, id('b'));
    const r = await call('POST', `${g}/expenses/${seq}/edit`, { createdBy: id('a'), amount: 1200 });
    expect(r.status).toBe(400);
  });

  it('currency cannot change once repayments are recorded', async () => {
    const g = await group(['a', 'b'], 'GBP');
    const s = await call('POST', `${g}/settlements`, { createdBy: id('a'), from: id('a'), to: id('b'), amount: 5000 });
    await call('POST', `${g}/entries/${s.json.entry.seq}/confirm`, { by: id('b') });
    const r = await call('PUT', g, { currency: 'JPY' });
    expect(r.status).toBe(409);
  });

  it('a memory saved with spaces around its key can be forgotten by the same key', async () => {
    const g = await group(['a', 'b']);
    await call('PUT', `${g}/memory/${enc(' no alcohol ')}`, { value: 'Ken skips beer' });
    expect((await call('DELETE', `${g}/memory/${enc(' no alcohol ')}`)).status).toBe(200);
  });
});

/* ───────── concurrency and stress ───────── */

describe('stress: many people at once', () => {
  it('50 simultaneous proposals get 50 different entry numbers', async () => {
    const g = await group(['a', 'b', 'c', 'd']);
    const rs = await Promise.all(
      Array.from({ length: 50 }, (_, i) => call('POST', `${g}/expenses`, { createdBy: id('a'), paidBy: id('a'), amount: 100 + i })),
    );
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.json.entry.seq)).size).toBe(50);
  });

  it('confirm and cancel at the same moment: exactly one wins', async () => {
    const g = await group(['a', 'b', 'c']);
    for (let i = 0; i < 20; i++) {
      const p = await call('POST', `${g}/expenses`, { createdBy: id('a'), paidBy: id('a'), amount: 300 });
      const seq = p.json.entry.seq;
      const [c, x] = await Promise.all([
        call('POST', `${g}/entries/${seq}/confirm`, { by: id('b') }),
        call('POST', `${g}/entries/${seq}/cancel`, { by: id('c') }),
      ]);
      expect([c.status, x.status].filter((s) => s === 200)).toHaveLength(1);
      const versions = (await call('GET', `${g}/entries/${seq}`)).json.versions;
      expect(versions).toHaveLength(1);
      expect(['active', 'cancelled']).toContain(versions[0].status);
    }
  });

  it('two people OK the same entry together: counted once', async () => {
    const g = await group(['a', 'b', 'c']);
    const p = await call('POST', `${g}/expenses`, { createdBy: id('a'), paidBy: id('a'), amount: 900 });
    const rs = await Promise.all([id('b'), id('c')].map((by) => call('POST', `${g}/entries/${p.json.entry.seq}/confirm`, { by })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(net((await call('GET', `${g}/balances`)).json, 'a')).toBe(600);
  });

  it('random month of a 12-person group: 600 operations keep every invariant', { timeout: 120_000 }, async () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const names = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const ids = names.map(id);
    const g = await group(names);
    const seqs: number[] = [];
    let errors500 = 0;
    const t0 = Date.now();
    for (let i = 0; i < 600; i++) {
      const who = pick(ids);
      const op = rnd();
      let r;
      if (op < 0.55 || seqs.length === 0) {
        const members = ids.filter(() => rnd() < 0.6);
        if (members.length === 0) members.push(who);
        const methods = [
          { method: 'equal', members },
          { method: 'shares', shares: Object.fromEntries(members.map((m) => [m, 1 + Math.floor(rnd() * 3)])) },
        ];
        r = await call('POST', `${g}/expenses`, {
          createdBy: who,
          paidBy: who,
          amount: 1 + Math.floor(rnd() * 500_000),
          split: pick(methods),
          category: pick(['food', 'transport', 'drinks']),
        });
        if (r.status === 201) seqs.push(r.json.entry.seq);
      } else if (op < 0.7) {
        r = await call('POST', `${g}/expenses/${pick(seqs)}/edit`, { createdBy: who, amount: 1 + Math.floor(rnd() * 300_000) });
      } else if (op < 0.78) {
        r = await call('POST', `${g}/expenses/${pick(seqs)}/delete`, { createdBy: who });
      } else if (op < 0.85) {
        const to = pick(ids.filter((x) => x !== who));
        r = await call('POST', `${g}/settlements`, { createdBy: who, from: who, to, amount: 1 + Math.floor(rnd() * 100_000) });
        if (r.status === 201) {
          const c = await call('POST', `${g}/entries/${r.json.entry.seq}/confirm`, { by: rnd() < 0.8 ? to : who });
          if (c.status >= 500) errors500++;
        }
      } else {
        const pending = (await call('GET', `${g}/pending`)).json.entries as any[];
        if (pending.length > 0) {
          const e = pick(pending);
          r = await call('POST', `${g}/entries/${e.seq}/${rnd() < 0.85 ? 'confirm' : 'cancel'}`, { by: who });
        }
      }
      if (r && r.status >= 500) errors500++;
    }
    const elapsed = Date.now() - t0;
    expect(errors500).toBe(0);
    const b = (await call('GET', `${g}/balances`));
    expect(b.status).toBe(200);
    expect(b.json.nets.reduce((a: number, n: any) => a + n.amount, 0)).toBe(0);
    expect(b.json.transfers.length).toBeLessThanOrEqual(11);
    // No entry ever has two active versions or more than one pending.
    for (const seq of seqs) {
      const v = (await call('GET', `${g}/entries/${seq}`)).json.versions as any[];
      expect(v.filter((x) => x.status === 'active').length, `#${seq}`).toBeLessThanOrEqual(1);
      expect(v.filter((x) => x.status === 'pending').length, `#${seq}`).toBeLessThanOrEqual(1);
    }
    // Paging walks every active expense exactly once.
    const seen = new Set<number>();
    let before: number | undefined;
    for (;;) {
      const page = (await call('GET', `${g}/expenses?limit=20${before ? `&before=${before}` : ''}`)).json;
      for (const e of page.entries) {
        expect(seen.has(e.seq)).toBe(false);
        seen.add(e.seq);
      }
      if (!page.more) break;
      before = page.entries[page.entries.length - 1].seq;
    }
    const stats = (await call('GET', `${g}/stats`)).json;
    expect(stats.count).toBe(seen.size);
    console.log(`600 ops in ${elapsed} ms, ${seen.size} active expenses, ${b.json.transfers.length} transfers`);
  });

  it('a person in 55 groups sees the 50 most recent and is told 5 were left out', async () => {
    const paths: string[] = [];
    for (let i = 0; i < 55; i++) paths.push(await group(['lots', 'other']));
    // The first group becomes the most recently active, so it must be in the overview.
    await new Promise((r) => setTimeout(r, 5));
    await call('PUT', paths[0], { name: 'oldest but busy' });
    const o = (await call('GET', `/people/${enc(id('lots'))}/overview`)).json;
    expect(o.groups.length).toBe(50);
    expect(o.more).toBe(5);
    expect(o.groups.some((g: any) => g.name === 'oldest but busy')).toBe(true);
  });
});

/* ───────── the gateway filter on real group chatter ───────── */

describe('filter: everyday group messages', () => {
  const BOT = { matrixId: '@agent-1:x', names: ['Penny'] };
  let n = 0;
  const m = (text: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({
    roomId: '!r:x',
    roomName: '',
    chatType: 'group',
    eventId: `$e${++n}`,
    senderId: '@zack:x',
    senderName: 'Zack',
    text,
    time: '2026-11-13T00:00:00.000Z',
    mentions: [],
    ...extra,
  });

  it.each(['好喔', 'OK啦', '收到', '收到了', '👍', '+1', '可', '沒錯', '對啊', 'ok 👍', '改成 50 元', '好 #21'])(
    'treats "%s" as an answer to Penny',
    (text) => {
      expect(classify(m(text), BOT)).toBe('called');
    },
  );

  it('treats a 👍 reaction with an emoji variation selector as an OK', () => {
    expect(classify(m('👍️', { kind: 'reaction', replyTo: '$p', replyToPenny: '#21' }), BOT)).toBe('called');
  });

  it.each(['晚餐 1200 我付的', 'Ken 欠我 200', '我先墊 3000', '計程車 450 我出', 'paid 30 for lunch', 'NT$500 門票'])(
    'passes "%s" on as an expense',
    (text) => {
      expect(classify(m(text), BOT)).toBe('expense');
    },
  );

  it.each(['哈哈哈 2 次', 'the power went out at 9', '明天 10 點見', '3 個人要來嗎'])('skips "%s"', (text) => {
    expect(classify(m(text), BOT)).toBe('skip');
  });
});
