/**
 * The ledger API, mounted at /api/ledger. Called by the Penny agent, not by browsers.
 *
 * Every request needs `Authorization: Bearer <PENNY_API_KEY>`. Without that secret the
 * ledger is switched off (503), so a fresh deploy never exposes an open ledger.
 *
 * Group and member ids come from the chat platform (Matrix room and user ids contain
 * `!`, `@` and `:`), so callers must URL-encode them in paths.
 *
 *   PUT    /groups/:g                         create the ledger or change its settings
 *   GET    /groups/:g                         settings and members
 *   PUT    /groups/:g/members                 sync members from the chat
 *   POST   /groups/:g/guests                  add someone outside the chat
 *   POST   /groups/:g/expenses                propose an expense or refund
 *   GET    /groups/:g/expenses                confirmed expenses, newest first (?limit, ?before)
 *   POST   /groups/:g/expenses/:seq/edit      propose a change
 *   POST   /groups/:g/expenses/:seq/delete    propose a deletion
 *   POST   /groups/:g/settlements             propose a repayment
 *   GET    /groups/:g/pending                 everything waiting for an OK
 *   GET    /groups/:g/entries/:seq            every version of #seq
 *   POST   /groups/:g/entries/:seq/confirm    confirm the pending change on #seq
 *   POST   /groups/:g/entries/:seq/cancel     drop it
 *   GET    /groups/:g/balances                net positions and the settle-up plan
 *   GET    /groups/:g/members/:m/summary      what one person paid versus their share
 *   GET    /groups/:g/stats                   totals by category and day (?from, ?to)
 *   GET    /groups/:g/memory                  learned habits
 *   PUT    /groups/:g/memory/:key             remember one
 *   DELETE /groups/:g/memory/:key             forget one
 *   POST   /groups/:g/share                   the group's read-only page link ({by, rotate?})
 *   PUT    /people/:m/payment-info            how someone likes to be paid
 *   GET    /people/:m/payment-info
 *   DELETE /people/:m/payment-info
 *   GET    /people/:m/overview                that person in every group (?with=<other member>)
 */

import { Hono, type Context } from 'hono';
import { safeEqual } from '../crypto';
import { HttpError, type Env } from '../types';
import * as store from './store';
import { shareLink } from './share';

type Ctx = Context<{ Bindings: Env }>;

const ledger = new Hono<{ Bindings: Env }>();

/**
 * Several people can talk at once, and each message is its own agent turn, so two turns can
 * change the same entry together (two edits of #21 at the same moment). The UNIQUE keys on
 * the ledger tables let only one through. This turns the other one's constraint error into
 * a 409 the agent can explain, instead of an internal error.
 */
export function concurrentChange(error: unknown): HttpError | null {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(message)
    ? new HttpError(409, 'concurrent_change', 'Someone changed this at the same moment. Look again and retry.')
    : null;
}

ledger.use('*', async (c, next) => {
  const key = (c.env.PENNY_API_KEY ?? '').trim();
  if (!key) throw new HttpError(503, 'ledger_disabled', 'The ledger is off until PENNY_API_KEY is set.');
  const header = c.req.header('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented || !safeEqual(presented, key)) {
    throw new HttpError(401, 'unauthorized', 'A valid ledger API key is required.');
  }
  await next();
});


