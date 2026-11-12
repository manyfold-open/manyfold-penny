/**
 * The ledger API end to end: real routes, real SQL, on an in-memory SQLite standing in for D1.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import { FakeD1 } from './support/fake-d1';

const KEY = 'test-ledger-key-0123456789';
const d1 = new FakeD1();
const env = {
  DB: d1,
  PENNY_API_KEY: KEY,
  CONFIG_ENCRYPTION_KEY: 'a-test-encryption-key-that-is-long-enough',
  ASSETS: { fetch: async () => new Response('asset') },
} as unknown as Record<string, unknown>;

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

async function call(method: string, path: string, body?: unknown, options: { key?: string | null; envOverride?: object } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = options.key === undefined ? KEY : options.key;
  if (key) headers.authorization = `Bearer ${key}`;
  const response = await app.fetch(
    new Request(`https://penny.test/api/ledger${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { ...env, ...(options.envOverride ?? {}) },
    ctx,
  );
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

const enc = encodeURIComponent;
// Matrix-style ids, as the chat platform will send them.
const ROOM = '!london:matrix.example';
const G = `/groups/${enc(ROOM)}`;
const ZACK = '@zack:matrix.example';
const MEI = '@mei:matrix.example';
const KEN = '@ken:matrix.example';
const RAY = '@ray:matrix.example';

async function newGroup(room: string, members = [ZACK, MEI, KEN, RAY]) {
  const path = `/groups/${enc(room)}`;
  expect((await call('PUT', path, { name: room, currency: 'GBP' })).status).toBe(200);
  const sync = await call('PUT', `${path}/members`, {
    members: members.map((id) => ({ id, name: id.slice(1, id.indexOf(':')) })),
  });
  expect(sync.status).toBe(200);
  return path;
}

async function addConfirmed(path: string, expense: Record<string, unknown>, confirmer = MEI) {
  const proposed = await call('POST', `${path}/expenses`, expense);
  expect(proposed.status).toBe(201);
  const seq = proposed.json.entry.seq;
  const confirmed = await call('POST', `${path}/entries/${seq}/confirm`, { by: confirmer });
  expect(confirmed.status).toBe(200);
  return seq as number;
}

const netOf = (balances: Record<string, any>, member: string) =>
  balances.nets.find((n: { member: string }) => n.member === member)?.amount ?? 0;

beforeAll(async () => {
  await newGroup(ROOM);
});

describe('access', () => {
  it('requires the API key', async () => {
    expect((await call('GET', G, undefined, { key: null })).status).toBe(401);
    expect((await call('GET', G, undefined, { key: 'wrong-key' })).status).toBe(401);
  });

  it('is switched off without PENNY_API_KEY', async () => {
    const res = await call('GET', G, undefined, { envOverride: { PENNY_API_KEY: '' } });
    expect(res.status).toBe(503);
    expect(res.json.error.code).toBe('ledger_disabled');
  });

  it('accepts agent calls without a browser Origin header', async () => {
    const res = await call('GET', G);
    expect(res.status).toBe(200);
    expect(res.json.members).toHaveLength(4);
  });

  it('reports a group that does not exist', async () => {
    expect((await call('GET', `/groups/${enc('!nope:matrix.example')}/balances`)).json.error.code).toBe('group_not_found');
  });
});

describe('expenses', () => {
  it('only counts an expense once someone confirms it', async () => {
    const path = await newGroup('!confirm:x');
    const proposed = await call('POST', `${path}/expenses`, {
      createdBy: ZACK,
      description: 'Dinner at Dishoom',
      category: 'food',
      amount: 12000,
      paidBy: ZACK,
      split: { method: 'equal', members: [ZACK, MEI, KEN, RAY], adjustments: { [KEN]: -800 } },
    });
    expect(proposed.status).toBe(201);
    expect(proposed.json.entry).toMatchObject({ seq: 1, status: 'pending', amount: 12000 });
    expect((await call('GET', `${path}/balances`)).json.nets).toEqual([]);

    const confirmed = await call('POST', `${path}/entries/1/confirm`, { by: MEI });
    expect(confirmed.json.entry.status).toBe('active');
    const balances = (await call('GET', `${path}/balances`)).json;
    expect(netOf(balances, ZACK)).toBe(12000 - 3200);
    expect(netOf(balances, KEN)).toBe(-2400);

    // A second OK finds nothing left to confirm.
    expect((await call('POST', `${path}/entries/1/confirm`, { by: RAY })).status).toBe(404);
  });

  it('defaults to splitting equally among active members', async () => {
    const path = await newGroup('!default:x');
    const seq = await addConfirmed(path, { createdBy: ZACK, amount: 1000, paidBy: ZACK });
    const [entry] = (await call('GET', `${path}/entries/${seq}`)).json.versions;
    expect(entry.shares.map((s: { amount: number }) => s.amount).sort()).toEqual([250, 250, 250, 250]);
  });

  it('uses the group default split when one is set', async () => {
    const path = await newGroup('!home:x', [ZACK, MEI]);
    await call('PUT', path, { defaultSplit: { method: 'percent', percents: { [ZACK]: 40, [MEI]: 60 } } });
    const seq = await addConfirmed(path, { createdBy: MEI, amount: 9400, paidBy: MEI, category: 'utilities' }, ZACK);
    const [entry] = (await call('GET', `${path}/entries/${seq}`)).json.versions;
    expect(entry.shares).toEqual([
      { member: MEI, amount: 5640 },
      { member: ZACK, amount: 3760 },
    ]);
  });

  it('rejects people who are not in the group', async () => {
    const res = await call('POST', `${G}/expenses`, { createdBy: ZACK, amount: 100, paidBy: '@stranger:x' });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('invalid_member');
  });

  it('records refunds as money coming back', async () => {
    const path = await newGroup('!refund:x');
    await addConfirmed(path, { createdBy: RAY, amount: 40000, paidBy: RAY, category: 'accommodation' });
    await addConfirmed(path, { createdBy: RAY, amount: 10000, paidBy: RAY, kind: 'refund', category: 'accommodation' });
    const balances = (await call('GET', `${path}/balances`)).json;
    // Ray paid 400, got 100 back: the group spent 300, 75 each.
    expect(netOf(balances, RAY)).toBe(30000 - 7500);
    expect(netOf(balances, ZACK)).toBe(-7500);
    const stats = (await call('GET', `${path}/stats`)).json;
    expect(stats.total).toBe(30000);
  });

  it('settles a guest through their sponsor', async () => {
    const path = await newGroup('!guest:x');
    const guest = (await call('POST', `${path}/guests`, { name: 'An', sponsorId: KEN })).json.guest;
    expect(guest.id).toBe('guest:1');
    await addConfirmed(path, {
      createdBy: MEI,
      amount: 9000,
      paidBy: MEI,
      split: { method: 'equal', members: [ZACK, MEI, KEN, RAY, guest.id] },
    });
    const balances = (await call('GET', `${path}/balances`)).json;
    expect(netOf(balances, KEN)).toBe(-3600);
    expect(balances.nets.some((n: { member: string }) => n.member === 'guest:1')).toBe(false);
    const summary = (await call('GET', `${path}/members/${enc(KEN)}/summary`)).json;
    expect(summary).toMatchObject({ paid: 0, share: 3600, net: -3600 });
  });

  it('pages through expenses newest first', async () => {
    const path = await newGroup('!pages:x');
    for (let i = 1; i <= 7; i++) await addConfirmed(path, { createdBy: ZACK, amount: i * 100, paidBy: ZACK });
    const first = (await call('GET', `${path}/expenses?limit=5`)).json;
    expect(first.entries.map((e: { seq: number }) => e.seq)).toEqual([7, 6, 5, 4, 3]);
    expect(first.more).toBe(true);
    expect(first.total).toBe(2500);
    const second = (await call('GET', `${path}/expenses?limit=5&before=3`)).json;
    expect(second.entries.map((e: { seq: number }) => e.seq)).toEqual([2, 1]);
    expect(second.more).toBe(false);
  });
});

describe('edits and deletions', () => {
  it('keeps the old version and shows it next to the proposed change', async () => {
    const path = await newGroup('!edit:x');
    const seq = await addConfirmed(path, { createdBy: ZACK, description: 'Dinner', amount: 12000, paidBy: ZACK });
    const proposed = await call('POST', `${path}/expenses/${seq}/edit`, { createdBy: RAY, amount: 14000 });
    expect(proposed.status).toBe(201);
    expect(proposed.json.entry).toMatchObject({ seq, version: 2, status: 'pending', amount: 14000 });
    expect(proposed.json.entry.previous).toMatchObject({ version: 1, amount: 12000 });
    expect(proposed.json.entry.payers).toEqual([{ member: ZACK, amount: 14000 }]);

    // A second change cannot be stacked on top while one is waiting.
    expect((await call('POST', `${path}/expenses/${seq}/edit`, { createdBy: MEI, amount: 1 })).status).toBe(409);

    await call('POST', `${path}/entries/${seq}/confirm`, { by: ZACK });
    const versions = (await call('GET', `${path}/entries/${seq}`)).json.versions;
    expect(versions.map((v: { status: string }) => v.status)).toEqual(['superseded', 'active']);
    expect(netOf((await call('GET', `${path}/balances`)).json, ZACK)).toBe(14000 - 3500);
  });

  it('deletes by voiding, and a cancelled change leaves the entry alone', async () => {
    const path = await newGroup('!delete:x');
    const seq = await addConfirmed(path, { createdBy: ZACK, amount: 800, paidBy: ZACK });
    await call('POST', `${path}/expenses/${seq}/delete`, { createdBy: MEI });
    await call('POST', `${path}/entries/${seq}/cancel`, { by: MEI });
    expect(netOf((await call('GET', `${path}/balances`)).json, ZACK)).toBe(600);

    await call('POST', `${path}/expenses/${seq}/delete`, { createdBy: MEI });
    const pending = (await call('GET', `${path}/pending`)).json.entries;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ type: 'void', previous: { amount: 800 } });
    await call('POST', `${path}/entries/${seq}/confirm`, { by: KEN });
    expect((await call('GET', `${path}/balances`)).json.nets).toEqual([]);
    const statuses = (await call('GET', `${path}/entries/${seq}`)).json.versions.map((v: { status: string }) => v.status);
    expect(statuses).toEqual(['superseded', 'cancelled', 'voided']);
  });
});

describe('settling up', () => {
  it('only the receiver can confirm a repayment, and partial repayments leave the rest owed', async () => {
    const path = await newGroup('!settle:x');
    await addConfirmed(path, { createdBy: ZACK, amount: 70000, paidBy: ZACK, split: { method: 'equal', members: [ZACK, MEI] } });
    const repayment = await call('POST', `${path}/settlements`, { createdBy: MEI, from: MEI, to: ZACK, amount: 5000 });
    expect(repayment.json.entry).toMatchObject({ type: 'settlement', status: 'pending' });
    const seq = repayment.json.entry.seq;

    const wrong = await call('POST', `${path}/entries/${seq}/confirm`, { by: MEI });
    expect(wrong.status).toBe(403);
    expect(wrong.json.error.code).toBe('receiver_must_confirm');

    await call('POST', `${path}/entries/${seq}/confirm`, { by: ZACK });
    const balances = (await call('GET', `${path}/balances`)).json;
    expect(balances.transfers).toEqual([{ from: MEI, to: ZACK, amount: 30000 }]);
  });

  it('produces the fewest transfers for the whole group', async () => {
    const path = await newGroup('!trip:x');
    await addConfirmed(path, { createdBy: ZACK, amount: 96000, paidBy: ZACK, category: 'accommodation' });
    await addConfirmed(path, { createdBy: KEN, amount: 52500, paidBy: KEN, category: 'transport' });
    await addConfirmed(path, { createdBy: RAY, amount: 64000, paidBy: RAY, category: 'food' });
    await addConfirmed(path, { createdBy: MEI, amount: 27500, paidBy: MEI, category: 'tickets' });
    const balances = (await call('GET', `${path}/balances`)).json;
    expect(balances.nets.reduce((a: number, n: { amount: number }) => a + n.amount, 0)).toBe(0);
    expect(balances.transfers.length).toBeLessThanOrEqual(3);
    const stats = (await call('GET', `${path}/stats`)).json;
    expect(stats).toMatchObject({ total: 240000, count: 4, members: 4 });
    expect(stats.byCategory[0]).toEqual({ category: 'accommodation', amount: 96000 });
  });
});

describe('isolation between groups', () => {
  it('never shows one group the entries of another', async () => {
    const a = await newGroup('!a:x');
    const b = await newGroup('!b:x', [ZACK, MEI]);
    await addConfirmed(a, { createdBy: ZACK, amount: 4000, paidBy: ZACK });
    expect((await call('GET', `${b}/entries/1`)).status).toBe(404);
    expect((await call('GET', `${b}/balances`)).json.nets).toEqual([]);
    expect((await call('GET', `${b}/expenses`)).json.entries).toEqual([]);
    // Confirming in B cannot touch A's pending entry with the same number.
    await call('POST', `${a}/expenses`, { createdBy: ZACK, amount: 100, paidBy: ZACK });
    expect((await call('POST', `${b}/entries/2/confirm`, { by: MEI })).status).toBe(404);
  });

  it('adds up one person across their groups only in the overview', async () => {
    const trip = await newGroup('!overview-trip:x');
    const home = await newGroup('!overview-home:x', [ZACK, MEI]);
    await addConfirmed(trip, { createdBy: ZACK, amount: 20000, paidBy: ZACK, split: { method: 'equal', members: [ZACK, MEI] } });
    await addConfirmed(home, { createdBy: MEI, amount: 6000, paidBy: MEI, split: { method: 'equal', members: [ZACK, MEI] } }, ZACK);
    const overview = (await call('GET', `/people/${enc(ZACK)}/overview?with=${enc(MEI)}`)).json;
    const byName = Object.fromEntries(overview.groups.map((g: { name: string; withOther: number }) => [g.name, g.withOther]));
    expect(byName['!overview-trip:x']).toBe(10000);
    expect(byName['!overview-home:x']).toBe(-3000);
  });
});

describe('memory and payment details', () => {
  it('caps learned habits per group', async () => {
    const path = await newGroup('!memory:x');
    for (let i = 0; i < 20; i++) expect((await call('PUT', `${path}/memory/k${i}`, { value: `v${i}` })).status).toBe(200);
    expect((await call('PUT', `${path}/memory/one-more`, { value: 'x' })).status).toBe(409);
    expect((await call('PUT', `${path}/memory/k1`, { value: 'updated' })).status).toBe(200);
    await call('DELETE', `${path}/memory/k0`);
    const memory = (await call('GET', `${path}/memory`)).json.memory;
    expect(memory).toHaveLength(19);
    expect(memory.find((m: { key: string }) => m.key === 'k1').value).toBe('updated');
  });

  it('stores payment details encrypted', async () => {
    await call('PUT', `/people/${enc(MEI)}/payment-info`, { info: 'Monzo 04-00-04 12345678' });
    expect((await call('GET', `/people/${enc(MEI)}/payment-info`)).json.info).toBe('Monzo 04-00-04 12345678');
    const raw = await d1.prepare('SELECT info_ct FROM ledger_payment_info WHERE member_id = ?').bind(MEI).first<{ info_ct: string }>();
    expect(raw!.info_ct).not.toContain('Monzo');
  });
});
