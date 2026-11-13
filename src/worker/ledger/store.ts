/**
 * The ledger's storage and rules. Every function takes the group id explicitly and every
 * query filters on it: there is no way to read or write a group without naming it.
 *
 * Changes to money (a new expense, an edit, a deletion, a repayment) are proposed first
 * and only take effect when someone in the group confirms them. Edits and deletions never
 * overwrite: they add a new version and mark the old one superseded.
 */

import { now } from '../db';
import { seal, unseal } from '../crypto';
import { HttpError, type Env } from '../types';
import {
  assertAmount,
  checkPayers,
  computeShares,
  minorUnitFor,
  simplifyDebts,
  type Payer,
  type SplitSpec,
  type Transfer,
} from './money';

/* ───────── shapes ───────── */

export interface Group {
  id: string;
  name: string;
  currency: string;
  minorUnit: number;
  botName: string;
  defaultSplit: SplitSpec | null;
  simplify: boolean;
  /** IANA time zone, e.g. Asia/Taipei. "Today" means today here. */
  timezone: string;
}

export interface Member {
  id: string;
  name: string;
  isGuest: boolean;
  sponsorId: string | null;
  active: boolean;
}

export interface Line {
  member: string;
  amount: number;
}

export interface Entry {
  seq: number;
  version: number;
  type: 'expense' | 'refund' | 'void' | 'settlement';
  status: string;
  description: string;
  category: string;
  amount: number;
  currency: string;
  spentOn: string;
  payers: Line[];
  shares: Line[];
  receiptRef: string | null;
  /** How the amount was split, as given. Receipts keep their items here. Null for settlements and voids. */
  split: SplitSpec | null;
  createdBy: string;
  confirmedBy: string | null;
  createdAt: string;
  /** For a pending edit or deletion: the version it would replace. */
  previous?: Entry;
}

export interface ExpenseInput {
  description?: string;
  category?: string;
  /** Minor units. */
  amount?: number;
  kind?: 'expense' | 'refund';
  /** YYYY-MM-DD. Defaults to today (UTC). */
  spentOn?: string;
  /** Who paid. Either a single member id or a list adding up to the amount. */
  paidBy?: string;
  payers?: Payer[];
  /** How to split. Defaults to the group's default split, then to everyone equally. */
  split?: SplitSpec;
  receiptRef?: string | null;
}

/* ───────── helpers ───────── */

const notFound = (code: string, message: string): never => {
  throw new HttpError(404, code, message);
};
const conflict = (code: string, message: string): never => {
  throw new HttpError(409, code, message);
};
const invalid = (code: string, message: string): never => {
  throw new HttpError(400, code, message);
};

const CATEGORIES = new Set([
  'food',
  'drinks',
  'groceries',
  'transport',
  'accommodation',
  'tickets',
  'entertainment',
  'shopping',
  'utilities',
  'rent',
  'other',
]);

function text(value: unknown, max: number, field: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') invalid('invalid_field', `${field} must be text.`);
  const trimmed = (value as string).trim();
  if (trimmed.length > max) invalid('invalid_field', `${field} is longer than ${max} characters.`);
  return trimmed;
}

/** Where a group probably is, from its currency, until someone sets its time zone. */
const ZONE_BY_CURRENCY: Record<string, string> = {
  TWD: 'Asia/Taipei',
  JPY: 'Asia/Tokyo',
  KRW: 'Asia/Seoul',
  HKD: 'Asia/Hong_Kong',
  CNY: 'Asia/Shanghai',
  SGD: 'Asia/Singapore',
  MYR: 'Asia/Kuala_Lumpur',
  THB: 'Asia/Bangkok',
  VND: 'Asia/Ho_Chi_Minh',
  IDR: 'Asia/Jakarta',
  PHP: 'Asia/Manila',
  GBP: 'Europe/London',
  EUR: 'Europe/Paris',
  CHF: 'Europe/Zurich',
  AUD: 'Australia/Sydney',
  NZD: 'Pacific/Auckland',
};

export const zoneFor = (currency: string) => ZONE_BY_CURRENCY[currency.toUpperCase()] ?? 'UTC';

function timeZone(value: unknown): string {
  if (typeof value === 'string' && value.length <= 64) {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
    } catch {
      /* falls through */
    }
  }
  return invalid('invalid_field', 'timezone must be an IANA time zone like Asia/Taipei.');
}

/** Today's date (YYYY-MM-DD) in a time zone. en-CA formats dates as YYYY-MM-DD. */
export function today(zone: string, at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

function day(value: unknown, zone = 'UTC'): string {
  if (value === undefined || value === null || value === '') return today(zone);
  // Date.parse accepts 2026-02-30 (it rolls over to March), so check the date reads back the same.
  const real = (v: string) => !Number.isNaN(Date.parse(v)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !real(value)) {
    invalid('invalid_field', 'spentOn must be a date like 2026-11-06.');
  }
  return value as string;
}

function currencyCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value)) {
    invalid('invalid_field', 'currency must be a three-letter code like GBP.');
  }
  return (value as string).toUpperCase();
}

interface GroupRow {
  id: string;
  name: string;
  currency: string;
  minor_unit: number;
  bot_name: string;
  default_split: string | null;
  simplify: number;
  timezone: string | null;
}

const toGroup = (row: GroupRow): Group => ({
  id: row.id,
  name: row.name,
  currency: row.currency,
  minorUnit: row.minor_unit,
  botName: row.bot_name,
  defaultSplit: row.default_split ? (JSON.parse(row.default_split) as SplitSpec) : null,
  simplify: row.simplify === 1,
  timezone: row.timezone ?? zoneFor(row.currency),
});

interface ExpenseRow {
  id: string;
  seq: number;
  version: number;
  kind: 'expense' | 'refund' | 'void';
  status: string;
  description: string;
  category: string;
  amount: number;
  currency: string;
  spent_on: string;
  split: string;
  receipt_ref: string | null;
  replaces_id: string | null;
  created_by: string;
  confirmed_by: string | null;
  created_at: string;
}

