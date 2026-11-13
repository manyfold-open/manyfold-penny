/**
 * A read-only page for one group's ledger, opened from a link Penny posts in the chat.
 *
 * The link is /share/<link_id>.<mac>: link_id is random and stored with the group id, mac is
 * an HMAC of link_id under this deployment's key, so neither the table nor a guessed id is
 * enough. Anyone holding the link can read that one group's balances and recent expenses,
 * nothing else, and asking Penny for a new link (rotate) turns the old one off.
 */

import { safeEqual, sign } from '../crypto';
import { HttpError, type Env } from '../types';
import * as store from './store';

const LINK_ID_BYTES = 16;
const MAC_CHARS = 32;

const randomId = (): string =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(LINK_ID_BYTES))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const tokenFor = async (env: Env, linkId: string) => `${linkId}.${(await sign(env, linkId)).slice(0, MAC_CHARS)}`;

/** The group's share link: the active one, or a new one (always new when rotating). */
export async function shareLink(env: Env, groupId: string, by: string, origin: string, rotate = false): Promise<{ url: string; created: boolean }> {
  await store.getGroup(env, groupId);
  if (typeof by !== 'string' || !by.trim()) throw new HttpError(400, 'invalid_field', 'by is required.');
  const now = new Date().toISOString();
  const active = await env.DB.prepare('SELECT link_id FROM ledger_share_links WHERE group_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1')
    .bind(groupId)
    .first<{ link_id: string }>();
  let linkId = active?.link_id ?? null;
  let created = false;
  if (!linkId || rotate) {
    linkId = randomId();
    await env.DB.batch([
      env.DB.prepare('UPDATE ledger_share_links SET revoked_at = ? WHERE group_id = ? AND revoked_at IS NULL').bind(now, groupId),
      env.DB.prepare('INSERT INTO ledger_share_links (link_id, group_id, created_by, created_at) VALUES (?, ?, ?, ?)').bind(linkId, groupId, by, now),
    ]);
    created = true;
  }
  return { url: `${origin}/share/${await tokenFor(env, linkId)}`, created };
}

/** The group a share token opens, or null for a wrong, forged or revoked one. */
export async function groupForToken(env: Env, token: string): Promise<string | null> {
  const [linkId, mac] = token.split('.');
  if (!linkId || !mac || linkId.length > 64 || mac.length !== MAC_CHARS) return null;
  if (!safeEqual(mac, (await sign(env, linkId)).slice(0, MAC_CHARS))) return null;
  const row = await env.DB.prepare('SELECT group_id FROM ledger_share_links WHERE link_id = ? AND revoked_at IS NULL')
    .bind(linkId)
    .first<{ group_id: string }>();
  return row?.group_id ?? null;
}

/* ───────── the page ───────── */

const SYMBOLS: Record<string, string> = { GBP: '£', USD: '$', EUR: '€', JPY: '¥', CNY: '¥', TWD: 'NT$', HKD: 'HK$' };
const CATEGORIES: Record<string, string> = {
  food: '餐飲',
  drinks: '酒水飲料',
  groceries: '雜貨',
  transport: '交通',
  accommodation: '住宿',
  tickets: '門票',
  entertainment: '娛樂',
  shopping: '購物',
  utilities: '水電',
  rent: '房租',
  other: '其他',
};

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function money(currency: string, minorUnit: number) {
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  return (amount: number) => {
    const sign = amount < 0 ? '-' : '';
    const value = (Math.abs(amount) / 10 ** minorUnit).toLocaleString('en-GB', { minimumFractionDigits: minorUnit, maximumFractionDigits: minorUnit });
    return `${sign}${symbol}${value}`;
  };
}

const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

