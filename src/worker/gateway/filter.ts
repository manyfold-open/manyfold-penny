/**
 * Decides, from the text alone, whether a group message is worth a Penny turn.
 *
 * Every message the gateway skips costs nothing: no agent call, no session growth. It is
 * still in the room's history, which Penny reads when someone asks her to catch up.
 * The rules mirror step 0 of agent/PENNY.md, so Penny and the gateway agree.
 */

import type { InboundMessage } from './inbound';
import { splitPreview } from './split-preview';

/** 'question': a question to the group about money owed, without @Penny. 'nudge': no one wrote
 *  it; the gateway asks Penny to speak up on her own (see poller.ts). */
export type Verdict = 'called' | 'expense' | 'photo' | 'question' | 'nudge' | 'skip';
/** What classify returns: a Verdict, or 'answer' for a bare "好"/"OK"/"#21" that names nobody.
 *  People say those to each other all day, so the poller passes one on (as 'called') only
 *  while the group has a proposal waiting for an OK. */
export type Classified = Verdict | 'answer';

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
const SPEND_ACTION_WORDS =
  /付|花了|花費|花费|買了|买了|刷了|請客|请客|出了|我出|墊|垫|轉給|转给|轉了|转了|還給|还给|還了|还了|欠|分帳|分账|平分|AA|算一份|收據|收据|發票|发票|paid|spent|bought|charged|\bowe[sd]?\b|split|refund|venmo|transfer/i;
const CURRENCY_SYMBOL = /[£$€¥]/;
const PRICE_COMMENTARY =
  /誰買得下手|谁买得下手|買不下手|买不下手|買不起|买不起|太貴|太贵|超貴|超贵|好貴|好贵|真貴|真贵|貴死|贵死|不買|不买|不想買|不想买|才不買|才不买|賣超貴|卖超贵|賣這麼貴|卖这么贵|要賣|要卖|要價|要价|定價|定价|原價|原价|標價|标价|售價|售价|房租|月租|年薪|月薪|起薪|預算|预算|折扣|優惠碼|优惠码|特價|特价|促銷|促销|加碼折|\b(?:too\s+expensive|way\s+too\s+much|so\s+expensive|overpriced|pricey|can'?t\s+afford|wouldn'?t\s+buy|not\s+buying|who\s+(?:would|buys?)|costs?\s+(?:like\s+)?[£$€¥]|retails?\s+(?:for|at)|starting\s+at|per\s+month|\/month|a\s+month|rent\s+is|salary|budget|discount|voucher|promo\s*code)\b/i;

// A question to the group about who owes what, which Penny can answer from the ledger:
// "誰欠誰", "我還欠你多少", "我要轉給誰", "這趟總共花多少", "錢怎麼分", "要結算了嗎", "who owes who".
// Each needs a question word next to the money word, so "我欠你一頓飯" and "結算完了" pass by.
const QUESTION = [
  /誰欠誰|谁欠谁/,
  /欠.{0,12}(?:多少|幾塊|几块|幾錢|几钱)/,
  /(?:要|該|该|應該|应该|得)(?:轉|转|付|給|给|還|还)(?:給|给)?.{0,8}(?:多少|誰|谁)/,
  /(?:總共|总共|一共|這趟|这趟|這次|这次).{0,8}(?:花|用)了?(?:多少|幾|几)/,
  /(?:怎麼|怎么)(?:分|算)(?:錢|钱|帳|账)|(?:錢|钱|帳|账)(?:怎麼|怎么)(?:分|算)/,
  /(?:結算|结算|算帳|算账)(?:一下)?(?:吧|嗎|吗|了嗎|了吗|呢)|(?:要|可以)(?:結算|结算|算帳|算账)(?:了)?(?:嗎|吗|\?|？)/,
  /\bwho owes\b|\bhow much (?:do|does|did|should) \w+ (?:owe|pay|transfer|send)\b|\bsettle up\?|\bwhat do (?:i|we) owe\b/i,
];

// Reactions that mean "yes" to one of Penny's proposals.
const APPROVE = new Set(['👍', '👌', '✅', '✔', '🆗']);

/** Emoji without the variation selector (U+FE0F) or skin tone that some clients add: 👍️ and 👍🏽 are 👍. */
const bareEmoji = (s: string) => s.replace(/[\uFE0F\u{1F3FB}-\u{1F3FF}]/gu, '');

/** Narra gives every agent a Matrix id of the form @agent-<hex>:<server>. People get @sp-…. */
export const isNarraAgent = (matrixId: string) => /^@agent-[0-9a-f]+:/i.test(matrixId);

export function classify(message: InboundMessage, bot: BotIdentity): Classified {
  if (message.senderId === bot.matrixId) return 'skip';
  // Another Narra agent. Groups hold several, and they answer each other's messages ("好的。"
  // to Penny's note). Narra refuses an agent's reply to an agent, and nothing they say is a
  // ledger entry, so Penny never answers them.
  if (isNarraAgent(message.senderId)) return 'skip';
  // A reaction counts only as an OK to one of Penny's own messages.
  if (message.kind === 'reaction') return message.replyToPenny !== undefined && APPROVE.has(bareEmoji(message.text).trim()) ? 'called' : 'skip';
  if (message.chatType === 'dm') return 'called';
  // Replying to Penny is talking to her, as Narra counts it for a mention.
  if (message.replyToPenny !== undefined) return 'called';

  const text = message.text;
  const trimmed = text.trimStart();
  const mentionsOthers = message.mentions.some((id) => id !== bot.matrixId);
  const startsWithBot =
    trimmed.startsWith(bot.matrixId) ||
    bot.names.some((name) => name && new RegExp(`^@${escape(name)}(?![\\p{L}\\p{N}])`, 'iu').test(trimmed));
  const aimedElsewhere = mentionsOthers && trimmed.startsWith('@') && !startsWithBot;
  const mentioned =
    message.mentions.includes(bot.matrixId) ||
    text.includes(bot.matrixId) ||
    bot.names.some(
      (name) =>
        name &&
        new RegExp(`${aimedElsewhere ? '@' : '@?'}${escape(name)}(?![\\p{L}\\p{N}])`, 'iu').test(text),
    );
  if (mentioned) return 'called';

  // A photo may be a receipt. Only Penny can look at it, so pass it on.
  if (message.kind === 'image') return 'photo';

  const bare = bareEmoji(text);
  if (ANSWER.test(bare) || CHANGE.test(bare) || (ENTRY_REF.test(text) && text.length <= 20)) return 'answer';

  if (splitPreview(message) !== null || QUESTION.some((q) => q.test(text))) {
    return aimedElsewhere || message.replyTo !== undefined ? 'skip' : 'question';
  }

  const digits = (/\d/.test(text) && AMOUNT.test(text)) || CN_AMOUNT.test(text);
  if (digits) {
    if (SPEND_ACTION_WORDS.test(text)) return 'expense';
    if (CURRENCY_SYMBOL.test(text) && !PRICE_COMMENTARY.test(text) && text.trim().length <= 24) return 'expense';
  }

  return 'skip';
}
