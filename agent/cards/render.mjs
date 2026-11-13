#!/usr/bin/env node
// Draw one card from live ledger data and save it as a PNG.
//
//   node cards/render.mjs people     <room>
//   node cards/render.mjs receipt    <room> <seq>
//   node cards/render.mjs poster     <room> [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//   node cards/render.mjs categories <room> [--from ...] [--to ...]
//   node cards/render.mjs daily      <room> [--from ...] [--to ...]
//   node cards/render.mjs expenses   <room> [--limit 5] [--before <seq>]
//
// Every card takes --lang zh-Hant (default), zh-Hans or en.
//
// Prints {"file": "...png", "alt": "...", "width": 720, "height": ...}. Send the file to the
// chat and put `alt` (or a one-line summary) in the text next to it.
// Exits 1 with {"error": ...} when the ledger or the drawing fails.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LedgerError, enc, ledgerOrThrow } from '../bin/ledger.mjs';
import { categoriesCard, dailyCard, expensesCard, peopleCard, posterCard, receiptCard } from './cards.mjs';
import { toPng } from './png.mjs';
import { normalizeLang } from './i18n.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      flags[argv[i].slice(2)] = argv[i + 1];
      i++;
    } else positional.push(argv[i]);
  }
  return { positional, flags };
}

const fail = (code, message) => {
  process.stdout.write(`${JSON.stringify({ error: { code, message } })}\n`);
  process.exit(1);
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

async function build(kind, room, seq, flags) {
  for (const name of ['from', 'to']) {
    if (flags[name] !== undefined && !DAY.test(flags[name])) fail('invalid_argument', `--${name} must be YYYY-MM-DD.`);
  }
  if (flags.from && flags.to && flags.from > flags.to) fail('invalid_argument', '--from must not be after --to.');
  const lang = normalizeLang(flags.lang);
  const g = `/groups/${enc(room)}`;
  const { group, members } = await ledgerOrThrow('GET', g);
  const range = new URLSearchParams();
  if (flags.from) range.set('from', flags.from);
  if (flags.to) range.set('to', flags.to);
  const stats = () => ledgerOrThrow('GET', `${g}/stats${range.size ? `?${range}` : ''}`);

  switch (kind) {
    case 'people':
      return peopleCard({ groupName: group.name, members, balances: await ledgerOrThrow('GET', `${g}/balances`), lang });
    case 'receipt': {
      if (!seq) fail('missing_argument', 'receipt needs an entry number.');
      const { versions } = await ledgerOrThrow('GET', `${g}/entries/${seq}`);
      const entry = versions.find((v) => v.status === 'active') ?? versions.find((v) => v.status === 'pending');
      if (!entry || entry.type === 'settlement' || entry.type === 'void') fail('not_an_expense', `#${seq} is not an expense.`);
      return receiptCard({ entry, members, minorUnit: group.minorUnit, lang });
    }
    case 'poster':
      return posterCard({
        groupName: group.name,
        stats: await stats(),
        balances: await ledgerOrThrow('GET', `${g}/balances`),
        members,
        botName: group.botName,
        lang,
        period: { from: flags.from, to: flags.to },
      });
    case 'categories':
      return categoriesCard({ groupName: group.name, stats: await stats(), lang });
    case 'daily': {
      const s = await stats();
      if (s.byDay.length === 0) fail('no_data', 'There are no expenses in that range yet.');
      return dailyCard({ groupName: group.name, stats: s, lang });
    }
    case 'expenses': {
      const query = new URLSearchParams();
      query.set('limit', flags.limit ?? '5');
      if (flags.before) query.set('before', flags.before);
      const page = await ledgerOrThrow('GET', `${g}/expenses?${query}`);
      return expensesCard({ page, members, currency: group.currency, minorUnit: group.minorUnit, lang });
    }
    default:
      return fail('unknown_card', 'Card must be people, receipt, poster, categories, daily or expenses.');
  }
}

async function main() {
  const { positional, flags } = parse(process.argv.slice(2));
  const [kind, room, seq] = positional;
  if (!kind || !room) fail('missing_argument', 'Usage: node cards/render.mjs <card> <room> [seq] [--flags]');
  let card;
  try {
    card = await build(kind, room, seq, flags);
  } catch (error) {
    if (error instanceof LedgerError) fail(error.code, error.message);
    fail('draw_failed', error.message);
  }
  const { png, width, height } = await toPng(card.svg);
  const dir = resolve(flags.out ?? join(here, '..', 'out'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${kind}-${Date.now()}.png`);
  writeFileSync(file, png);
  process.stdout.write(`${JSON.stringify({ file, alt: card.alt, width, height })}\n`);
}

await main();
