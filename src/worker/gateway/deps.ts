import { A2AError } from '../a2a';
import type { Env } from '../types';
import { envelope } from './envelope';
import type { Deps } from './queue';
import { noteText } from './queue';
import { MEMBERSHIP_UNVERIFIED, NarraError, deleteInRoom, patchInRoom, postToRoom, runPennyTurn } from './reply';

/** Pauses before resending after Narra's membership 403: it has let the same send through
 *  within a minute or so. Only the post is resent; Penny's answer is kept, not re-run. */
export const MEMBERSHIP_RETRY_MS = [15_000, 45_000, 120_000];

export function pennyDeps(env: Env): Deps {
  return {
    turn: (item) => runPennyTurn(env, envelope(item.message, item.verdict), item.message.eventId),
    post: async (item, text) => {
      await postToRoom(env, item.message.roomId, text, item.message.eventId);
    },
    ack: (item) => postToRoom(env, item.message.roomId, noteText(item, 'working') ?? '', `${item.message.eventId}:note`),
    patch: (item, ackId, text) => patchInRoom(env, item.message.roomId, ackId, text, `${item.message.eventId}:answer`),
    remove: (item, ackId) => deleteInRoom(env, item.message.roomId, ackId, `${item.message.eventId}:remove`),
    retryable: (error, attempts) => {
      if (error instanceof NarraError && error.code === MEMBERSHIP_UNVERIFIED) {
        return MEMBERSHIP_RETRY_MS[attempts - 1] ?? false;
      }
      return error instanceof A2AError || error instanceof NarraError ? error.retryable : true;
    },
    log: (line) => console.log(`[gateway] ${line}`),
  };
}
