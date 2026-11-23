import { allocate, MAX_AMOUNT } from '../ledger/money';
import { detectLang, type DetectedLang } from './lang';
import type { InboundMessage } from './inbound';

const CALCULATE_ONLY = /(?:只|就)算(?:一下)?(?:就好|就行)?|算一下就好|(?:先)?(?:不用|不要|別|别|不必)(?:入|記|记)[帳账]|\b(?:just calculate|(?:do not|don't) (?:record|log|save))\b/i;
const EQUAL_SPLIT = /均分|平分|平均分|\bsplit\b.{0,40}\bequally\b/i;
const GROUP_SIZE = /(?<![\d零一二兩两三四五六七八九十百千])([1-9]\d?|[二兩两三四五六七八九十])\s*(?:[個个位]?人|people\b)/i;
const CHINESE_COUNTS = '一二三四五六七八九十';
const ENGLISH_COUNTS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

export function isReadOnlySplit(message: InboundMessage): boolean {
  return message.kind === undefined && CALCULATE_ONLY.test(message.text) && EQUAL_SPLIT.test(message.text);
}

function equalSplitReply(amount: string, count: string, lang: DetectedLang): string {
  if (lang === 'en') return `${amount} each for ${count} people. Nothing was recorded.`;
  return lang === 'zh-Hans' ? `${count} 人均分，每人 ${amount}。这笔没记账。`
    : `${count} 人均分，每人 ${amount}。這筆沒記帳。`;
}

export function restateSplitPreview(message: InboundMessage): string | null {
  const prior = message.restatePenny;
  if (!prior) return null;
  const lang = message.detectedLang ?? detectLang(message.text);
  const en = /^([£€$]\d+(?:\.\d{2})?) each for (\d+) people\. Nothing was recorded\.$/.exec(prior);
  if (en) return equalSplitReply(en[1]!, en[2]!, lang);
  const zh = /^(\d+) 人均分，每人 ([£€$]\d+(?:\.\d{2})?)。[這这][筆笔][沒没][記记][帳账]。$/.exec(prior);
  return zh ? equalSplitReply(zh[2]!, zh[1]!, lang) : null;
}

export function splitPreview(message: InboundMessage): string | null {
  if (!isReadOnlySplit(message)) return null;
  const text = message.text.normalize('NFKC');
  const lang = message.detectedLang ?? detectLang(text);
  const clarification = lang === 'en' ? 'What’s the total, currency, and number of people? I’ll just calculate it.'
    : lang === 'zh-Hans' ? '总金额、币别和人数是多少？我只帮你算。'
      : '總金額、幣別和人數是多少？我只幫你算。';

  const amounts = [...text.matchAll(/([£€$])\s*(\d+(?:,\d{3})*)(?:\.(\d{1,2}))?(?![\d.]|,\d)/g)];
  const groups = [
    ...text.matchAll(new RegExp(GROUP_SIZE.source, 'gi')),
    ...text.matchAll(/(?<![A-Za-z-])(?<!\b(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)(?:\s+and)?\s+)(one|two|three|four|five|six|seven|eight|nine|ten)\s+people\b/gi),
  ];
  const amount = amounts[0];
  const group = groups[0];
  if (amounts.length !== 1 || groups.length !== 1 || !amount || !group) return clarification;

  const [, symbol, whole, fraction = ''] = amount;
  const countWord = group[1]!;
  const count = Number(countWord) || (/[兩两]/.test(countWord) ? 2 : CHINESE_COUNTS.indexOf(countWord) + 1) || ENGLISH_COUNTS.indexOf(countWord.toLowerCase()) + 1;
  const total = Number(whole!.replaceAll(',', '')) * 100 + Number(fraction.padEnd(2, '0'));
  if (count < 2 || !Number.isSafeInteger(total) || total <= 0 || total > MAX_AMOUNT) return clarification;

  const shares = Object.values(allocate(total, Array.from({ length: count }, (_, i) => [String(i), 1])));
  const high = shares[0]!;
  const low = shares[count - 1]!;
  const money = (minor: number) => `${symbol}${(minor / 100).toFixed(2).replace(/\.00$/, '')}`;
  if (high === low) return equalSplitReply(money(high), String(count), lang);

  const highCount = shares.filter((share) => share === high).length;
  const lowCount = count - highCount;
  if (lang === 'en') return `${highCount} pay ${money(high)} and ${lowCount} pay ${money(low)}. Nothing was recorded.`;
  return lang === 'zh-Hans' ? `${highCount} 人各付 ${money(high)}，${lowCount} 人各付 ${money(low)}。这笔没记账。`
    : `${highCount} 人各付 ${money(high)}，${lowCount} 人各付 ${money(low)}。這筆沒記帳。`;
}
