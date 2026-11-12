// The six cards Penny sends to a group. Each takes data exactly as the ledger returned it
// and returns { svg, alt }. No card does any money arithmetic of its own beyond adding up
// what it shows and working out percentages for a chart.

import { C, CATEGORY_LABEL, PAD, WIDTH, fit, header, initial, line, measure, moneyFormat, rect, svg, t } from './svg.mjs';

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
const md = (day) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const weekday = (day) => WEEKDAY[new Date(`${day}T00:00:00Z`).getUTCDay()];
const nameOf = (names) => (id) => names[id] ?? id;

/* ───────── 1. who owes whom: one tile per person ───────── */

export function peopleCard({ groupName, members, balances }) {
  const name = nameOf(Object.fromEntries(members.map((m) => [m.id, m.name])));
  const fmt = moneyFormat(balances.currency, balances.minorUnit, [
    ...balances.nets.map((n) => n.amount),
    ...balances.transfers.map((x) => x.amount),
  ]);
  const net = Object.fromEntries(balances.nets.map((n) => [n.member, n.amount]));
  const people = members.filter((m) => !m.isGuest && (m.active || net[m.id]));

  const tiles = people
    .map((m) => {
      const amount = net[m.id] ?? 0;
      const incoming = balances.transfers.filter((x) => x.to === m.id);
      const outgoing = balances.transfers.filter((x) => x.from === m.id);
      if (amount > 0)
        return { m, amount, kind: 'receive', detail: incoming.map((x) => `${name(x.from)} ${fmt.plain(x.amount)}`).join('、') };
      if (amount < 0)
        return { m, amount: -amount, kind: 'pay', detail: `給 ${outgoing.map((x) => `${name(x.to)} ${fmt.plain(x.amount)}`).join('、')}` };
      return { m, amount: 0, kind: 'even', detail: '沒有要轉的錢' };
    })
    .sort((a, b) => ['receive', 'pay', 'even'].indexOf(a.kind) - ['receive', 'pay', 'even'].indexOf(b.kind) || b.amount - a.amount);

  const [head, top] = header('每個人的狀況', groupName);
  const gap = 8;
  const w = (WIDTH - PAD * 2 - gap) / 2;
  const h = 108;
  let body = head;
  tiles.forEach((tile, i) => {
    const x = PAD + (i % 2) * (w + gap);
    const y = top + 4 + Math.floor(i / 2) * (h + gap);
    const style = {
      receive: { tint: C.receiveTint, ink: C.receive, label: '↓ 要收回' },
      pay: { tint: C.payTint, ink: C.pay, label: '↑ 要付出' },
      even: { tint: C.evenTint, ink: C.even, label: '已結清' },
    }[tile.kind];
    body += rect(x, y, w, h, style.tint, 12);
    body += `<circle cx="${x + 26}" cy="${y + 26}" r="14" fill="${C.ink}"/>`;
    body += t(x + 26, y + 31, initial(tile.m.name), { size: 13, weight: 700, fill: '#FFFFFF', anchor: 'middle' });
    body += t(x + 48, y + 31, fit(tile.m.name, 14, w - 58), { size: 14, weight: 700 });
    body += t(x + 12, y + 58, style.label, { size: 12, weight: 500, fill: style.ink });
    body += t(x + 12, y + 82, tile.kind === 'even' ? '—' : fmt.money(tile.amount), { size: 20, weight: 700, tabular: true });
    body += t(x + 12, y + 99, fit(tile.detail, 12, w - 24), { size: 12, fill: C.even });
  });
  const rows = Math.ceil(tiles.length / 2);
  const bottom = top + 4 + rows * h + (rows - 1) * gap;
  const plan = balances.transfers.length === 0 ? '大家都結清了' : `照這樣轉 ${balances.transfers.length} 筆就結清`;
  body += t(PAD, bottom + 26, plan, { size: 12, fill: C.quiet });

  const alt = balances.transfers.length
    ? `誰欠誰：${balances.transfers.map((x) => `${name(x.from)} 給 ${name(x.to)} ${fmt.money(x.amount)}`).join('，')}`
    : '大家都結清了';
  return { svg: svg(bottom + 42, body), alt };
}

/* ───────── 2. a receipt: who had what ───────── */

