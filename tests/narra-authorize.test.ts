// agent/bin/narra.mjs authorize: only a `not_mentioned` denial is accepted, and only with
// --allow-unmentioned. Runs the real script against a fake Narra endpoint.
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server: Server;
let endpoint = '';
let reply: { status: number; body: unknown } = { status: 200, body: { allow: true } };
let lastBody: Record<string, unknown> = {};
const join = (...parts: string[]) => parts.join('/');
const root = mkdtempSync(join(process.env.TMPDIR?.replace(/\/$/, '') || '/tmp', 'penny-narra-'));

beforeAll(async () => {
  mkdirSync(join(root, 'bin'));
  copyFileSync(join(process.cwd(), 'agent', 'bin', 'narra.mjs'), join(root, 'bin', 'narra.mjs'));
  mkdirSync(join(root, '.narra', 'agt_test'), { recursive: true });
  writeFileSync(join(root, '.narra', 'agt_test', 'agent-runtime-token'), 'test-token');
  server = createServer((req: { on(e: string, f: (c?: unknown) => void): void }, res: { writeHead(s: number, h: Record<string, string>): void; end(b: string): void }) => {
    let data = '';
    req.on('data', (c?: unknown) => (data += String(c)));
    req.on('end', () => {
      lastBody = JSON.parse(data || '{}');
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  endpoint = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function authorize(...extra: string[]): Promise<{ code: number; out: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'bin', 'narra.mjs'), 'authorize', '--room', '!g:x', '--sender', '@sp-zack:x', ...extra], {
      env: { ...process.env, NARRA_API_ENDPOINT: endpoint },
    });
    let out = '';
    child.stdout.on('data', (c: unknown) => (out += String(c)));
    child.on('close', (code: number | null) => resolve({ code: code ?? 0, out: JSON.parse(out.trim() || '{}') }));
  });
}

describe('narra.mjs authorize --allow-unmentioned', () => {
  it('accepts a not_mentioned denial only when asked to', async () => {
    reply = { status: 200, body: { allow: false, reason: 'not_mentioned', roomKind: 'group' } };
    const plain = await authorize();
    expect(plain.code).toBe(1);
    expect(plain.out.allow).toBe(false);
    const allowed = await authorize('--allow-unmentioned');
    expect(allowed.code).toBe(0);
    expect(allowed.out).toEqual({ allow: true, reason: 'unmentioned_accepted' });
    expect(lastBody.mentioned).toBe(false);
  });

  it('still stops on every other denial', async () => {
    for (const reason of ['sender_blocked', 'sender_suspended', 'not_group_member', 'binding_inactive', 'conversation_not_active']) {
      reply = { status: 200, body: { allow: false, reason } };
      const res = await authorize('--allow-unmentioned');
      expect(res.code, reason).toBe(1);
      expect(res.out.allow, reason).toBe(false);
    }
  });

  it('does not change a mentioned check', async () => {
    reply = { status: 200, body: { allow: false, reason: 'not_mentioned' } };
    const res = await authorize('--mentioned', '--allow-unmentioned');
    expect(res.code).toBe(1);
  });
});