interface SettlementRow {
  id: string;
  seq: number;
  status: string;
  from_member: string;
  to_member: string;
  amount: number;
  currency: string;
  created_by: string;
  confirmed_by: string | null;
  created_at: string;
}

/* ───────── groups and members ───────── */

export async function getGroup(env: Env, groupId: string): Promise<Group> {
  const row = await env.DB.prepare(
    `SELECT g.id, g.name, g.currency, g.minor_unit, g.bot_name, g.default_split, g.simplify, p.timezone
       FROM ledger_groups g LEFT JOIN ledger_group_prefs p ON p.group_id = g.id WHERE g.id = ?`,
  )
    .bind(groupId)
    .first<GroupRow>();
  return row ? toGroup(row) : notFound('group_not_found', 'This group has no ledger yet. Create it first.');
}

export interface GroupSettings {
  name?: string;
  currency?: string;
  botName?: string;
  defaultSplit?: SplitSpec | null;
  simplify?: boolean;
  timezone?: string;
}

/** Create the group's ledger, or change its settings. Currency is fixed once money is recorded. */
export async function upsertGroup(env: Env, groupId: string, settings: GroupSettings): Promise<Group> {
  const existing = await env.DB.prepare('SELECT id, currency FROM ledger_groups WHERE id = ?')
    .bind(groupId)
    .first<{ id: string; currency: string }>();
  const stamp = now();

  if (settings.defaultSplit) computeShares(10_000, settings.defaultSplit);
  const zone = settings.timezone === undefined ? undefined : timeZone(settings.timezone);
  const saveZone = async () => {
    if (zone === undefined) return;
    await env.DB.prepare(
      `INSERT INTO ledger_group_prefs (group_id, timezone, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (group_id) DO UPDATE SET timezone = excluded.timezone, updated_at = excluded.updated_at`,
    )
      .bind(groupId, zone, stamp)
      .run();
  };
  const defaultSplit =
    settings.defaultSplit === undefined ? undefined : settings.defaultSplit ? JSON.stringify(settings.defaultSplit) : null;

  if (!existing) {
    const currency = currencyCode(settings.currency ?? 'GBP');
    // Two first messages in a new room can both get here. ON CONFLICT keeps the second one
    // from failing: it finds the group the first one just made and returns it.
    await env.DB.prepare(
      `INSERT INTO ledger_groups (id, name, currency, minor_unit, bot_name, default_split, simplify, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    )
      .bind(
        groupId,
        text(settings.name, 120, 'name'),
        currency,
        minorUnitFor(currency),
        text(settings.botName, 40, 'botName') || 'Penny',
        defaultSplit ?? null,
        settings.simplify === false ? 0 : 1,
        stamp,
        stamp,
      )
      .run();
    await saveZone();
    return getGroup(env, groupId);
  }

  if (settings.currency !== undefined && currencyCode(settings.currency) !== existing.currency) {
    const used = await env.DB.prepare(
      `SELECT 1 FROM ledger_expenses WHERE group_id = ?1
       UNION ALL SELECT 1 FROM ledger_settlements WHERE group_id = ?1 LIMIT 1`,
    )
      .bind(groupId)
      .first();
    if (used) conflict('currency_locked', 'The currency cannot change once the group has expenses or repayments.');
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  if (settings.name !== undefined) {
    sets.push('name = ?');
    values.push(text(settings.name, 120, 'name'));
  }
  if (settings.currency !== undefined) {
    const currency = currencyCode(settings.currency);
    sets.push('currency = ?', 'minor_unit = ?');
    values.push(currency, minorUnitFor(currency));
  }
  if (settings.botName !== undefined) {
    sets.push('bot_name = ?');
    values.push(text(settings.botName, 40, 'botName') || 'Penny');
  }
  if (defaultSplit !== undefined) {
    sets.push('default_split = ?');
    values.push(defaultSplit);
  }
  if (settings.simplify !== undefined) {
    sets.push('simplify = ?');
    values.push(settings.simplify ? 1 : 0);
  }
  if (sets.length > 0) {
    sets.push('updated_at = ?');
    values.push(stamp, groupId);
    await env.DB.prepare(`UPDATE ledger_groups SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
  }
  await saveZone();
  return getGroup(env, groupId);
}

interface MemberRow {
  member_id: string;
  display_name: string;
  is_guest: number;
  sponsor_id: string | null;
  active: number;
}

const membersQuery = (env: Env, groupId: string) =>
  env.DB.prepare(
    `SELECT member_id, display_name, is_guest, sponsor_id, active FROM ledger_members
     WHERE group_id = ? ORDER BY created_at, member_id`,
  ).bind(groupId);

const toMember = (r: MemberRow): Member => ({
  id: r.member_id,
  name: r.display_name,
  isGuest: r.is_guest === 1,
  sponsorId: r.sponsor_id,
  active: r.active === 1,
});

export async function listMembers(env: Env, groupId: string): Promise<Member[]> {
  const { results } = await membersQuery(env, groupId).all<MemberRow>();
  return results.map(toMember);
}

/**
 * Bring the member list in line with the chat's: add or rename everyone given. With
 * `complete`, members (not guests) missing from the list are marked inactive; their past
 * entries stay.
 */
export async function syncMembers(
  env: Env,
  groupId: string,
  members: { id: string; name: string }[],
  complete: boolean,
): Promise<Member[]> {
  await getGroup(env, groupId);
  if (!Array.isArray(members) || members.length === 0) invalid('invalid_field', 'members must list at least one member.');
  if (members.length > 60) invalid('invalid_field', 'A group can have at most 60 members.');
  const stamp = now();
  const statements = members.map((m) => {
    if (!m || typeof m.id !== 'string' || m.id.length === 0 || m.id.length > 200 || m.id.startsWith('guest:')) {
      invalid('invalid_field', 'Every member needs an id (not starting with guest:).');
    }
    return env.DB.prepare(
      `INSERT INTO ledger_members (group_id, member_id, display_name, is_guest, active, created_at)
       VALUES (?, ?, ?, 0, 1, ?)
       ON CONFLICT (group_id, member_id) DO UPDATE SET display_name = excluded.display_name, active = 1`,
    ).bind(groupId, m.id, text(m.name, 80, 'name') || m.id, stamp);
  });
  if (complete) {
    const ids = members.map((m) => m.id);
    statements.push(
      env.DB.prepare(
        `UPDATE ledger_members SET active = 0
         WHERE group_id = ? AND is_guest = 0 AND member_id NOT IN (SELECT value FROM json_each(?))`,
      ).bind(groupId, JSON.stringify(ids)),
    );
  }
  await env.DB.batch(statements);
  return listMembers(env, groupId);
}

/** Someone outside the chat. Their shares are settled by the sponsor. */
export async function addGuest(env: Env, groupId: string, name: string, sponsorId: string): Promise<Member> {
  const members = await memberMap(env, groupId);
  const sponsor = members.get(sponsorId);
  if (!sponsor || sponsor.isGuest || !sponsor.active) invalid('invalid_member', 'The sponsor must be an active member of the group.');
  const guestName = text(name, 80, 'name');
  if (!guestName) invalid('invalid_field', 'A guest needs a name.');
  const count = [...members.values()].filter((m) => m.isGuest).length;
  if (count >= 30) invalid('invalid_field', 'A group can have at most 30 guests.');
  // The number is picked inside the INSERT, so two guests added at once never get the same id.
  const row = await env.DB.prepare(
    `INSERT INTO ledger_members (group_id, member_id, display_name, is_guest, sponsor_id, active, created_at)
     SELECT ?, 'guest:' || (COUNT(*) + 1), ?, 1, ?, 1, ?
       FROM ledger_members WHERE group_id = ? AND is_guest = 1
     RETURNING member_id`,
  )
    .bind(groupId, guestName, sponsorId, now(), groupId)
    .first<{ member_id: string }>();
  return { id: row!.member_id, name: guestName, isGuest: true, sponsorId, active: true };
}

async function memberMap(env: Env, groupId: string): Promise<Map<string, Member>> {
  return new Map((await listMembers(env, groupId)).map((m) => [m.id, m]));
}

function requireActor(members: Map<string, Member>, id: unknown, role: string): string {
  const member = typeof id === 'string' ? members.get(id) : undefined;
  if (!member || member.isGuest || !member.active) {
    invalid('invalid_member', `${role} must be an active member of the group.`);
  }
  return id as string;
}

/* ───────── entry numbers ───────── */

async function nextSeq(env: Env, groupId: string): Promise<number> {
  const row = await env.DB.prepare(
    'UPDATE ledger_groups SET next_seq = next_seq + 1, updated_at = ? WHERE id = ? RETURNING next_seq - 1 AS seq',
  )
    .bind(now(), groupId)
    .first<{ seq: number }>();
  return row ? row.seq : notFound('group_not_found', 'This group has no ledger yet. Create it first.');
}

/* ───────── reading entries ───────── */

async function linesFor(env: Env, ids: string[]): Promise<Map<string, { payers: Line[]; shares: Line[] }>> {
  const out = new Map(ids.map((id) => [id, { payers: [] as Line[], shares: [] as Line[] }]));
  if (ids.length === 0) return out;
  const list = JSON.stringify(ids);
  const [payers, shares] = await env.DB.batch<{ expense_id: string; member_id: string; amount: number }>([
    env.DB.prepare(
      'SELECT expense_id, member_id, amount FROM ledger_payers WHERE expense_id IN (SELECT value FROM json_each(?)) ORDER BY member_id',
    ).bind(list),
    env.DB.prepare(
      'SELECT expense_id, member_id, amount FROM ledger_shares WHERE expense_id IN (SELECT value FROM json_each(?)) ORDER BY member_id',
    ).bind(list),
  ]);
  for (const r of payers.results) out.get(r.expense_id)?.payers.push({ member: r.member_id, amount: r.amount });
  for (const r of shares.results) out.get(r.expense_id)?.shares.push({ member: r.member_id, amount: r.amount });
  return out;
}

const EXPENSE_COLUMNS = `id, seq, version, kind, status, description, category, amount, currency, spent_on, split,
  receipt_ref, replaces_id, created_by, confirmed_by, created_at`;

function expenseEntry(row: ExpenseRow, lines: { payers: Line[]; shares: Line[] }): Entry {
  return {
    seq: row.seq,
    version: row.version,
    type: row.kind,
    status: row.status,
    description: row.description,
    category: row.category,
    amount: row.amount,
    currency: row.currency,
    spentOn: row.spent_on,
    payers: lines.payers,
    shares: lines.shares,
    receiptRef: row.receipt_ref,
    split: row.split ? (JSON.parse(row.split) as SplitSpec | null) : null,
    createdBy: row.created_by,
    confirmedBy: row.confirmed_by,
    createdAt: row.created_at,
  };
}

function settlementEntry(row: SettlementRow): Entry {
  return {
    seq: row.seq,
    version: 1,
    type: 'settlement',
    status: row.status,
    description: '',
    category: 'settlement',
    amount: row.amount,
    currency: row.currency,
    spentOn: row.created_at.slice(0, 10),
    payers: [{ member: row.from_member, amount: row.amount }],
    shares: [{ member: row.to_member, amount: row.amount }],
    receiptRef: null,
    split: null,
    createdBy: row.created_by,
    confirmedBy: row.confirmed_by,
    createdAt: row.created_at,
  };
}

async function expenseRows(env: Env, where: string, ...values: unknown[]): Promise<Entry[]> {
  const { results } = await env.DB.prepare(`SELECT ${EXPENSE_COLUMNS} FROM ledger_expenses WHERE ${where}`)
    .bind(...values)
    .all<ExpenseRow>();
  const lines = await linesFor(env, results.map((r) => r.id));
  return results.map((r) => expenseEntry(r, lines.get(r.id)!));
}

/** Active expenses and refunds, newest first, `limit` at a time. */
export async function listExpenses(
  env: Env,
  groupId: string,
  options: { limit?: number; before?: number },
): Promise<{ entries: Entry[]; total: number; more: boolean }> {
  await getGroup(env, groupId);
  // ?limit=abc arrives as NaN, which SQLite refuses to bind: fall back to the defaults.
  const finite = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
  const limit = Math.min(Math.max(Math.trunc(finite(options.limit) ? options.limit : 5), 1), 20);
  const before = finite(options.before) && options.before > 0 ? Math.trunc(options.before) : Number.MAX_SAFE_INTEGER;
  const entries = await expenseRows(
    env,
    `group_id = ? AND status = 'active' AND seq < ? ORDER BY seq DESC LIMIT ?`,
    groupId,
    before,
    limit + 1,
  );
  const more = entries.length > limit;
  const page = entries.slice(0, limit);
  const total = page.reduce((acc, e) => acc + (e.type === 'refund' ? -e.amount : e.amount), 0);
  return { entries: page, total, more };
}

/** Every version of one numbered entry, oldest first. */
export async function getEntry(env: Env, groupId: string, seq: number): Promise<Entry[]> {
  const expenses = await expenseRows(env, 'group_id = ? AND seq = ? ORDER BY version', groupId, seq);
  if (expenses.length > 0) return expenses;
  const settlement = await env.DB.prepare('SELECT * FROM ledger_settlements WHERE group_id = ? AND seq = ?')
    .bind(groupId, seq)
    .first<SettlementRow>();
  return settlement ? [settlementEntry(settlement)] : notFound('entry_not_found', `There is no #${seq} in this group.`);
}

/** Everything waiting for an OK, oldest first. Edits and deletions carry the version they replace. */
export async function listPending(env: Env, groupId: string): Promise<Entry[]> {
  await getGroup(env, groupId);
  const expenses = await expenseRows(env, `group_id = ? AND status = 'pending' ORDER BY created_at`, groupId);
  const changed = expenses.filter((e) => e.version > 1).map((e) => e.seq);
  if (changed.length > 0) {
    const previous = await expenseRows(
      env,
      `group_id = ? AND status = 'active' AND seq IN (SELECT value FROM json_each(?))`,
      groupId,
      JSON.stringify(changed),
    );
    const bySeq = new Map(previous.map((e) => [e.seq, e]));
    for (const entry of expenses) if (bySeq.has(entry.seq)) entry.previous = bySeq.get(entry.seq);
  }
  const { results } = await env.DB.prepare(
    `SELECT * FROM ledger_settlements WHERE group_id = ? AND status = 'pending' ORDER BY created_at`,
  )
    .bind(groupId)
    .all<SettlementRow>();
  return [...expenses, ...results.map(settlementEntry)].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/* ───────── proposing changes ───────── */

interface Resolved {
  description: string;
  category: string;
  amount: number;
  kind: 'expense' | 'refund';
  spentOn: string;
  payers: Payer[];
  split: SplitSpec;
  shares: Record<string, number>;
  receiptRef: string | null;
}

/**
 * The group's default split, minus anyone who has left. Equal and shares splits just drop
 * them. Percent, exact and receipt splits cannot be rescaled safely, so once someone in them
 * has left they give way to an equal split among everyone still here.
 */
function defaultSplitFor(group: Group, members: Map<string, Member>, everyone: string[]): SplitSpec {
  const spec = group.defaultSplit;
  const here = (id: string) => members.get(id)?.active === true;
  if (!spec) return { method: 'equal', members: everyone };
  if (spec.method === 'equal') {
    const kept = (spec.members ?? []).filter(here);
    if (kept.length === 0) return { method: 'equal', members: everyone };
    const adjustments = Object.fromEntries(Object.entries(spec.adjustments ?? {}).filter(([m]) => here(m)));
    return { method: 'equal', members: kept, ...(Object.keys(adjustments).length > 0 ? { adjustments } : {}) };
  }
  if (spec.method === 'shares') {
    const kept = Object.entries(spec.shares ?? {}).filter(([m, w]) => here(m) && w > 0);
    return kept.length > 0 ? { method: 'shares', shares: Object.fromEntries(kept) } : { method: 'equal', members: everyone };
  }
  const named =
    spec.method === 'percent' ? Object.keys(spec.percents ?? {}) : spec.method === 'exact' ? Object.keys(spec.amounts ?? {}) : spec.everyone ?? [];
  return named.every(here) ? spec : { method: 'equal', members: everyone };
}

/**
 * `keep` lists people who have left but may still appear: on an edit, everyone already on
 * the entry being changed, so fixing an old typo never fails because someone left the chat.
 */
function resolveExpense(group: Group, members: Map<string, Member>, input: ExpenseInput, keep: Set<string> = new Set()): Resolved {
  const amount = assertAmount(input.amount, 'amount');
  const kind = input.kind ?? 'expense';
  if (kind !== 'expense' && kind !== 'refund') invalid('invalid_field', 'kind must be expense or refund.');
  const category = input.category ?? 'other';
  if (!CATEGORIES.has(category)) invalid('invalid_field', `category must be one of ${[...CATEGORIES].join(', ')}.`);

  let payers: Payer[];
  if (input.payers) {
    payers = checkPayers(amount, input.payers);
  } else if (typeof input.paidBy === 'string') {
    payers = [{ member: input.paidBy, amount }];
  } else {
    return invalid('invalid_field', 'Say who paid: paidBy or payers.');
  }
  for (const payer of payers) {
    if (!keep.has(payer.member)) requireActor(members, payer.member, 'Every payer');
    else if (!members.has(payer.member)) invalid('invalid_member', 'Every payer must be a member of the group.');
  }

  const everyone = [...members.values()].filter((m) => m.active && !m.isGuest).map((m) => m.id);
  const split = input.split ?? defaultSplitFor(group, members, everyone);
  const shares = computeShares(amount, split);
  for (const member of Object.keys(shares)) {
    const found = members.get(member);
    if (!found || (!found.active && !keep.has(member))) invalid('invalid_member', `${member} is not an active member of this group.`);
  }

  return {
    description: text(input.description, 200, 'description'),
    category,
    amount,
    kind,
    spentOn: day(input.spentOn, group.timezone),
    payers,
    split,
    shares,
    receiptRef: input.receiptRef ? text(input.receiptRef, 300, 'receiptRef') : null,
  };
}

function insertExpense(
  env: Env,
  group: Group,
  row: { id: string; seq: number; version: number; kind: string; createdBy: string; replacesId: string | null },
  data: Resolved | null,
): D1PreparedStatement[] {
  const statements = [
    env.DB.prepare(
      `INSERT INTO ledger_expenses (id, group_id, seq, version, kind, status, description, category, amount, currency,
         spent_on, split, receipt_ref, replaces_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.id,
      group.id,
      row.seq,
      row.version,
      row.kind,
      data?.description ?? '',
      data?.category ?? 'other',
      data?.amount ?? 0,
      group.currency,
      data?.spentOn ?? today(group.timezone),
      JSON.stringify(data?.split ?? null),
      data?.receiptRef ?? null,
      row.replacesId,
      row.createdBy,
      now(),
    ),
  ];
  if (data) {
    for (const payer of data.payers) {
      statements.push(
        env.DB.prepare('INSERT INTO ledger_payers (expense_id, member_id, amount) VALUES (?, ?, ?)').bind(
          row.id,
          payer.member,
          payer.amount,
        ),
      );
    }
    for (const [member, amount] of Object.entries(data.shares)) {
      statements.push(
        env.DB.prepare('INSERT INTO ledger_shares (expense_id, member_id, amount) VALUES (?, ?, ?)').bind(
          row.id,
          member,
          amount,
        ),
      );
    }
  }
  return statements;
}

async function onlyPending(env: Env, groupId: string, seq: number): Promise<Entry> {
  const [pending] = (await getEntry(env, groupId, seq)).filter((e) => e.status === 'pending');
  return pending;
}

/** Propose a new expense or refund. It counts only after someone confirms it. */
export async function proposeExpense(env: Env, groupId: string, createdBy: string, input: ExpenseInput): Promise<Entry> {
  const group = await getGroup(env, groupId);
  const members = await memberMap(env, groupId);
  requireActor(members, createdBy, 'createdBy');
  const data = resolveExpense(group, members, input);
  const seq = await nextSeq(env, groupId);
  const id = crypto.randomUUID();
  await env.DB.batch(insertExpense(env, group, { id, seq, version: 1, kind: data.kind, createdBy, replacesId: null }, data));
  return onlyPending(env, groupId, seq);
}

async function activeVersion(env: Env, groupId: string, seq: number): Promise<{ id: string; version: number; entry: Entry }> {
  const versions = await getEntry(env, groupId, seq);
  if (versions[0].type === 'settlement') conflict('not_an_expense', `#${seq} is a repayment, not an expense.`);
  if (versions.some((v) => v.status === 'pending')) conflict('change_pending', `#${seq} already has a change waiting for an OK.`);
  const active = versions.find((v) => v.status === 'active');
  if (!active) conflict('not_active', `#${seq} is not an active expense.`);
  const row = await env.DB.prepare(
    `SELECT id FROM ledger_expenses WHERE group_id = ? AND seq = ? AND status = 'active'`,
  )
    .bind(groupId, seq)
    .first<{ id: string }>();
  return { id: row!.id, version: Math.max(...versions.map((v) => v.version)), entry: active! };
}

/** Propose a change to #seq. Fields left out keep their current values. */
export async function proposeEdit(
  env: Env,
  groupId: string,
  seq: number,
  createdBy: string,
  changes: ExpenseInput,
): Promise<Entry> {
  const group = await getGroup(env, groupId);
  const members = await memberMap(env, groupId);
  requireActor(members, createdBy, 'createdBy');
  const current = await activeVersion(env, groupId, seq);
  const before = current.entry;
  const amountChanged = changes.amount !== undefined && changes.amount !== before.amount;

  const merged: ExpenseInput = {
    description: changes.description ?? before.description,
    category: changes.category ?? before.category,
    amount: changes.amount ?? before.amount,
    kind: changes.kind ?? (before.type as 'expense' | 'refund'),
    spentOn: changes.spentOn ?? before.spentOn,
    // A new amount with the old payer list would not add up, so a single old payer pays the new amount.
    payers:
      changes.payers ??
      (changes.paidBy !== undefined || (amountChanged && before.payers.length === 1) ? undefined : before.payers),
    paidBy: changes.paidBy ?? (amountChanged && before.payers.length === 1 ? before.payers[0].member : undefined),
    split: changes.split ?? before.split ?? undefined,
    receiptRef: changes.receiptRef === undefined ? before.receiptRef : changes.receiptRef,
  };
  const already = new Set([...before.payers, ...before.shares].map((l) => l.member));
  const data = resolveExpense(group, members, merged, already);
  const id = crypto.randomUUID();
  await env.DB.batch(
    insertExpense(env, group, { id, seq, version: current.version + 1, kind: data.kind, createdBy, replacesId: current.id }, data),
  );
  const pending = await onlyPending(env, groupId, seq);
  return { ...pending, previous: before };
}

/** Propose deleting #seq. The old version stays on record. */
export async function proposeDelete(env: Env, groupId: string, seq: number, createdBy: string): Promise<Entry> {
  const group = await getGroup(env, groupId);
  const members = await memberMap(env, groupId);
  requireActor(members, createdBy, 'createdBy');
  const current = await activeVersion(env, groupId, seq);
  await env.DB.batch(
    insertExpense(
      env,
      group,
      { id: crypto.randomUUID(), seq, version: current.version + 1, kind: 'void', createdBy, replacesId: current.id },
      null,
    ),
  );
  const pending = await onlyPending(env, groupId, seq);
  return { ...pending, previous: current.entry };
}

/** Propose a repayment. Only the person receiving the money can confirm it. */
export async function proposeSettlement(
  env: Env,
  groupId: string,
  createdBy: string,
  input: { from?: string; to?: string; amount?: number },
): Promise<Entry> {
  const group = await getGroup(env, groupId);
  const members = await memberMap(env, groupId);
  requireActor(members, createdBy, 'createdBy');
  const from = requireActor(members, input.from, 'from');
  const to = requireActor(members, input.to, 'to');
  if (from === to) invalid('invalid_field', 'from and to must be different people.');
  const amount = assertAmount(input.amount, 'amount');
  const seq = await nextSeq(env, groupId);
  await env.DB.prepare(
    `INSERT INTO ledger_settlements (id, group_id, seq, status, from_member, to_member, amount, currency, created_by, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), groupId, seq, from, to, amount, group.currency, createdBy, now())
    .run();
  return (await getEntry(env, groupId, seq))[0];
}

/* ───────── confirming ───────── */

/**
 * Who may OK a change to an expense: never the person who proposed it, so nobody can record a
 * debt on someone else alone. If anyone else still in the group is on the entry (paid, shares
 * it, or sponsors a guest who shares it, in the new version or the one it replaces), it must be
 * one of them. Otherwise anyone else in the group may. A group of one confirms its own entries.
 */
async function checkConfirmer(
  env: Env,
  members: Map<string, Member>,
  pending: { id: string; replaces_id: string | null; created_by: string },
  by: string,
  seq: number,
): Promise<void> {
  const people = [...members.values()].filter((m) => m.active && !m.isGuest);
  if (people.length <= 1) return;
  const name = (id: string) => members.get(id)?.name ?? id;
  if (by === pending.created_by) {
    throw new HttpError(403, 'someone_else_must_confirm', `${name(by)} proposed #${seq}, so someone else has to OK it.`);
  }
  const ids = JSON.stringify([pending.id, pending.replaces_id].filter(Boolean));
  const { results } = await env.DB.prepare(
    `SELECT member_id FROM ledger_payers WHERE expense_id IN (SELECT value FROM json_each(?1))
     UNION SELECT member_id FROM ledger_shares WHERE expense_id IN (SELECT value FROM json_each(?1))`,
  )
    .bind(ids)
    .all<{ member_id: string }>();
  const involved = new Set<string>();
  for (const { member_id } of results) {
    const member = members.get(member_id);
    const owner = member?.isGuest ? member.sponsorId : member_id;
    if (owner && owner !== pending.created_by && members.get(owner)?.active) involved.add(owner);
  }
  if (involved.size > 0 && !involved.has(by)) {
    throw new HttpError(
      403,
      'involved_must_confirm',
      `Only someone on #${seq} can OK it: ${[...involved].map(name).join(', ')}.`,
    );
  }
}

/** Confirm the pending change on #seq. Returns the entry as it now stands. */
export async function confirm(env: Env, groupId: string, seq: number, by: string): Promise<Entry> {
  const members = await memberMap(env, groupId);
  requireActor(members, by, 'The person confirming');
  const stamp = now();

  const settlement = await env.DB.prepare(
    `SELECT * FROM ledger_settlements WHERE group_id = ? AND seq = ? AND status = 'pending'`,
  )
    .bind(groupId, seq)
    .first<SettlementRow>();
  if (settlement) {
    if (settlement.to_member !== by) {
      throw new HttpError(403, 'receiver_must_confirm', `Only ${members.get(settlement.to_member)?.name ?? 'the receiver'} can confirm this repayment.`);
    }
    const result = await env.DB.prepare(
      `UPDATE ledger_settlements SET status = 'active', confirmed_by = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`,
    )
      .bind(by, stamp, settlement.id)
      .run();
    if (result.meta.changes !== 1) conflict('already_resolved', `#${seq} was already resolved.`);
    return (await getEntry(env, groupId, seq))[0];
  }

  const pending = await env.DB.prepare(
    `SELECT id, kind, replaces_id, created_by FROM ledger_expenses WHERE group_id = ? AND seq = ? AND status = 'pending'`,
  )
    .bind(groupId, seq)
    .first<{ id: string; kind: string; replaces_id: string | null; created_by: string }>();
  if (!pending) notFound('nothing_pending', `#${seq} has nothing waiting for an OK.`);
  await checkConfirmer(env, members, pending!, by, seq);

  const statements = [
    env.DB.prepare(
      `UPDATE ledger_expenses SET status = ?, confirmed_by = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`,
    ).bind(pending!.kind === 'void' ? 'voided' : 'active', by, stamp, pending!.id),
  ];
  if (pending!.replaces_id) {
    statements.push(
      env.DB.prepare(
        `UPDATE ledger_expenses SET status = 'superseded', resolved_at = ? WHERE id = ? AND status = 'active'`,
      ).bind(stamp, pending!.replaces_id),
    );
  }
  const results = await env.DB.batch(statements);
  if (results[0].meta.changes !== 1) conflict('already_resolved', `#${seq} was already resolved.`);
  const versions = await getEntry(env, groupId, seq);
  return versions.find((v) => v.status === 'active') ?? versions[versions.length - 1];
}

/** Drop the pending change on #seq. Anyone in the group can, the proposer included. */
export async function cancel(env: Env, groupId: string, seq: number, by: string): Promise<void> {
  const members = await memberMap(env, groupId);
  requireActor(members, by, 'The person cancelling');
  const stamp = now();
  const [expense, settlement] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE ledger_expenses SET status = 'cancelled', confirmed_by = ?, resolved_at = ?
       WHERE group_id = ? AND seq = ? AND status = 'pending'`,
    ).bind(by, stamp, groupId, seq),
    env.DB.prepare(
      `UPDATE ledger_settlements SET status = 'cancelled', confirmed_by = ?, resolved_at = ?
       WHERE group_id = ? AND seq = ? AND status = 'pending'`,
    ).bind(by, stamp, groupId, seq),
  ]);
  if (expense.meta.changes + settlement.meta.changes === 0) notFound('nothing_pending', `#${seq} has nothing waiting for an OK.`);
}

/* ───────── balances and summaries ───────── */

/** Net position per member from confirmed entries: positive means others owe them. */
const rawNetsQuery = (env: Env, groupId: string) =>
  env.DB.prepare(
    `SELECT member_id, SUM(amount) AS net FROM (
       SELECT p.member_id AS member_id, CASE e.kind WHEN 'refund' THEN -p.amount ELSE p.amount END AS amount
         FROM ledger_payers p JOIN ledger_expenses e ON e.id = p.expense_id
        WHERE e.group_id = ?1 AND e.status = 'active'
       UNION ALL
       SELECT s.member_id, CASE e.kind WHEN 'refund' THEN s.amount ELSE -s.amount END
         FROM ledger_shares s JOIN ledger_expenses e ON e.id = s.expense_id
        WHERE e.group_id = ?1 AND e.status = 'active'
       UNION ALL
       SELECT from_member, amount FROM ledger_settlements WHERE group_id = ?1 AND status = 'active'
       UNION ALL
       SELECT to_member, -amount FROM ledger_settlements WHERE group_id = ?1 AND status = 'active'
     ) GROUP BY member_id`,
  ).bind(groupId);

/** Net positions with guests folded into their sponsor, and the settle-up plan. Pure. */
function settle(groupId: string, members: Map<string, Member>, raw: { member_id: string; net: number }[]) {
  const nets: Record<string, number> = {};
  for (const { member_id: member, net: amount } of raw) {
    const owner = members.get(member)?.isGuest ? (members.get(member)?.sponsorId ?? member) : member;
    nets[owner] = (nets[owner] ?? 0) + amount;
  }
  const total = Object.values(nets).reduce((acc, v) => acc + v, 0);
  if (total !== 0) throw new Error(`ledger invariant broken for ${groupId}: nets add up to ${total}`);
  return {
    nets: Object.entries(nets)
      .filter(([, v]) => v !== 0)
      .map(([member, amount]) => ({ member, amount }))
      .sort((a, b) => b.amount - a.amount || a.member.localeCompare(b.member)),
    transfers: simplifyDebts(nets),
  };
}

/** A group's members and its raw nets in one round trip. */
async function membersAndNets(env: Env, groupId: string) {
  const [members, raw] = await env.DB.batch<Record<string, unknown>>([membersQuery(env, groupId), rawNetsQuery(env, groupId)]);
  return {
    members: new Map((members.results as unknown as MemberRow[]).map((r) => [r.member_id, toMember(r)])),
    raw: raw.results as unknown as { member_id: string; net: number }[],
  };
}

export interface Balances {
  currency: string;
  minorUnit: number;
  /** Every member with a non-zero position. Guests are folded into their sponsor. */
  nets: Line[];
  /** The fewest repayments that settle everyone. */
  transfers: Transfer[];
}

export async function balances(env: Env, groupId: string): Promise<Balances> {
  const group = await getGroup(env, groupId);
  const { members, raw } = await membersAndNets(env, groupId);
  return { currency: group.currency, minorUnit: group.minorUnit, ...settle(groupId, members, raw) };
}

/** What one person put in versus what was theirs to pay. Guests they sponsor count as theirs. */
export async function memberSummary(env: Env, groupId: string, memberId: string) {
  const group = await getGroup(env, groupId);
  const members = await memberMap(env, groupId);
  if (!members.has(memberId)) notFound('member_not_found', 'That person is not in this group.');
  const ids = [memberId, ...[...members.values()].filter((m) => m.sponsorId === memberId).map((m) => m.id)];
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COALESCE(SUM(CASE e.kind WHEN 'refund' THEN -p.amount ELSE p.amount END), 0)
          FROM ledger_payers p JOIN ledger_expenses e ON e.id = p.expense_id
         WHERE e.group_id = ?1 AND e.status = 'active' AND p.member_id IN (SELECT value FROM json_each(?2))) AS paid,
       (SELECT COALESCE(SUM(CASE e.kind WHEN 'refund' THEN -s.amount ELSE s.amount END), 0)
          FROM ledger_shares s JOIN ledger_expenses e ON e.id = s.expense_id
         WHERE e.group_id = ?1 AND e.status = 'active' AND s.member_id IN (SELECT value FROM json_each(?2))) AS share,
       (SELECT COALESCE(SUM(amount), 0) FROM ledger_settlements
         WHERE group_id = ?1 AND status = 'active' AND from_member = ?3) AS repaid,
       (SELECT COALESCE(SUM(amount), 0) FROM ledger_settlements
         WHERE group_id = ?1 AND status = 'active' AND to_member = ?3) AS received`,
  )
    .bind(groupId, JSON.stringify(ids), memberId)
    .first<{ paid: number; share: number; repaid: number; received: number }>();
  const r = row!;
  return {
    currency: group.currency,
    minorUnit: group.minorUnit,
    member: memberId,
    paid: r.paid,
    share: r.share,
    repaid: r.repaid,
    received: r.received,
    net: r.paid - r.share + r.repaid - r.received,
  };
}

/** Totals for the trip or month: by category and by day. Refunds count against spending. */
export async function stats(env: Env, groupId: string, range: { from?: string; to?: string }) {
  const group = await getGroup(env, groupId);
  const from = range.from ? day(range.from) : '0000-01-01';
  const to = range.to ? day(range.to) : '9999-12-31';
  const signed = `CASE kind WHEN 'refund' THEN -amount ELSE amount END`;
  const where = `group_id = ? AND status = 'active' AND spent_on BETWEEN ? AND ?`;
  const [totals, categories, days, payers, largest] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      `SELECT COALESCE(SUM(${signed}), 0) AS total, COUNT(*) AS count, MIN(spent_on) AS first_day, MAX(spent_on) AS last_day
         FROM ledger_expenses WHERE ${where}`,
    ).bind(groupId, from, to),
    env.DB.prepare(
      `SELECT category, SUM(${signed}) AS amount, COUNT(*) AS count FROM ledger_expenses WHERE ${where}
       GROUP BY category ORDER BY amount DESC`,
    ).bind(groupId, from, to),
    env.DB.prepare(
      `SELECT spent_on AS day, SUM(${signed}) AS amount FROM ledger_expenses WHERE ${where} GROUP BY spent_on ORDER BY spent_on`,
    ).bind(groupId, from, to),
    env.DB.prepare(
      `SELECT p.member_id AS member, COUNT(*) AS count, SUM(p.amount) AS amount
         FROM ledger_payers p JOIN ledger_expenses e ON e.id = p.expense_id
        WHERE e.group_id = ? AND e.status = 'active' AND e.kind = 'expense' AND e.spent_on BETWEEN ? AND ?
        GROUP BY p.member_id ORDER BY count DESC, amount DESC, p.member_id`,
    ).bind(groupId, from, to),
    env.DB.prepare(
      `SELECT seq, description, category, amount, spent_on AS spentOn FROM ledger_expenses
        WHERE ${where} AND kind = 'expense' ORDER BY amount DESC, seq LIMIT 1`,
    ).bind(groupId, from, to),
  ]);
  const head = totals.results[0] as { total: number; count: number; first_day: string | null; last_day: string | null };
  const memberCount = (await listMembers(env, groupId)).filter((m) => m.active && !m.isGuest).length;
  return {
    currency: group.currency,
    minorUnit: group.minorUnit,
    total: head.total,
    count: head.count,
    members: memberCount,
    firstDay: head.first_day,
    lastDay: head.last_day,
    byCategory: categories.results as { category: string; amount: number; count: number }[],
    byDay: days.results as { day: string; amount: number }[],
    /** Who paid most often (expenses only, not refunds). */
    payers: payers.results as { member: string; count: number; amount: number }[],
    largest: (largest.results[0] ?? null) as { seq: number; description: string; category: string; amount: number; spentOn: string } | null,
  };
}

/* ───────── learned habits ───────── */

const MEMORY_LIMIT = 20;

export async function listMemory(env: Env, groupId: string): Promise<{ key: string; value: string }[]> {
  await getGroup(env, groupId);
  const { results } = await env.DB.prepare('SELECT key, value FROM ledger_memory WHERE group_id = ? ORDER BY key')
    .bind(groupId)
    .all<{ key: string; value: string }>();
  return results;
}

export async function putMemory(env: Env, groupId: string, key: string, value: unknown): Promise<void> {
  await getGroup(env, groupId);
  const k = text(key, 64, 'key');
  const v = text(value, 500, 'value');
  if (!k || !v) invalid('invalid_field', 'A memory needs a key and a value.');
  const exists = await env.DB.prepare('SELECT 1 FROM ledger_memory WHERE group_id = ? AND key = ?').bind(groupId, k).first();
  if (!exists) {
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM ledger_memory WHERE group_id = ?')
      .bind(groupId)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= MEMORY_LIMIT) conflict('memory_full', `This group already has ${MEMORY_LIMIT} memories. Forget one first.`);
  }
  await env.DB.prepare(
    `INSERT INTO ledger_memory (group_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (group_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(groupId, k, v, now())
    .run();
}

export async function deleteMemory(env: Env, groupId: string, key: string): Promise<void> {
  const k = typeof key === 'string' ? key.trim() : '';
  const result = await env.DB.prepare('DELETE FROM ledger_memory WHERE group_id = ? AND key = ?').bind(groupId, k).run();
  if (result.meta.changes === 0) notFound('memory_not_found', 'There is no memory with that key.');
}

/* ───────── payment details ───────── */

export async function setPaymentInfo(env: Env, memberId: string, info: unknown): Promise<void> {
  const value = text(info, 300, 'info');
  if (!value) invalid('invalid_field', 'info must not be empty.');
  const sealed = await seal(env, value);
  await env.DB.prepare(
    `INSERT INTO ledger_payment_info (member_id, info_ct, info_iv, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (member_id) DO UPDATE SET info_ct = excluded.info_ct, info_iv = excluded.info_iv, updated_at = excluded.updated_at`,
  )
    .bind(memberId, sealed.ciphertext, sealed.iv, now())
    .run();
}

export async function getPaymentInfo(env: Env, memberId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT info_ct, info_iv FROM ledger_payment_info WHERE member_id = ?')
    .bind(memberId)
    .first<{ info_ct: string; info_iv: string }>();
  return row ? unseal(env, row.info_ct, row.info_iv) : null;
}

export async function deletePaymentInfo(env: Env, memberId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM ledger_payment_info WHERE member_id = ?').bind(memberId).run();
}

/* ───────── across groups ───────── */

export const OVERVIEW_LIMIT = 50;

/**
 * One person's position in every group they belong to. With `other`, also what the two of
 * them owe each other, taken from each group's settle-up plan. Meant for private messages:
 * the caller must only show it to `memberId` themself.
 */
export async function overview(env: Env, memberId: string, other?: string) {
  // Each group costs a few queries, and a Worker invocation has a query budget, so at most
  // OVERVIEW_LIMIT groups are read: the most recently active ones. `more` counts the rest.
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.name, g.currency, g.minor_unit FROM ledger_members m JOIN ledger_groups g ON g.id = m.group_id
      WHERE m.member_id = ? AND m.is_guest = 0 ORDER BY g.updated_at DESC, g.id`,
  )
    .bind(memberId)
    .all<{ id: string; name: string; currency: string; minor_unit: number }>();
  const more = Math.max(results.length - OVERVIEW_LIMIT, 0);
  results.length = Math.min(results.length, OVERVIEW_LIMIT);
  results.sort((a, b) => a.name.localeCompare(b.name));
  const groups = [];
  for (const g of results) {
    const { members, raw } = await membersAndNets(env, g.id);
    if (other && !members.has(other)) continue;
    const b = settle(g.id, members, raw);
    const net = b.nets.find((n) => n.member === memberId)?.amount ?? 0;
    let withOther: number | undefined;
    if (other) {
      withOther = b.transfers.reduce(
        (acc, t) => acc + (t.from === other && t.to === memberId ? t.amount : t.from === memberId && t.to === other ? -t.amount : 0),
        0,
      );
    }
    groups.push({ id: g.id, name: g.name, currency: g.currency, minorUnit: g.minor_unit, net, withOther });
  }
  return { member: memberId, other: other ?? null, groups, more };
}