export function receiptCard({ entry, members, minorUnit }) {
  const name = nameOf(Object.fromEntries(members.map((m) => [m.id, m.name])));
  const split = entry.split;
  const shares = Object.fromEntries(entry.shares.map((s) => [s.member, s.amount]));
  const payer = entry.payers.map((p) => name(p.member)).join('、');
  const title = `${entry.description || `#${entry.seq}`}：誰吃了什麼`;

  if (!split || split.method !== 'items') {
    // Not an itemised receipt: show each person's share.
    const fmt = moneyFormat(entry.currency, minorUnit, [entry.amount, ...entry.shares.map((s) => s.amount)]);
    const [head, top] = header(entry.description || `#${entry.seq}`, `${payer} 付`);
    let body = head;
    let y = top + 6;
    for (const s of entry.shares) {
      body += line(PAD, y, WIDTH - PAD, y);
      body += t(PAD, y + 20, fit(name(s.member), 13, 220), { size: 13 });
      body += t(WIDTH - PAD, y + 20, fmt.money(s.amount), { size: 13, anchor: 'end', tabular: true });
      y += 30;
    }
    body += line(PAD, y, WIDTH - PAD, y, C.ink);
    body += t(PAD, y + 22, '合計', { size: 14, weight: 700 });
    body += t(WIDTH - PAD, y + 22, fmt.money(entry.amount), { size: 14, weight: 700, anchor: 'end', tabular: true });
    return { svg: svg(y + 40, body), alt: `${entry.description} ${fmt.money(entry.amount)}，${payer} 付` };
  }

  const people = split.everyone;
  if (people.length > 6) throw new Error('The receipt card fits at most 6 people; use the list card instead.');
  const fmt = moneyFormat(entry.currency, minorUnit, [
    entry.amount,
    ...split.items.map((i) => i.amount),
    split.extra ?? 0,
    ...entry.shares.map((s) => s.amount),
  ]);
  const amountW = 56;
  const colW = Math.min(44, (WIDTH - PAD * 2 - amountW - 104) / people.length);
  const labelW = WIDTH - PAD * 2 - amountW - colW * people.length;
  const colX = (i) => PAD + labelW + colW * i + colW / 2;

  const [head, top] = header(title, `${payer} 付`);
  let body = head;
  let y = top + 8;
  people.forEach((p, i) => {
    body += t(colX(i), y, fit(name(p), 12, colW - 2), { size: 12, weight: 700, fill: C.even, anchor: 'middle' });
  });
  body += t(WIDTH - PAD, y, `金額 ${fmt.symbol.trim()}`, { size: 12, fill: C.even, anchor: 'end' });
  y += 10;

  split.items.forEach((item, index) => {
    const who = item.members && item.members.length ? item.members : people;
    body += line(PAD, y, WIDTH - PAD, y);
    body += t(PAD, y + 19, fit(item.label || `品項 ${index + 1}`, 13, labelW - 8), { size: 13 });
    people.forEach((p, i) => {
      body += who.includes(p)
        ? `<circle cx="${colX(i)}" cy="${y + 14}" r="6" fill="${C.ink}"/>`
        : `<circle cx="${colX(i)}" cy="${y + 14}" r="5.25" fill="none" stroke="#C4CCD8" stroke-width="1.5"/>`;
    });
    body += t(WIDTH - PAD, y + 19, fmt.plain(item.amount), { size: 13, anchor: 'end', tabular: true });
    y += 28;
  });

  if (split.extra) {
    body += line(PAD, y, WIDTH - PAD, y);
    body += t(PAD, y + 19, '服務費、稅（按比例）', { size: 12, fill: C.quiet });
    body += t(WIDTH - PAD, y + 19, fmt.plain(split.extra), { size: 12, fill: C.quiet, anchor: 'end', tabular: true });
    y += 28;
  }

  body += line(PAD, y, WIDTH - PAD, y, C.ink);
  body += t(PAD, y + 22, '每人', { size: 13, weight: 700 });
  people.forEach((p, i) => {
    body += t(colX(i), y + 22, fmt.plain(shares[p] ?? 0), { size: 11.5, weight: 700, anchor: 'middle', tabular: true });
  });
  body += t(WIDTH - PAD, y + 22, fmt.plain(entry.amount), { size: 13, weight: 700, anchor: 'end', tabular: true });
  y += 34;
  body += t(PAD, y + 12, '實心圓：有分到這一項', { size: 12, fill: C.quiet });

  const alt = `${entry.description}，共 ${fmt.money(entry.amount)}：${people.map((p) => `${name(p)} ${fmt.money(shares[p] ?? 0)}`).join('、')}`;
  return { svg: svg(y + 28, body), alt };
}

/* ───────── 3. the trip in review ───────── */

