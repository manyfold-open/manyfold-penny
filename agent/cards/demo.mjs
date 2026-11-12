#!/usr/bin/env node
// Render all six cards from built-in sample data (the London trip from the prototype),
// without touching the ledger. Writes PNGs to out/demo/. Use it to check the drawing.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { categoriesCard, dailyCard, expensesCard, peopleCard, posterCard, receiptCard } from './cards.mjs';
import { toPng } from './png.mjs';

const Z = '@zack:x';
const M = '@mei:x';
const K = '@ken:x';
const R = '@ray:x';
const members = [
  { id: Z, name: 'Zack', isGuest: false, active: true },
  { id: M, name: 'Mei', isGuest: false, active: true },
  { id: K, name: 'Ken', isGuest: false, active: true },
  { id: R, name: 'Ray', isGuest: false, active: true },
];
const groupName = '倫敦四日';
const balances = {
  currency: 'GBP',
  minorUnit: 2,
  nets: [
    { member: Z, amount: 21000 },
    { member: R, amount: 4000 },
    { member: K, amount: -7500 },
    { member: M, amount: -17500 },
  ],
  transfers: [
    { from: M, to: Z, amount: 17500 },
    { from: K, to: R, amount: 4000 },
    { from: K, to: Z, amount: 3500 },
  ],
};
const stats = {
  currency: 'GBP',
  minorUnit: 2,
  total: 240000,
  count: 23,
  members: 4,
  firstDay: '2026-11-06',
  lastDay: '2026-11-09',
  byCategory: [
    { category: 'accommodation', amount: 96000, count: 1 },
    { category: 'food', amount: 72000, count: 12 },
    { category: 'transport', amount: 43200, count: 6 },
    { category: 'tickets', amount: 28800, count: 4 },
  ],
  byDay: [
    { day: '2026-11-06', amount: 124000 },
    { day: '2026-11-07', amount: 48000 },
    { day: '2026-11-08', amount: 40000 },
    { day: '2026-11-09', amount: 28000 },
  ],
  payers: [{ member: Z, count: 9, amount: 120000 }],
  largest: { seq: 3, description: 'Airbnb 三晚', category: 'accommodation', amount: 96000, spentOn: '2026-11-06' },
};
const receipt = {
  seq: 23,
  version: 1,
  type: 'expense',
  status: 'active',
  description: '午餐 Pub',
  category: 'food',
  amount: 9900,
  currency: 'GBP',
  spentOn: '2026-11-09',
  payers: [{ member: R, amount: 9900 }],
  shares: [
    { member: R, amount: 3319 },
    { member: K, amount: 3094 },
    { member: M, amount: 1744 },
    { member: Z, amount: 1743 },
  ],
  split: {
    method: 'items',
    everyone: [Z, M, K, R],
    items: [
      { amount: 1900, members: [R], label: '炸魚薯條' },
      { amount: 1700, members: [K], label: '漢堡' },
      { amount: 1200, label: '蘇格蘭蛋' },
      { amount: 1000, members: [M, Z], label: '例湯' },
      { amount: 3000, label: '分享拼盤' },
    ],
    extra: 1100,
  },
};
const entry = (seq, description, amount, payer, day, extra = {}) => ({
  seq,
  version: 1,
  type: 'expense',
  status: 'active',
  description,
  category: 'food',
  amount,
  currency: 'GBP',
  spentOn: day,
  payers: [{ member: payer, amount }],
  shares: [],
  ...extra,
});
const page = {
  entries: [
    entry(23, '午餐 Pub', 9900, R, '2026-11-09'),
    entry(22, '早餐 Full English', 3600, R, '2026-11-09'),
    entry(21, '晚餐 Dishoom', 14000, Z, '2026-11-08', { version: 2 }),
    entry(20, '倫敦塔門票', 12000, K, '2026-11-08', { category: 'tickets' }),
    entry(19, 'Airbnb 訂金退回', 10000, R, '2026-11-08', { type: 'refund' }),
  ],
  total: 29500,
  more: true,
};

const cards = {
  people: peopleCard({ groupName, members, balances }),
  receipt: receiptCard({ entry: receipt, members, minorUnit: 2 }),
  poster: posterCard({ groupName, stats, balances, members }),
  categories: categoriesCard({ groupName, stats }),
  daily: dailyCard({ groupName, stats }),
  expenses: expensesCard({ page, members, currency: 'GBP', minorUnit: 2 }),
};

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'demo');
mkdirSync(dir, { recursive: true });
for (const [name, card] of Object.entries(cards)) {
  const { png, width, height } = await toPng(card.svg);
  writeFileSync(join(dir, `${name}.png`), png);
  writeFileSync(join(dir, `${name}.svg`), card.svg);
  console.log(`${name}.png ${width}x${height}  ${card.alt}`);
}