export async function sharePage(env: Env, groupId: string): Promise<string> {
  const group = await store.getGroup(env, groupId);
  const [members, bal, recent, stats] = await Promise.all([
    store.listMembers(env, groupId),
    store.balances(env, groupId),
    store.listExpenses(env, groupId, { limit: 20 }),
    store.stats(env, groupId, {}),
  ]);
  const names = new Map(members.map((m) => [m.id, m.name]));
  const name = (id: string) => esc(names.get(id) ?? id.replace(/^@/, '').split(':')[0]);
  const fmt = money(group.currency, group.minorUnit);
  const bot = esc(group.botName || 'Penny');

  const transfers = bal.transfers.length
    ? `<ul class="list">${bal.transfers
        .map((t) => `<li><span>${name(t.from)} → ${name(t.to)}</span><b>${esc(fmt(t.amount))}</b></li>`)
        .join('')}</ul>`
    : '<p class="quiet">大家都結清了 🎉</p>';

  const top = Math.max(...stats.byCategory.map((c) => c.amount), 1);
  const categories = stats.byCategory.length
    ? stats.byCategory
        .map(
          (c) =>
            `<div class="bar"><span>${esc(CATEGORIES[c.category] ?? c.category)}</span><i style="width:${Math.max(4, Math.round((Math.max(c.amount, 0) / top) * 100))}%"></i><b>${esc(fmt(c.amount))}</b></div>`,
        )
        .join('')
    : '<p class="quiet">還沒有記帳</p>';

  const expenses = recent.entries.length
    ? `<ul class="list">${recent.entries
        .map((e) => {
          const payers = e.payers.map((p) => name(p.member)).join('、');
          const what = esc(e.description || CATEGORIES[e.category] || '');
          return `<li><span><small>#${e.seq} · ${md(e.spentOn)}</small>${what}<small>${payers} 付${e.type === 'refund' ? '（退款）' : ''}</small></span><b>${esc(fmt(e.type === 'refund' ? -e.amount : e.amount))}</b></li>`;
        })
        .join('')}</ul>`
    : '<p class="quiet">還沒有記帳</p>';

  const range = stats.firstDay && stats.lastDay ? `${md(stats.firstDay)}–${md(stats.lastDay)}` : '';

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(group.name || '帳本')} · ${bot}</title>
<style>
:root{--bg:#f6f4ef;--card:#fff;--ink:#1d2433;--quiet:#6b7280;--line:#e7e2d8;--accent:#e8743b;--bar:#f3c9a8}
@media (prefers-color-scheme:dark){:root{--bg:#141821;--card:#1d2330;--ink:#eef0f4;--quiet:#9aa3b2;--line:#2b3343;--accent:#f08a54;--bar:#6b3d24}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif}
main{max-width:560px;margin:0 auto;padding:20px 16px 40px}
header h1{margin:0;font-size:22px}header p{margin:2px 0 0;color:var(--quiet);font-size:14px}
.total{font-size:40px;font-weight:700;margin:16px 0 0}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin-top:14px}
h2{font-size:15px;margin:0 0 8px;color:var(--quiet);font-weight:600}
.list{list-style:none;margin:0;padding:0}.list li{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid var(--line)}
.list li:first-child{border-top:0}.list span{display:flex;flex-direction:column;min-width:0}.list small{color:var(--quiet);font-size:12px}
.list b{white-space:nowrap;font-variant-numeric:tabular-nums}
.bar{display:grid;grid-template-columns:4.5em 1fr auto;align-items:center;gap:10px;padding:5px 0}
.bar i{display:block;height:10px;border-radius:5px;background:var(--bar)}.bar b{font-variant-numeric:tabular-nums;font-size:14px}
.quiet{color:var(--quiet);margin:0}footer{color:var(--quiet);font-size:12px;margin-top:20px;text-align:center}
</style>
</head>
<body>
<main>
<header><h1>${esc(group.name || '帳本')}</h1><p>${bot} 記的帳${range ? ` · ${range}` : ''} · ${stats.count} 筆</p></header>
<p class="total">${esc(fmt(stats.total))}</p>
<section><h2>誰欠誰</h2>${transfers}</section>
<section><h2>錢花在哪</h2>${categories}</section>
<section><h2>最近記的帳</h2>${expenses}</section>
<footer>只看得到這個群組的帳 · 更新於 ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC</footer>
</main>
</body>
</html>`;
}