export function posterCard({ groupName, stats, balances, members, botName = 'Penny' }) {
  const name = nameOf(Object.fromEntries(members.map((m) => [m.id, m.name])));
  const fmt = moneyFormat(stats.currency, stats.minorUnit, [stats.total, stats.largest?.amount ?? 0]);
  const days = stats.firstDay
    ? Math.round((Date.parse(stats.lastDay) - Date.parse(stats.firstDay)) / 86_400_000) + 1
    : 0;
  const range = stats.firstDay ? (stats.firstDay === stats.lastDay ? md(stats.firstDay) : `${md(stats.firstDay)}–${md(stats.lastDay)}`) : '';

  let body = '';
  body += t(20, 34, fit([groupName, range].filter(Boolean).join(' · '), 13, WIDTH - 40), { size: 13, weight: 500, fill: C.navyText });
  body += t(20, 80, fmt.money(stats.total), { size: 40, weight: 700, fill: '#FFFFFF', tabular: true });
  body += t(20, 104, `${stats.members} 個人 · ${days} 天 · ${stats.count} 筆`, { size: 13, fill: C.navyText });

  const topPayer = stats.payers[0];
  const topCategory = [...stats.byCategory].sort((a, b) => b.count - a.count || b.amount - a.amount)[0];
  const panels = [
    topPayer && ['最常掏錢的人', name(topPayer.member), `付了 ${topPayer.count} 筆`],
    stats.largest && ['最大的一筆', stats.largest.description || `#${stats.largest.seq}`, fmt.money(stats.largest.amount)],
    topCategory && ['最常記的分類', CATEGORY_LABEL[topCategory.category] ?? topCategory.category, `${topCategory.count} 筆`],
  ].filter(Boolean);

  let y = 122;
  for (const [label, value, side] of panels) {
    body += rect(16, y, WIDTH - 32, 58, C.navyPanel, 12);
    body += t(30, y + 23, label, { size: 12, fill: C.navyText });
    body += t(30, y + 45, fit(value, 18, WIDTH - 32 - 28 - measure(side, 14) - 24), { size: 18, weight: 700, fill: '#FFFFFF' });
    body += t(WIDTH - 30, y + 37, side, { size: 14, weight: 500, fill: '#FFFFFF', anchor: 'end', tabular: true });
    y += 66;
  }
  const open = balances.transfers.length;
  body += t(20, y + 18, open ? `還有 ${open} 筆轉帳沒結清，@${botName} 誰欠誰 看方案` : '大家都結清了', { size: 12, fill: C.navyText });

  const alt = `${groupName}：總共 ${fmt.money(stats.total)}，${stats.count} 筆${open ? `，還有 ${open} 筆轉帳沒結清` : ''}`;
  return { svg: svg(y + 40, body, C.navy), alt };
}

/* ───────── 4. where the money went ───────── */

