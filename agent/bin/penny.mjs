#!/usr/bin/env node
// Penny's ledger tool. Every money operation goes through here; Penny never does the math.
//
//   node bin/penny.mjs <command> [args] [--flag value ...]
//
// Prints the ledger's JSON reply. Exits 1 with {"error": ...} on failure.
// Configuration: see ledger.mjs.

import { LedgerError, enc, ledger } from './ledger.mjs';

const HELP = `penny <command> ...

Group and members
  group <room>                                   settings and members
  setup <room> --currency GBP [--name N] [--bot-name N] [--default-split JSON|null]
  members <room> --json '[{"id":"@zack:x","name":"Zack"}]' [--complete]
  guest <room> --name An --sponsor <member>

Proposing (nothing counts until someone confirms)
  add <room> --by <member> --json '{"description":"Dinner","category":"food","amount":12000,
      "paidBy":"<member>","split":{"method":"equal","members":[...]},"spentOn":"2026-11-06"}'
  edit <room> <seq> --by <member> --json '{"amount":14000}'
  delete <room> <seq> --by <member>
  settle <room> --by <member> --from <member> --to <member> --amount 17500

Confirming
  pending <room>
  confirm <room> <seq> --by <member>
  cancel <room> <seq> --by <member>

Reading
  balances <room>
  summary <room> <member>
  stats <room> [--from 2026-11-06] [--to 2026-11-09]
  list <room> [--limit 5] [--before <seq>]
  entry <room> <seq>
  share <room> --by <member> [--rotate]           the group's read-only page link

Memory and people
  memory <room>                                   list learned habits
  remember <room> <key> <value>
  forget <room> <key>
  payinfo <member> [--set "Monzo ..."] [--forget]
  overview <member> [--with <other member>]       private chats only, for that member

Amounts are integers in the currency's minor unit (pence). Split methods:
  equal {members, adjustments?}  exact {amounts}  percent {percents}  shares {shares}
  items {everyone, items:[{amount, members?, label?}], extra?}`;

function fail(code, message) {
  process.stdout.write(`${JSON.stringify({ error: { code, message } })}\n`);
  process.exit(1);
}

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[name] = true;
      else {
        flags[name] = next;
        i++;
      }
    } else positional.push(arg);
  }
  return { positional, flags };
}

function json(value, what) {
  try {
    return JSON.parse(value);
  } catch {
    return fail('bad_json', `${what} is not valid JSON.`);
  }
}

function need(value, what) {
  if (value === undefined || value === true || value === '') fail('missing_argument', `${what} is required.`);
  return value;
}

async function request(method, path, body) {
  try {
    const { ok, data } = await ledger(method, path, body);
    process.stdout.write(`${JSON.stringify(data)}\n`);
    if (!ok) process.exit(1);
  } catch (error) {
    if (error instanceof LedgerError) fail(error.code, error.message);
    throw error;
  }
}

async function main() {
  const { positional, flags } = parse(process.argv.slice(2));
  const [command, a, b, c] = positional;
  const room = () => `/groups/${enc(need(a, 'room'))}`;
  const seq = () => need(b, 'entry number');
  const by = () => need(flags.by, '--by');

  switch (command) {
    case 'group':
      return request('GET', room());
    case 'setup': {
      const settings = {};
      if (flags.currency) settings.currency = flags.currency;
      if (flags.name) settings.name = flags.name;
      if (flags['bot-name']) settings.botName = flags['bot-name'];
      if (flags['default-split']) settings.defaultSplit = json(flags['default-split'], '--default-split');
      return request('PUT', room(), settings);
    }
    case 'members':
      return request('PUT', `${room()}/members`, { members: json(need(flags.json, '--json'), '--json'), complete: flags.complete === true });
    case 'guest':
      return request('POST', `${room()}/guests`, { name: need(flags.name, '--name'), sponsorId: need(flags.sponsor, '--sponsor') });
    case 'add':
      return request('POST', `${room()}/expenses`, { ...json(need(flags.json, '--json'), '--json'), createdBy: by() });
    case 'edit':
      return request('POST', `${room()}/expenses/${seq()}/edit`, { ...json(need(flags.json, '--json'), '--json'), createdBy: by() });
    case 'delete':
      return request('POST', `${room()}/expenses/${seq()}/delete`, { createdBy: by() });
    case 'settle':
      return request('POST', `${room()}/settlements`, {
        createdBy: by(),
        from: need(flags.from, '--from'),
        to: need(flags.to, '--to'),
        amount: Number(need(flags.amount, '--amount')),
      });
    case 'pending':
      return request('GET', `${room()}/pending`);
    case 'confirm':
      return request('POST', `${room()}/entries/${seq()}/confirm`, { by: by() });
    case 'cancel':
      return request('POST', `${room()}/entries/${seq()}/cancel`, { by: by() });
    case 'balances':
      return request('GET', `${room()}/balances`);
    case 'summary':
      return request('GET', `${room()}/members/${enc(need(b, 'member'))}/summary`);
    case 'stats': {
      const query = new URLSearchParams();
      if (flags.from) query.set('from', flags.from);
      if (flags.to) query.set('to', flags.to);
      return request('GET', `${room()}/stats${query.size ? `?${query}` : ''}`);
    }
    case 'list': {
      const query = new URLSearchParams();
      if (flags.limit) query.set('limit', flags.limit);
      if (flags.before) query.set('before', flags.before);
      return request('GET', `${room()}/expenses${query.size ? `?${query}` : ''}`);
    }
    case 'entry':
      return request('GET', `${room()}/entries/${seq()}`);
    case 'share':
      return request('POST', `${room()}/share`, { by: by(), rotate: flags.rotate === true });
    case 'memory':
      return request('GET', `${room()}/memory`);
    case 'remember':
      return request('PUT', `${room()}/memory/${enc(need(b, 'key'))}`, { value: need(c, 'value') });
    case 'forget':
      return request('DELETE', `${room()}/memory/${enc(need(b, 'key'))}`);
    case 'payinfo': {
      const path = `/people/${enc(need(a, 'member'))}/payment-info`;
      if (flags.forget) return request('DELETE', path);
      if (flags.set) return request('PUT', path, { info: flags.set });
      return request('GET', path);
    }
    case 'overview': {
      const other = flags.with ? `?with=${enc(flags.with)}` : '';
      return request('GET', `/people/${enc(need(a, 'member'))}/overview${other}`);
    }
    case undefined:
    case 'help':
    case '--help':
      process.stdout.write(`${HELP}\n`);
      return;
    default:
      return fail('unknown_command', `Unknown command "${command}". Run: node bin/penny.mjs help`);
  }
}

await main();
