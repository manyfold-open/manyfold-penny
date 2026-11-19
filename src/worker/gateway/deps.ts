import { A2AError } from '../a2a';
import { actorToken } from '../ledger/actor';
import type { Env } from '../types';
import { envelope } from './envelope';
import { isNarraAgent } from './filter';
import { editContent, messageContent, plainMentions } from './mentions';
import type { Deps, QueuedMessage } from './queue';
import { MEMBERSHIP_UNVERIFIED, NarraError, patchInRoom, postToRoom, runPennyTurn, txnId } from './reply';
import type { MatrixOp, MatrixOpResult } from './sync';

/** Pauses before resending after Narra refuses a message (its limit on agent messages in a
 *  row in a group): it lets the same send through once a person has spoken again. Only the
 *  post is resent; Penny's answer is kept, not re-run. */
export const MEMBERSHIP_RETRY_MS = [15_000, 45_000, 120_000];

/** Narra's refusals that clear up by themselves. Through the chat API every Synapse 403 reads
 *  matrix-membership-unverified; through Matrix it carries its own code. */
const REFUSED = new Set([MEMBERSHIP_UNVERIFIED, 'agent_chain_exhausted', 'M_FORBIDDEN']);

/** Ask MatrixSync to act as Penny. status 0 means nothing was sent. */
async function matrix(env: Env, op: MatrixOp): Promise<MatrixOpResult> {
  if (!env.MATRIX_SYNC) return { ok: false, status: 0 };
  try {
    const response = await env.MATRIX_SYNC.get(env.MATRIX_SYNC.idFromName('narra')).fetch('https://matrix-sync/matrix', {
      method: 'POST',
      body: JSON.stringify(op),
    });
    return (await response.json()) as MatrixOpResult;
  } catch {
    // The object may have sent it before failing: retry with the same txn id, never another path.
    return { ok: false, status: 599 };
  }
}

function refusal(result: Extract<MatrixOpResult, { ok: false }>): NarraError {
  const code = result.narraCode ?? result.errcode;
  const retryable = result.status === 401 || result.status === 429 || result.status >= 500 || result.status === 403;
  return new NarraError(`Matrix send failed: HTTP ${result.status}${code ? ` · ${code}` : ''}`, retryable, code);
}

/** In a group, Penny's message quotes the one she answers only when smart-quoting says it helps disambiguate. */
function replyTarget(item: QueuedMessage): string | undefined {
  const m = item.message;
  if (
    m.chatType !== 'group' ||
    item.verdict === 'nudge' ||
    m.kind === 'reaction' ||
    !m.eventId.startsWith('$') ||
    isNarraAgent(m.senderId) ||
    m.shouldQuote !== true
  ) {
    return undefined;
  }
  return m.eventId;
}

export function pennyDeps(env: Env): Deps {
  /** A new message, through Matrix (mentions, reply), or the chat API when Matrix is not there. */
  async function send(item: QueuedMessage, text: string, key: string): Promise<string> {
    const result = await matrix(env, {
      op: 'send',
      roomId: item.message.roomId,
      txnId: await txnId(key),
      content: messageContent(text, '', replyTarget(item)),
    });
    if (result.ok) return result.eventId ?? '';
    if (result.status === 0) return postToRoom(env, item.message.roomId, plainMentions(text), key);
    throw refusal(result);
  }

  return {
    turn: async (item) => {
      const m = item.message;
      // Only a person's own message carries their token; a nudge has no sender and gets none.
      const token = m.senderId && item.verdict !== 'nudge' ? await actorToken(env, m.roomId, m.senderId) : undefined;
      return runPennyTurn(env, envelope(m, item.verdict, token), m.eventId);
    },
    post: async (item, text) => {
      await send(item, text, item.message.eventId);
    },
    ack: (item, text) => send(item, text, `${item.message.eventId}:note:${text}`),
    patch: async (item, ackId, text) => {
      // Keyed by the new text too: the note is edited more than once (down, then the answer).
      const key = `${item.message.eventId}:edit:${text}`;
      const result = await matrix(env, { op: 'send', roomId: item.message.roomId, txnId: await txnId(key), content: editContent(ackId, text, '') });
      if (result.ok) return;
      if (result.status === 0) return patchInRoom(env, item.message.roomId, ackId, plainMentions(text), key);
      throw refusal(result);
    },
    typing: async (item, on) => (await matrix(env, { op: 'typing', roomId: item.message.roomId, typing: on })).ok,
    receipt: async (item) => {
      if (item.message.eventId.startsWith('$')) await matrix(env, { op: 'receipt', roomId: item.message.roomId, eventId: item.message.eventId });
    },
    retryable: (error, attempts) => {
      if (error instanceof NarraError && error.code && REFUSED.has(error.code)) {
        return MEMBERSHIP_RETRY_MS[attempts - 1] ?? false;
      }
      return error instanceof A2AError || error instanceof NarraError ? error.retryable : true;
    },
    log: (line) => console.log(`[gateway] ${line}`),
  };
}