export function categoriesCard({ groupName, stats }) {
  const positive = stats.byCategory.filter((c) => c.amount > 0);
  const top = positive.slice(0, 4);
  const rest = positive.slice(4).reduce((acc, c) => acc + c.amount, 0);
  const slices = top.map((c, i) => ({ label: CATEGORY_LABEL[c.category] ?? c.category, amount: c.amount, color: C.series[i] }));
  if (rest > 0) slices.push({ label: '其他', amount: rest, color: C.other });
  const sum = slices.reduce((acc, s) => acc + s.amount, 0);
  const fmt = moneyFormat(stats.currency, stats.minorUnit, [stats.total, ...slices.map((s) => s.amount)]);

  const [head, top0] = header('錢花在哪', `${groupName} · ${stats.count} 筆`);
  let body = head;
  const cx = PAD + 75;
  const cy = top0 + 86;
  const r = 60;
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  body += `<g transform="rotate(-90 ${cx} ${cy})">`;
  for (const s of slices) {
    const length = (s.amount / sum) * circumference;
    const visible = Math.max(length - (slices.length > 1 ? 2 : 0), 0.5);
    body += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="22" stroke-dasharray="${visible} ${circumference - visible}" stroke-dashoffset="${-offset}"/>`;
    offset += length;
  }
  body += '</g>';
  body += t(cx, cy - 3, '總共', { size: 12, fill: C.quiet, anchor: 'middle' });
  body += t(cx, cy + 16, fit(fmt.money(stats.total), 15, 92), { size: 15, weight: 700, anchor: 'middle', tabular: true });

  const lx = PAD + 168;
  let ly = cy - (slices.length * 26) / 2 + 13;
  for (const s of slices) {
    const pct = `${Math.round((s.amount / sum) * 100)}%`;
    body += rect(lx, ly - 9, 10, 10, s.color, 3);
    body += t(lx + 16, ly, fit(s.label, 13, 48), { size: 13 });
    body += t(WIDTH - PAD - 40, ly, fmt.plain(s.amount), { size: 13, anchor: 'end', tabular: true });
    body += t(WIDTH - PAD, ly, pct, { size: 12, fill: C.quiet, anchor: 'end', tabular: true });
    ly += 26;
  }
  const bottom = cy + r + 34;
  body += t(PAD, bottom, `單位 ${fmt.symbol.trim()}`, { size: 12, fill: C.quiet });
  const alt = `錢花在哪：${slices.map((s) => `${s.label} ${fmt.money(s.amount)}`).join('、')}`;
  return { svg: svg(bottom + 16, body), alt };
}

/* ───────── 5. spending by day ───────── */

export function dailyCard({ groupName, stats }) {
  let days = stats.byDay;
  const trimmed = days.length > 14;
  if (trimmed) days = days.slice(-14);
  const fmt = moneyFormat(stats.currency, stats.minorUnit, days.map((d) => d.amount));
  const max = Math.max(...days.map((d) => d.amount), 1);
  const [head, top] = header('每天花多少', `${groupName} · 單位 ${fmt.symbol.trim()}`);
  let body = head;

  const chartTop = top + 24;
  const chartH = 130;
  const base = chartTop + chartH;
  const slot = (WIDTH - PAD * 2) / days.length;
  const barW = Math.min(36, slot * 0.6);
  const small = days.length > 7;
  days.forEach((d, i) => {
    const x = PAD + slot * i + (slot - barW) / 2;
    const h = Math.max((Math.max(d.amount, 0) / max) * chartH, 2);
    body += `<path d="M${x},${base} V${base - h + 4} a4,4 0 0 1 4,-4 h${barW - 8} a4,4 0 0 1 4,4 V${base} Z" fill="${C.bar}"/>`;
    if (!small || d.amount === max) {
      body += t(x + barW / 2, base - h - 6, fmt.plain(d.amount), { size: small ? 11 : 12.5, weight: d.amount === max ? 700 : 500, anchor: 'middle', tabular: true });
    }
    body += t(x + barW / 2, base + 16, md(d.day), { size: 11, fill: C.quiet, anchor: 'middle' });
    if (!small) body += t(x + barW / 2, base + 31, weekday(d.day), { size: 11, fill: C.quiet, anchor: 'middle' });
  });
  body += line(PAD, base, WIDTH - PAD, base, C.ruleStrong);

  const peak = days.find((d) => d.amount === max);
  const note = `${md(peak.day)} 最高，${fmt.money(peak.amount)}${trimmed ? '（只顯示最近 14 天）' : ''}`;
  body += t(PAD, base + (small ? 40 : 56), note, { size: 12, fill: C.quiet });
  const alt = `每天花多少：${days.map((d) => `${md(d.day)} ${fmt.money(d.amount)}`).join('、')}`;
  return { svg: svg(base + (small ? 56 : 72), body), alt };
}

/* ───────── 6. recent expenses ───────── */

export function expensesCard({ page, members, currency, minorUnit }) {
  const name = nameOf(Object.fromEntries(members.map((m) => [m.id, m.name])));
  const amounts = page.entries.map((e) => e.amount);
  const fmt = moneyFormat(currency, minorUnit, [...amounts, page.total]);
  const seqs = page.entries.map((e) => e.seq);
  const note = seqs.length ? `#${Math.min(...seqs)}–#${Math.max(...seqs)}${page.more ? ' · 還有更早的' : ''}` : '';
  const [head, top] = header('支出明細', note);
  let body = head;
  let y = top + 2;
  if (page.entries.length === 0) {
    body += t(PAD, y + 22, '還沒有記任何支出', { size: 13, fill: C.quiet });
    return { svg: svg(y + 44, body), alt: '還沒有記任何支出' };
  }
  for (const e of page.entries) {
    const refund = e.type === 'refund';
    const sign = refund ? -e.amount : e.amount;
    body += line(PAD, y, WIDTH - PAD, y);
    const title = `#${e.seq} ${e.description || CATEGORY_LABEL[e.category] || ''}`;
    const tags = [e.version > 1 ? '已修改' : '', refund ? '退款' : ''].filter(Boolean).join(' · ');
    body += t(PAD, y + 20, fit(title, 13, 220 - (tags ? measure(tags, 12) + 8 : 0)), { size: 13, weight: 500 });
    if (tags) body += t(PAD + Math.min(measure(title, 13), 220 - measure(tags, 12) - 8) + 8, y + 20, tags, { size: 12, fill: C.quiet });
    body += t(PAD, y + 38, `${md(e.spentOn)} · ${e.payers.map((p) => name(p.member)).join('、')} ${refund ? '收' : '付'}`, { size: 12, fill: C.quiet });
    body += t(WIDTH - PAD, y + 29, fmt.money(sign), { size: 14, anchor: 'end', tabular: true });
    y += 48;
  }
  body += line(PAD, y, WIDTH - PAD, y, C.ruleStrong);
  body += t(PAD, y + 24, `這 ${page.entries.length} 筆合計`, { size: 14, weight: 700 });
  body += t(WIDTH - PAD, y + 24, fmt.money(page.total), { size: 14, weight: 700, anchor: 'end', tabular: true });
  const alt = `支出明細：${page.entries.map((e) => `#${e.seq} ${e.description} ${fmt.money(e.amount)}`).join('、')}`;
  return { svg: svg(y + 42, body), alt };
}
