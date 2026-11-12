/**
 * Money arithmetic for the ledger. Pure functions, no I/O.
 *
 * Every amount is an integer count of the currency's minor unit (pence, cents, yen).
 * Nothing here uses floating point to divide money: splits are computed with integer
 * arithmetic and the leftover minor units are handed out by a fixed rule, so the same
 * input always produces the same split and the parts always add up to the total.
 */

import { HttpError } from '../types';

/** Largest amount accepted, in minor units. Keeps every product below 2^53. */
export const MAX_AMOUNT = 10_000_000_000;

/** How a total is divided among members. Member ids are opaque strings. */
export type SplitSpec =
  | {
      /** Equal parts, optionally shifted per member: { ken: -800 } means Ken pays 8.00 less
       *  than everyone else, and the others absorb the difference. */
      method: 'equal';
      members: string[];
      adjustments?: Record<string, number>;
    }
  | {
      /** Exact amounts in minor units. Must add up to the total. */
      method: 'exact';
      amounts: Record<string, number>;
    }
  | {
      /** Percentages, up to two decimals. Must add up to 100. */
      method: 'percent';
      percents: Record<string, number>;
    }
  | {
      /** Relative weights, e.g. { zack: 2, mei: 1 }. Up to three decimals. */
      method: 'shares';
      shares: Record<string, number>;
    }
  | {
      /** A receipt: each item is split equally among its members (everyone when empty),
       *  then `extra` (service charge, tax) is spread in proportion to each member's items. */
      method: 'items';
      everyone: string[];
      items: { amount: number; members?: string[]; label?: string }[];
      extra?: number;
    };

export interface Payer {
  member: string;
  amount: number;
}

export interface Transfer {
  from: string;
  to: string;
  amount: number;
}

const bad = (message: string): never => {
  throw new HttpError(400, 'invalid_split', message);
};

export function assertAmount(value: unknown, what = 'amount', allowZero = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    bad(`${what} must be an integer number of minor units.`);
  }
  const amount = value as number;
  if (amount < 0 || (!allowZero && amount === 0) || amount > MAX_AMOUNT) {
    bad(`${what} must be between ${allowZero ? 0 : 1} and ${MAX_AMOUNT}.`);
  }
  return amount;
}

function uniqueMembers(members: unknown, what: string): string[] {
  if (!Array.isArray(members) || members.length === 0) bad(`${what} must list at least one member.`);
  const list = members as unknown[];
  for (const member of list) {
    if (typeof member !== 'string' || member.length === 0) bad(`${what} must contain member ids.`);
  }
  if (new Set(list).size !== list.length) bad(`${what} lists a member twice.`);
  return list as string[];
}

/** Scale decimal weights to integers: 12.5 with 2 decimals becomes 1250. */
function scaledWeights(weights: Record<string, number>, decimals: number, what: string): [string, number][] {
  const entries = Object.entries(weights ?? {});
  if (entries.length === 0) bad(`${what} must list at least one member.`);
  const factor = 10 ** decimals;
  return entries.map(([member, weight]) => {
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      bad(`${what} for ${member} must be a non-negative number.`);
    }
    const scaled = Math.round(weight * factor);
    if (Math.abs(scaled - weight * factor) > 1e-6) bad(`${what} for ${member} has more than ${decimals} decimals.`);
    if (scaled > 100_000) bad(`${what} for ${member} is too large.`);
    return [member, scaled];
  });
}

/**
 * Divide `total` in proportion to integer `weights`.
 * Each member gets floor(total * w / W); the leftover units go one each to the members
 * with the largest remainders, ties broken by the order the members were given.
 */
export function allocate(total: number, weights: [string, number][]): Record<string, number> {
  const sum = weights.reduce((acc, [, w]) => acc + w, 0);
  if (sum <= 0) bad('The weights must not all be zero.');
  const parts = weights.map(([member, w], index) => ({
    member,
    index,
    base: Math.floor((total * w) / sum),
    rest: (total * w) % sum,
  }));
  let leftover = total - parts.reduce((acc, p) => acc + p.base, 0);
  const order = [...parts].sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const part of order) {
    if (leftover === 0) break;
    part.base += 1;
    leftover -= 1;
  }
  const result: Record<string, number> = {};
  for (const part of parts) result[part.member] = part.base;
  return result;
}

