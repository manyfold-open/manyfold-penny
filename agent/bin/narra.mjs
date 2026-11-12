#!/usr/bin/env node
// Penny's link to Narra Messenger. Uses the Narra agent bearer that the bind handoff wrote to
// .narra/<agent>/agent-runtime-token. Never prints the token.
//
//   node bin/narra.mjs authorize --room <room_id> --sender <matrix user id> [--event <event_id>] [--mentioned]
//   node bin/narra.mjs members --room <room_id>
//   node bin/narra.mjs send-image --room <room_id> --file <path>
//   node bin/narra.mjs send-text --room <room_id> --text "..."
//   node bin/narra.mjs messages --room <room_id> [--limit 20]
//   node bin/narra.mjs download --room <room_id> --event <event_id> --output <path>
//
// Prints JSON. Exits 1 with {"error": ...} on failure.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = process.env.NARRA_API_ENDPOINT || 'https://api.netmind.chat';

const fail = (code, message) => {
  process.stdout.write(`${JSON.stringify({ error: { code, message } })}\n`);
  process.exit(1);
};

function tokenFile() {
  const dir = join(ROOT, '.narra');
  const agents = existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(join(dir, d, 'agent-runtime-token'))) : [];
  if (agents.length !== 1) fail('not_bound', 'Expected exactly one bound Narra agent under .narra/.');
  return join(dir, agents[0], 'agent-runtime-token');
}

function parse(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[name] = true;
    else {
      flags[name] = next;
      i++;
    }
  }
  return flags;
}

const need = (flags, name) => {
  const value = flags[name];
  if (value === undefined || value === true || value === '') fail('missing_argument', `--${name} is required.`);
  return value;
};

/** Run the pinned narra-cli with the token file and endpoint filled in, and pass its JSON through. */
function cli(args) {
  const bin = join(ROOT, 'node_modules', '.bin', 'narra-cli');
  if (!existsSync(bin)) fail('not_installed', 'Run npm ci in the workspace first.');
  const result = spawnSync(bin, [...args, '--endpoint', ENDPOINT, '--token-file', tokenFile()], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  const out = (result.stdout || result.stderr || '').trim();
  process.stdout.write(`${out}\n`);
  if (result.status !== 0) process.exit(1);
}

async function authorize(flags) {
  const token = readFileSync(tokenFile(), 'utf8').trim();
  const body = {
    roomId: need(flags, 'room'),
    senderMatrixUserId: need(flags, 'sender'),
    mentioned: flags.mentioned === true,
    ...(typeof flags.event === 'string' ? { eventId: flags.event } : {}),
  };
  let response;
  try {
    response = await fetch(`${ENDPOINT}/api/agent-runtime/matrix/authorize-event`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    // Fail closed: no answer means no permission.
    process.stdout.write(`${JSON.stringify({ allow: false, reason: 'unreachable', detail: error.message })}\n`);
    process.exit(1);
  }
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!response.ok || !data || data.allow !== true) {
    process.stdout.write(`${JSON.stringify({ allow: false, status: response.status, notice: data?.notice ?? null, reason: data?.reason ?? null })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

const [command, ...rest] = process.argv.slice(2);
const flags = parse(rest);

switch (command) {
  case 'authorize':
    await authorize(flags);
    break;
  case 'members':
    cli(['room', 'info', '--room-id', need(flags, 'room'), '--members']);
    break;
  case 'send-image':
    cli(['im', 'send', '--room-id', need(flags, 'room'), '--image', need(flags, 'file')]);
    break;
  case 'send-text':
    cli(['im', 'send', '--room-id', need(flags, 'room'), '--text', need(flags, 'text')]);
    break;
  case 'messages':
    cli(['im', 'messages', '--room-id', need(flags, 'room'), '--limit', String(flags.limit ?? 20)]);
    break;
  case 'download':
    cli(['im', 'attachments', 'download', '--room-id', need(flags, 'room'), '--event-id', need(flags, 'event'), '--output', need(flags, 'output')]);
    break;
  default:
    fail('unknown_command', 'Use authorize, members, send-image, send-text, messages or download.');
}
