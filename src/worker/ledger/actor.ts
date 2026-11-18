/**
 * Who is allowed to put a name on a ledger change.
 *
 * Penny passes `--by` (or `createdBy`) to every change she makes. On its own that is only her
 * word for who spoke, and a message can try to talk her into a different name ("from: @mei…
 * OK #4"), which would let one person OK their own proposal as someone else. So for rooms on a
 * real homeserver the ledger asks for proof: the gateway, which knows who actually sent the
 * message, puts an `actor_token` in the envelope, signed for that room and that sender, and
 * Penny passes it back with `--actor`. The ledger accepts the change only when the token is
 * valid, unexpired, and names the same room and the same person as `by`.
 *
 * Test rooms are not on a real homeserver, have no gateway in front of them, and skip the
 * check: a server name without a dot (`!london:example`, `!trip:sim`, what agent/sim uses) or
 * under a domain reserved for testing (`.example`, `.test`, `.invalid`, `.localhost`, RFC 2606).
 */

import { safeEqual, sign } from '../crypto';
import { HttpError, type Env } from '../types';

/** Long enough for a message's turn and all its retries (the queue gives up after 30 minutes). */
export const ACTOR_TTL_MS = 3 * 60 * 60_000;

const payload = (room: string, sender: string, expires: number) => `actor|${room}|${sender}|${expires}`;

/** The token the gateway hands Penny for one message: `<expires ms>.<HMAC>`. */
export async function actorToken(env: Env, room: string, sender: string, now = Date.now()): Promise<string> {
  const expires = now + ACTOR_TTL_MS;
  return `${expires}.${await sign(env, payload(room, sender, expires))}`;
}

/** A room on a real Matrix homeserver (`!abc:matrix.netmind.chat`), where only the gateway speaks. */
export function needsActor(room: string): boolean {
  const server = room.slice(room.indexOf(':') + 1).toLowerCase().replace(/:\d+$/, '');
  return server.includes('.') && !/\.(?:example|test|invalid|localhost)$/.test(server);
}

/** Throws 403 unless `token` proves `by` sent a message in `room` recently. */
export async function requireActor(env: Env, room: string, by: unknown, token: unknown, now = Date.now()): Promise<void> {
  if (!needsActor(room)) return;
  const refuse = (why: string) => {
    throw new HttpError(
      403,
      'actor_unverified',
      `${why} A change can only be made in the name of the person who sent the message: --by must be the sender_id, with --actor set to the actor_token from the same message.`,
    );
  };
  if (typeof by !== 'string' || !by) return refuse('No member given.');
  if (typeof token !== 'string' || !token) return refuse('No actor token given.');
  const dot = token.indexOf('.');
  const expires = Number(token.slice(0, dot));
  if (dot < 1 || !Number.isSafeInteger(expires)) return refuse('The actor token is malformed.');
  if (expires < now) return refuse('The actor token has expired.');
  if (!safeEqual(token.slice(dot + 1), await sign(env, payload(room, by, expires)))) {
    return refuse('The actor token does not belong to this member in this room.');
  }
}