async function body(c: Ctx): Promise<Record<string, unknown>> {
  const parsed = await c.req.json().catch(() => null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'bad_request', 'The body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function seqParam(c: Ctx): number {
  const seq = Number(c.req.param('seq'));
  if (!Number.isSafeInteger(seq) || seq < 1) throw new HttpError(400, 'bad_request', 'The entry number must be a positive integer.');
  return seq;
}

const g = (c: Ctx) => c.req.param('g') as string;
const actor = (b: Record<string, unknown>, field = 'createdBy') => b[field] as string;

/* groups and members */

ledger.put('/groups/:g', async (c) => c.json({ group: await store.upsertGroup(c.env, g(c), await body(c)) }));

ledger.get('/groups/:g', async (c) => {
  const group = await store.getGroup(c.env, g(c));
  // today is the group's date in its own time zone, so Penny never works out "this week" from UTC.
  return c.json({ group, today: store.today(group.timezone), members: await store.listMembers(c.env, group.id) });
});

ledger.put('/groups/:g/members', async (c) => {
  const b = await body(c);
  return c.json({ members: await store.syncMembers(c.env, g(c), b.members as { id: string; name: string }[], b.complete === true) });
});

ledger.post('/groups/:g/guests', async (c) => {
  const b = await body(c);
  return c.json({ guest: await store.addGuest(c.env, g(c), b.name as string, b.sponsorId as string) }, 201);
});

/* proposing */

ledger.post('/groups/:g/expenses', async (c) => {
  const b = await body(c);
  return c.json({ entry: await store.proposeExpense(c.env, g(c), actor(b), b as store.ExpenseInput) }, 201);
});

ledger.get('/groups/:g/expenses', async (c) =>
  c.json(
    await store.listExpenses(c.env, g(c), {
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
      before: c.req.query('before') ? Number(c.req.query('before')) : undefined,
    }),
  ),
);

ledger.post('/groups/:g/expenses/:seq/edit', async (c) => {
  const b = await body(c);
  return c.json({ entry: await store.proposeEdit(c.env, g(c), seqParam(c), actor(b), b as store.ExpenseInput) }, 201);
});

ledger.post('/groups/:g/expenses/:seq/delete', async (c) => {
  const b = await body(c);
  return c.json({ entry: await store.proposeDelete(c.env, g(c), seqParam(c), actor(b)) }, 201);
});

ledger.post('/groups/:g/settlements', async (c) => {
  const b = await body(c);
  return c.json(
    { entry: await store.proposeSettlement(c.env, g(c), actor(b), b as { from?: string; to?: string; amount?: number }) },
    201,
  );
});

/* confirming */

ledger.get('/groups/:g/pending', async (c) => c.json({ entries: await store.listPending(c.env, g(c)) }));

ledger.get('/groups/:g/entries/:seq', async (c) => c.json({ versions: await store.getEntry(c.env, g(c), seqParam(c)) }));

ledger.post('/groups/:g/entries/:seq/confirm', async (c) => {
  const b = await body(c);
  return c.json({ entry: await store.confirm(c.env, g(c), seqParam(c), actor(b, 'by')) });
});

ledger.post('/groups/:g/entries/:seq/cancel', async (c) => {
  const b = await body(c);
  await store.cancel(c.env, g(c), seqParam(c), actor(b, 'by'));
  return c.json({ ok: true });
});

/* reading */

ledger.get('/groups/:g/balances', async (c) => c.json(await store.balances(c.env, g(c))));

ledger.get('/groups/:g/members/:m/summary', async (c) =>
  c.json(await store.memberSummary(c.env, g(c), c.req.param('m') as string)),
);

ledger.get('/groups/:g/stats', async (c) =>
  c.json(await store.stats(c.env, g(c), { from: c.req.query('from'), to: c.req.query('to') })),
);

/* memory */

ledger.get('/groups/:g/memory', async (c) => c.json({ memory: await store.listMemory(c.env, g(c)) }));

ledger.put('/groups/:g/memory/:key', async (c) => {
  const b = await body(c);
  await store.putMemory(c.env, g(c), c.req.param('key') as string, b.value);
  return c.json({ ok: true });
});

ledger.delete('/groups/:g/memory/:key', async (c) => {
  await store.deleteMemory(c.env, g(c), c.req.param('key') as string);
  return c.json({ ok: true });
});

/* people */

ledger.put('/people/:m/payment-info', async (c) => {
  const b = await body(c);
  await store.setPaymentInfo(c.env, c.req.param('m') as string, b.info);
  return c.json({ ok: true });
});

ledger.get('/people/:m/payment-info', async (c) => c.json({ info: await store.getPaymentInfo(c.env, c.req.param('m') as string) }));

ledger.delete('/people/:m/payment-info', async (c) => {
  await store.deletePaymentInfo(c.env, c.req.param('m') as string);
  return c.json({ ok: true });
});

ledger.get('/people/:m/overview', async (c) =>
  c.json(await store.overview(c.env, c.req.param('m') as string, c.req.query('with') || undefined)),
);

ledger.post('/groups/:g/share', async (c) => {
  const b = await body(c);
  return c.json(await shareLink(c.env, g(c), b.by as string, new URL(c.req.url).origin, b.rotate === true));
});

export default ledger;