/** Turn a split spec into each member's share of `total`. The shares always add up to `total`. */
export function computeShares(total: number, spec: SplitSpec): Record<string, number> {
  assertAmount(total, 'total');
  if (!spec || typeof spec !== 'object') bad('A split is required.');

  let shares: Record<string, number>;
  switch (spec.method) {
    case 'equal': {
      const members = uniqueMembers(spec.members, 'members');
      const adjustments = spec.adjustments ?? {};
      for (const [member, delta] of Object.entries(adjustments)) {
        if (!members.includes(member)) bad(`Adjustment for ${member}, who is not in the split.`);
        if (typeof delta !== 'number' || !Number.isSafeInteger(delta)) bad(`Adjustment for ${member} must be an integer.`);
      }
      const shift = Object.values(adjustments).reduce((acc, d) => acc + d, 0);
      if (total - shift < 0) bad('The adjustments are larger than the total.');
      const base = allocate(total - shift, members.map((m) => [m, 1]));
      shares = {};
      for (const member of members) shares[member] = base[member] + (adjustments[member] ?? 0);
      break;
    }
    case 'exact': {
      shares = {};
      for (const [member, amount] of Object.entries(spec.amounts ?? {})) {
        shares[member] = assertAmount(amount, `Amount for ${member}`, true);
      }
      if (Object.keys(shares).length === 0) bad('amounts must list at least one member.');
      const sum = Object.values(shares).reduce((acc, a) => acc + a, 0);
      if (sum !== total) bad(`The exact amounts add up to ${sum}, not ${total}.`);
      break;
    }
    case 'percent': {
      const weights = scaledWeights(spec.percents, 2, 'Percent');
      if (weights.reduce((acc, [, w]) => acc + w, 0) !== 10_000) bad('Percentages must add up to 100.');
      shares = allocate(total, weights);
      break;
    }
    case 'shares': {
      shares = allocate(total, scaledWeights(spec.shares, 3, 'Share'));
      break;
    }
    case 'items': {
      const everyone = uniqueMembers(spec.everyone, 'everyone');
      if (!Array.isArray(spec.items) || spec.items.length === 0) bad('items must list at least one item.');
      const subtotals: Record<string, number> = Object.fromEntries(everyone.map((m) => [m, 0]));
      let itemsTotal = 0;
      spec.items.forEach((item, i) => {
        const amount = assertAmount(item?.amount, `Item ${i + 1} amount`);
        const members = item.members && item.members.length > 0 ? uniqueMembers(item.members, `Item ${i + 1} members`) : everyone;
        for (const member of members) {
          if (!(member in subtotals)) bad(`Item ${i + 1} lists ${member}, who is not in everyone.`);
        }
        const split = allocate(amount, members.map((m) => [m, 1]));
        for (const member of members) subtotals[member] += split[member];
        itemsTotal += amount;
      });
      const extra = spec.extra === undefined ? 0 : assertAmount(spec.extra, 'extra', true);
      if (itemsTotal + extra !== total) bad(`Items plus extra add up to ${itemsTotal + extra}, not ${total}.`);
      const extraSplit = extra > 0 ? allocate(extra, everyone.map((m) => [m, subtotals[m]])) : {};
      shares = {};
      for (const member of everyone) shares[member] = subtotals[member] + (extraSplit[member] ?? 0);
      break;
    }
    default:
      return bad('Unknown split method.');
  }

  for (const [member, amount] of Object.entries(shares)) {
    if (amount < 0) bad(`${member} would end up with a negative share.`);
  }
  const sum = Object.values(shares).reduce((acc, a) => acc + a, 0);
  if (sum !== total) throw new Error(`split invariant broken: ${sum} !== ${total}`);
  return shares;
}

/** Validate who paid. Defaults are the caller's job; here the list must add up to the total. */
export function checkPayers(total: number, payers: unknown): Payer[] {
  if (!Array.isArray(payers) || payers.length === 0) bad('At least one payer is required.');
  const list = (payers as Payer[]).map((p, i) => {
    if (!p || typeof p.member !== 'string' || p.member.length === 0) bad(`Payer ${i + 1} needs a member id.`);
    return { member: p.member, amount: assertAmount(p.amount, `Payer ${i + 1} amount`) };
  });
  if (new Set(list.map((p) => p.member)).size !== list.length) bad('A payer is listed twice.');
  const sum = list.reduce((acc, p) => acc + p.amount, 0);
  if (sum !== total) bad(`The payers add up to ${sum}, not ${total}.`);
  return list;
}

/**
 * The fewest-transfers plan that settles every balance.
 * `nets` maps member to net position: positive means others owe them.
 * Greedy: repeatedly match the largest debtor with the largest creditor.
 * Ties are broken by member id, so the plan is stable between calls.
 */
export function simplifyDebts(nets: Record<string, number>): Transfer[] {
  const creditors = Object.entries(nets)
    .filter(([, v]) => v > 0)
    .map(([member, amount]) => ({ member, amount }));
  const debtors = Object.entries(nets)
    .filter(([, v]) => v < 0)
    .map(([member, amount]) => ({ member, amount: -amount }));
  const byAmount = (a: { member: string; amount: number }, b: { member: string; amount: number }) =>
    b.amount - a.amount || (a.member < b.member ? -1 : a.member > b.member ? 1 : 0);

  const transfers: Transfer[] = [];
  while (creditors.length > 0 && debtors.length > 0) {
    creditors.sort(byAmount);
    debtors.sort(byAmount);
    const creditor = creditors[0];
    const debtor = debtors[0];
    const amount = Math.min(creditor.amount, debtor.amount);
    transfers.push({ from: debtor.member, to: creditor.member, amount });
    creditor.amount -= amount;
    debtor.amount -= amount;
    if (creditor.amount === 0) creditors.shift();
    if (debtor.amount === 0) debtors.shift();
  }
  return transfers;
}

/** Minor units per major unit for a currency. Defaults to 2. */
export function minorUnitFor(currency: string): number {
  const zero = new Set(['JPY', 'KRW', 'TWD', 'VND', 'CLP', 'ISK', 'HUF', 'IDR']);
  return zero.has(currency.toUpperCase()) ? 0 : 2;
}
