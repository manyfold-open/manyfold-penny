/**
 * POST /api/narra/events: where Narra delivers group and private messages for Penny.
 *
 * Called by Narra, not a browser, so like /api/ledger/* it skips the Origin check and the
 * admin password and takes `Authorization: Bearer <NARRA_WEBHOOK_SECRET>` instead. Without
 * that secret the route answers 503, so a fresh deploy never takes messages from anyone.
 *
 * The handler does only cheap work: check the secret, parse, sort the message with the
 * filter, and hand anything worth a Penny turn to its room's queue. It answers 202 right
 * away; Penny's turn and the reply happen later in the queue (see queue.ts).
 */

import { Hono } from 'hono';
import { safeEqual } from '../crypto';
import { HttpError, type Env } from '../types';
import { classify } from './filter';
import { InboundError, parseInbound } from './inbound';

const DEFAULT_MATRIX_ID = '@agent-54ebea3a:matrix.netmind.chat';

const gateway = new Hono<{ Bindings: Env }>();

gateway.post('/events', async (c) => {
  const secret = (c.env.NARRA_WEBHOOK_SECRET ?? '').trim();
  if (!secret || !c.env.ROOM_QUEUE) {
    throw new HttpError(503, 'gateway_disabled', 'The Narra gateway is off until NARRA_WEBHOOK_SECRET is set.');
  }
  const header = c.req.header('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented || !safeEqual(presented, secret)) {
    throw new HttpError(401, 'unauthorized', 'A valid webhook secret is required.');
  }

  let message;
  try {
    message = parseInbound(await c.req.json().catch(() => null));
  } catch (error) {
    if (error instanceof InboundError) throw new HttpError(400, 'bad_event', error.message);
    throw error;
  }
  if (!message) return c.json({ result: 'ignored' }, 202);

  const botName = await c.env.DB.prepare('SELECT bot_name FROM ledger_groups WHERE id = ?')
    .bind(message.roomId)
    .first<{ bot_name: string }>();
  const verdict = classify(message, {
    matrixId: (c.env.PENNY_MATRIX_ID ?? '').trim() || DEFAULT_MATRIX_ID,
    names: ['Penny', botName?.bot_name ?? ''],
  });
  if (verdict === 'skip') return c.json({ result: 'skipped' }, 202);

  const queue = c.env.ROOM_QUEUE.get(c.env.ROOM_QUEUE.idFromName(message.roomId));
  const answer = await queue.fetch('https://room-queue/enqueue', {
    method: 'POST',
    body: JSON.stringify({ message, verdict, enqueuedAt: Date.now() }),
  });
  const { result } = (await answer.json()) as { result: string };
  return c.json({ result, verdict }, 202);
});

export default gateway;
