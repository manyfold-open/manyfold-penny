/**
 * Penny's daily recap: once a day, at DAILY_HOUR in each group's own time zone, a group that
 * recorded something that day hears a one- or two-line summary. A day with nothing recorded
 * stays quiet, and the gateway decides that from the ledger alone, so a quiet group costs no
 * Penny turn.
 */

import type { Env } from '../types';
import { zoneFor } from '../ledger/store';

export const DAILY_HOUR = 21;

/** Date (YYYY-MM-DD) and hour in a time zone. */
export function localDateHour(zone: string, at: number): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

export interface GroupZone {
  id: string;
  zone: string;
}

export interface NewEntry {
  groupId: string;
  createdAt: string;
}

/** Groups past DAILY_HOUR in their own time that recorded something on their own today. */
export function dailyDue(groups: GroupZone[], entries: NewEntry[], now: number): { roomId: string; date: string }[] {
  const due: { roomId: string; date: string }[] = [];
  for (const group of groups) {
    const { date, hour } = localDateHour(group.zone, now);
    if (hour < DAILY_HOUR) continue;
    const today = entries.some((e) => e.groupId === group.id && localDateHour(group.zone, Date.parse(e.createdAt)).date === date);
    if (today) due.push({ roomId: group.id, date });
  }
  return due;
}

/** dailyDue, read from D1: entries proposed in the last 26 hours (every zone's "today"). */
export async function dailyFromLedger(env: Env, now: number): Promise<{ roomId: string; date: string }[]> {
  const since = new Date(now - 26 * 60 * 60_000).toISOString();
  const { results: entries } = await env.DB.prepare(
    `SELECT group_id AS groupId, created_at AS createdAt FROM ledger_expenses WHERE created_at >= ? AND version = 1
     UNION ALL SELECT group_id, created_at FROM ledger_settlements WHERE created_at >= ?`,
  )
    .bind(since, since)
    .all<NewEntry>();
  if (entries.length === 0) return [];
  const ids = [...new Set(entries.map((e) => e.groupId))];
  const { results: groups } = await env.DB.prepare(
    `SELECT g.id, g.currency, p.timezone FROM ledger_groups g LEFT JOIN ledger_group_prefs p ON p.group_id = g.id
     WHERE g.id IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(ids))
    .all<{ id: string; currency: string; timezone: string | null }>();
  return dailyDue(
    groups.map((g) => ({ id: g.id, zone: g.timezone ?? zoneFor(g.currency) })),
    entries,
    now,
  );
}
