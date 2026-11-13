/**
 * Decides, from the text alone, whether a group message is worth a Penny turn.
 *
 * Every message the gateway skips costs nothing: no agent call, no session growth. It is
 * still in the room's history, which Penny reads when someone asks her to catch up.
 * The rules mirror step 0 of agent/PENNY.md, so Penny and the gateway agree.
 */

import type { InboundMessage } from './inbound';

export type Verdict = 'called' | 'expense' | 'photo' | 'skip';

export interface BotIdentity {
  /** Penny's Matrix user id, e.g. @agent-54ebea3a:matrix.netmind.chat */
  matrixId: string;
  /** Names she answers to: "Penny" and whatever this group renamed her to. */
  names: string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A whole message that answers a proposal: "OK", "好", "對", "OK #21", "全部 OK", "取消 #3", "改成 50",
// and the everyday forms of them: "好喔", "OK啦", "對啊", "收到" (a receiver confirming a repayment),
// "+1", or a 👍 typed as text.
const YES =
  '(?:ok|okay|yes|no|好|好的|好喔|好哦|好啊|好呀|對|對的|對啊|对|对的|对啊|沒錯|没错|沒問題|没问题|確認|确认|可以|可|收到了?|不要|先不要|算了|\\+1|👍|👌|✅|🆗)';
const ANSWER = new RegExp(
  `^\\s*(?:@\\S+\\s+)?(?:全部\\s*)?${YES}(?:\\s*(?:啦|喔|哦|呀|吧|囉|了))?(?:\\s*#\\d+)*\\s*(?:全部)?\\s*(?:👍|👌)?[!！。.~～]*\\s*$`,
  'i',
);
const CHANGE = /^\s*(?:取消|改成|改為|改为)\s*[^\n]{0,20}$/;
const ENTRY_REF = /#\d+/;

// A number, and a word for spending or moving money. Both must be there.
const AMOUNT = /(?:[£$€¥]|\b(?:gbp|usd|eur|jpy|twd|hkd|cny|rmb)\b)?\s*\d+(?:[.,]\d+)?\s*(?:元|塊|块|镑|鎊|英鎊|英镑|刀|pounds?|quid|bucks?|k)?/i;
// The same in Chinese numerals: 三百, 一千二, 兩百五, 五十塊, 十塊. A numeral needs a unit after it
// (十, 百, 千, 萬 or 元/塊), so 一起, 三個人 and 百貨 are not amounts.
const CN_DIGIT = '[一二三四五六七八九兩两]';
const CN_AMOUNT = new RegExp(
  `${CN_DIGIT}[十百千萬万]|十${CN_DIGIT}?\\s*(?:元|塊|块)|[一二三四五六七八九十兩两]\\s*(?:元|塊|块|镑|鎊|英鎊|英镑|刀)`,
);
const MONEY_WORDS =
  /付|花了|花費|花费|買了|买了|請客|请客|出了|我出|墊|垫|轉給|转给|轉了|转了|還給|还给|還了|还了|欠|分帳|分账|平分|AA|收據|收据|發票|发票|paid|spent|\bowe[sd]?\b|split|refund|venmo|transfer|[£$€¥]/i;

// Reactions that mean "yes" to one of Penny's proposals.
const APPROVE = new Set(['👍', '👌', '✅', '✔', '🆗']);

/** Emoji without the variation selector (U+FE0F) or skin tone that some clients add: 👍️ and 👍🏽 are 👍. */
const bareEmoji = (s: string) => s.replace(/[\uFE0F\u{1F3FB}-\u{1F3FF}]/gu, '');

export function classify(message: InboundMessage, bot: BotIdentity): Verdict {
  if (message.senderId === bot.matrixId) return 'skip';
  // A reaction counts only as an OK to one of Penny's own messages.
  if (message.kind === 'reaction') return message.replyToPenny !== undefined && APPROVE.has(bareEmoji(message.text).trim()) ? 'called' : 'skip';
  if (message.chatType === 'dm') return 'called';
  // Replying to Penny is talking to her, as Narra counts it for a mention.
  if (message.replyToPenny !== undefined) return 'called';

  const text = message.text;
  const mentioned =
    message.mentions.includes(bot.matrixId) ||
    text.includes(bot.matrixId) ||
    bot.names.some((name) => name && new RegExp(`@?${escape(name)}(?![\\p{L}\\p{N}])`, 'iu').test(text));
  if (mentioned) return 'called';

  // A photo may be a receipt. Only Penny can look at it, so pass it on.
  if (message.kind === 'image') return 'photo';

  const bare = bareEmoji(text);
  if (ANSWER.test(bare) || CHANGE.test(bare) || (ENTRY_REF.test(text) && text.length <= 20)) return 'called';

  const digits = (/\d/.test(text) && AMOUNT.test(text)) || CN_AMOUNT.test(text);
  if (digits && MONEY_WORDS.test(text)) return 'expense';

  return 'skip';
}
