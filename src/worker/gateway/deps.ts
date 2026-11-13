import { A2AError } from '../a2a';
import type { Env } from '../types';
import { envelope } from './envelope';
import type { Deps } from './queue';
import { noteText } from './queue';
import { NarraError, deleteInRoom, patchInRoom, postToRoom, runPennyTurn } from './reply';

export function pennyDeps(env: Env): Deps {
  return {
    turn: (item) => runPennyTurn(env, envelope(item.message, item.verdict), item.message.eventId),
    post: async (item, text) => {
      await postToRoom(env, item.message.roomId, text, item.message.eventId);
    },
    ack: (item) => postToRoom(env, item.message.roomId, noteText(item, 'working') ?? '', `${item.message.eventId}:note`),
    patch: (item, ackId, text) => patchInRoom(env, item.message.roomId, ackId, text, `${item.message.eventId}:answer`),
    remove: (item, ackId) => deleteInRoom(env, item.message.roomId, ackId, `${item.message.eventId}:remove`),
    retryable: (error) =>
      error instanceof A2AError || error instanceof NarraError ? error.retryable : true,
    log: (line) => console.log(`[gateway] ${line}`),
  };
}
