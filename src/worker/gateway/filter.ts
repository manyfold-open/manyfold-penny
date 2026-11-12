/**
 * Decides, from the text alone, whether a group message is worth a Penny turn.
 *
 * Every message the gateway skips costs nothing: no agent call, no session growth. It is
 * still in the room's history, which Penny reads when someone asks her to catch up.
 * The rules mirror step 0 of agent/PENNY.md, so Penny and the gateway agree.
 */

import type { InboundMessage } from './inbound';

export type Verdict = 'called' | 'expense' | 'skip';

export interface BotIdentity {
  /** Penny's Matrix user id, e.g. @agent-54ebea3a:matrix.netmind.chat */
  matrixId: string;
  /** Names she answers to: "Penny" and whatever this group renamed her to. */
  names: string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A whole message that answers a proposal: "OK", "好", "對", "OK #21", "全部 OK", "取消 #3", "改成 50".
const ANSWER =
  /^\s*(?:@\S+\s+)?(?:全部\s*)?(?:ok|okay|yes|no|好|好的|對|對的|对|沒問題|没问题|確認|确认|可以|不要|先不要|算了)(?:\s*#\d+)*\s*(?:全部)?[!！。.~～]*\s*$/i;
const CHANGE = /^\s*(?:取消|改成|改為|改为)\s*\S{0,20}\s*$/;
const ENTRY_REF = /#\d+/;

// A number, and a word for spending or moving money. Both must be there.
const AMOUNT = /(?:[£$€¥]|\b(?:gbp|usd|eur|jpy|twd|hkd|cny|rmb)\b)?\s*\d+(?:[.,]\d+)?\s*(?:元|塊|块|镑|鎊|英鎊|英镑|刀|pounds?|quid|bucks?|k)?/i;
const MONEY_WORDS =
  /付|花了|花費|花费|買了|买了|請客|请客|出了|我出|墊|垫|轉給|转给|轉了|转了|還給|还给|還了|还了|欠|分帳|分账|平分|AA|收據|收据|發票|发票|paid|spent|owe|split|refund|venmo|transfer|[£$€¥]/i;

export function classify(message: InboundMessage, bot: BotIdentity): Verdict {
  if (message.senderId === bot.matrixId) return 'skip';
  if (message.chatType === 'dm') return 'called';

  const text = message.text;
  const mentioned =
    message.mentions.includes(bot.matrixId) ||
    text.includes(bot.matrixId) ||
    bot.names.some((name) => name && new RegExp(`@?${escape(name)}(?![\\p{L}\\p{N}])`, 'iu').test(text));
  if (mentioned) return 'called';

  if (ANSWER.test(text) || CHANGE.test(text) || (ENTRY_REF.test(text) && text.length <= 20)) return 'called';

  const digits = /\d/.test(text) && AMOUNT.test(text);
  if (digits && MONEY_WORDS.test(text)) return 'expense';

  return 'skip';
}
