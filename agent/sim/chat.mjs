#!/usr/bin/env node
// Talk to Penny as if you were in a group chat, from your own computer.
// Wraps your message the way the chat bridge will, sends it with the Manyfold CLI (`mf`),
// prints Penny's reply, and downloads and opens any card it draws.
//
//   node agent/sim/chat.mjs --as Zack "@Penny 晚餐 120 我付，四個人分"
//   node agent/sim/chat.mjs --as Mei "@Penny OK"
//   node agent/sim/chat.mjs --as Ken "@Penny 誰欠誰"
//   node agent/sim/chat.mjs --as Zack --dm "我跟 Mei 總共誰欠誰"
//
// Options:
//   --as <name>       who is speaking: Zack, Mei, Ken or Ray (default Zack)
//   --room <id>       which group ledger to use (default a test room; a new id starts a new group)
//   --name <text>     the group's display name (default 倫敦四日)
//   --dm              a private chat with Penny instead of the group
//   --agent <id>      the Penny agent (default PENNY_AGENT_ID or the one this repo set up)
//   --no-open         do not open cards after downloading them
//
// Every message is a separate Penny turn, like a real chat. Each costs a model call.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PEOPLE = ['Zack', 'Mei', 'Ken', 'Ray'];
const idOf = (name) => `@${name.toLowerCase()}:sim`;

const args = process.argv.slice(2);
const flags = {};
const words = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dm' || a === '--no-open') flags[a.slice(2)] = true;
  else if (a.startsWith('--')) flags[a.slice(2)] = args[++i];
  else words.push(a);
}

const text = words.join(' ').trim();
if (!text) {
  console.error('Usage: node agent/sim/chat.mjs --as Zack "@Penny 晚餐 120 我付，四個人分"');
  process.exit(1);
}
const speaker = PEOPLE.find((p) => p.toLowerCase() === String(flags.as ?? 'Zack').toLowerCase());
if (!speaker) {
  console.error(`--as must be one of ${PEOPLE.join(', ')}.`);
  process.exit(1);
}

const agent = flags.agent ?? process.env.PENNY_AGENT_ID ?? 'agt_agq5agsd2f4plp3442ipkm6isy';
const dm = flags.dm === true;
const room = dm ? `!dm-${speaker.toLowerCase()}:sim` : (flags.room ?? '!london-trip:sim');
const members = dm ? [speaker] : PEOPLE;

const envelope = [
  '<penny-message>',
  `room: ${room}`,
  `room_name: ${dm ? `${speaker} 與 Penny` : (flags.name ?? '倫敦四日')}`,
  `chat: ${dm ? 'dm' : 'group'}`,
  `from: ${idOf(speaker)} (${speaker})`,
  `members: ${members.map((p) => `${idOf(p)} (${p})`).join('; ')}`,
  `time: ${new Date().toISOString()}`,
  '---',
  text,
  '</penny-message>',
].join('\n');

console.log(`\x1b[2m${speaker}${dm ? ' (private)' : ''}: ${text}\x1b[0m`);
const result = spawnSync('mf', ['agent', 'send', agent, '-'], { input: envelope, encoding: 'utf8' });
if (result.error) {
  console.error(`Could not run mf: ${result.error.message}. Install the Manyfold CLI and log in first.`);
  process.exit(1);
}
const output = `${result.stdout}${result.stderr}`;
const lines = output.split('\n');
const reply = lines.filter((l) => !l.startsWith('→ ') && !/^session |continue: mf agent send/.test(l) && l.trim() !== '');
const footer = reply.length && /·.*\$/.test(reply[reply.length - 1]) ? reply.pop() : '';
console.log(reply.join('\n'));
if (footer) console.log(`\x1b[2m${footer}\x1b[0m`);
if (result.status !== 0) process.exit(result.status ?? 1);

// Download and open any card Penny drew.
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'sim');
for (const match of output.matchAll(/\[image: [^\]]*?(out\/[\w-]+\.png)\]/g)) {
  mkdirSync(outDir, { recursive: true });
  const local = join(outDir, match[1].split('/').pop());
  execFileSync('mf', ['files', 'download', match[1], local, '--agent-id', agent], { stdio: 'ignore' });
  console.log(`\x1b[2mcard saved to ${local}\x1b[0m`);
  if (!flags['no-open'] && process.platform === 'darwin') spawnSync('open', [local]);
}
