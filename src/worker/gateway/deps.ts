import { A2AError } from '../a2a';
import type { Env } from '../types';
import { envelope } from './envelope';
import type { Deps } from './queue';
import { NarraError, postToRoom, runPennyTurn } from './reply';

export function pennyDeps(env: Env): Deps {
  return {
    turn: (item) => runPennyTurn(env, envelope(item.message, item.verdict), item.message.eventId),
    post: (item, text) => postToRoom(env, item.message.roomId, text, item.message.eventId),
    retryable: (error) =>
      error instanceof A2AError || error instanceof NarraError ? error.retryable : true,
    log: (line) => console.log(`[gateway] ${line}`),
  };
}
