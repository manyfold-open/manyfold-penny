// Every word on a card, in Traditional Chinese, Simplified Chinese and English.
// Cards pick a language with `lang`; anything else falls back to Traditional Chinese.

export const LANGS = ['zh-Hant', 'zh-Hans', 'en'];

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const zhHant = {
  font: 'Noto Sans TC',
  list: '、',
  colon: '：',
  weekdays: ['日', '一', '二', '三', '四', '五', '六'],
  date: (m, d) => `${m}/${d}`,
  categories: {
    food: '餐飲', drinks: '酒水飲料', groceries: '雜貨', transport: '交通', accommodation: '住宿',
    tickets: '門票', entertainment: '娛樂', shopping: '購物', utilities: '水電', rent: '房租', other: '其他', settlement: '還款',
  },
  // people
  peopleTitle: '每個人的狀況',
  receive: '↓ 要收回',
  pay: '↑ 要付出',
  even: '已結清',
  nothingToSend: '沒有要轉的錢',
  payTo: (list) => `給 ${list}`,
  allSettled: '大家都結清了',
  transfersToSettle: (n) => `照這樣轉 ${n} 筆就結清`,
  altOwes: (from, to, amount) => `${from} 給 ${to} ${amount}`,
  altWhoOwes: '誰欠誰',
  // receipt
  receiptTitle: (what) => `${what}：誰吃了什麼`,
  paidBy: (who) => `${who} 付`,
  receivedBy: (who) => `${who} 收`,
  total: '合計',
  amountIn: (symbol) => `金額 ${symbol}`,
  item: (n) => `品項 ${n}`,
  extra: '服務費、稅（按比例）',
  each: '每人',
  dotLegend: '實心圓：有分到這一項',
  altReceipt: (what, total, list) => `${what}，共 ${total}：${list}`,
  // poster
  posterCounts: (people, days, count) => `${people} 個人 · ${days} 天 · ${count} 筆`,
  topPayer: '最常掏錢的人',
  paidTimes: (n) => `付了 ${n} 筆`,
  largest: '最大的一筆',
  topCategory: '最常記的分類',
  times: (n) => `${n} 筆`,
  openTransfers: (n, bot) => `還有 ${n} 筆轉帳沒結清，@${bot} 誰欠誰 看方案`,
  altPoster: (group, total, count, open) => `${group}：總共 ${total}，${count} 筆${open ? `，還有 ${open} 筆轉帳沒結清` : ''}`,
  // categories
  categoriesTitle: '錢花在哪',
  sum: '總共',
  unit: (symbol) => `單位 ${symbol}`,
  others: '其他',
  // daily
  dailyTitle: '每天花多少',
  peakDay: (day, amount) => `${day} 最高，${amount}`,
  lastDaysOnly: (n) => `（只顯示最近 ${n} 天）`,
  // expenses
  expensesTitle: '支出明細',
  earlier: '還有更早的',
  noExpenses: '還沒有記任何支出',
  edited: '已修改',
  refund: '退款',
  pageTotal: (n) => `這 ${n} 筆合計`,
};

const zhHans = {
  ...zhHant,
  font: 'Noto Sans SC',
  categories: {
    food: '餐饮', drinks: '酒水饮料', groceries: '杂货', transport: '交通', accommodation: '住宿',
    tickets: '门票', entertainment: '娱乐', shopping: '购物', utilities: '水电', rent: '房租', other: '其他', settlement: '还款',
  },
  peopleTitle: '每个人的状况',
  receive: '↓ 要收回',
  pay: '↑ 要付出',
  even: '已结清',
  nothingToSend: '没有要转的钱',
  payTo: (list) => `给 ${list}`,
  allSettled: '大家都结清了',
  transfersToSettle: (n) => `照这样转 ${n} 笔就结清`,
  altOwes: (from, to, amount) => `${from} 给 ${to} ${amount}`,
  altWhoOwes: '谁欠谁',
  receiptTitle: (what) => `${what}：谁吃了什么`,
  total: '合计',
  amountIn: (symbol) => `金额 ${symbol}`,
  item: (n) => `品项 ${n}`,
  extra: '服务费、税（按比例）',
  each: '每人',
  dotLegend: '实心圆：有分到这一项',
  altReceipt: (what, total, list) => `${what}，共 ${total}：${list}`,
  posterCounts: (people, days, count) => `${people} 个人 · ${days} 天 · ${count} 笔`,
  topPayer: '最常掏钱的人',
  paidTimes: (n) => `付了 ${n} 笔`,
  largest: '最大的一笔',
  topCategory: '最常记的分类',
  times: (n) => `${n} 笔`,
  openTransfers: (n, bot) => `还有 ${n} 笔转账没结清，@${bot} 谁欠谁 看方案`,
  altPoster: (group, total, count, open) => `${group}：总共 ${total}，${count} 笔${open ? `，还有 ${open} 笔转账没结清` : ''}`,
  categoriesTitle: '钱花在哪',
  sum: '总共',
  unit: (symbol) => `单位 ${symbol}`,
  dailyTitle: '每天花多少',
  lastDaysOnly: (n) => `（只显示最近 ${n} 天）`,
  expensesTitle: '支出明细',
  earlier: '还有更早的',
  noExpenses: '还没有记任何支出',
  edited: '已修改',
  refund: '退款',
  pageTotal: (n) => `这 ${n} 笔合计`,
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const en = {
  font: 'Noto Sans TC',
  list: ', ',
  colon: ': ',
  weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  date: (m, d) => `${d} ${MONTHS[m - 1]}`,
  categories: {
    food: 'Food', drinks: 'Drinks', groceries: 'Groceries', transport: 'Transport', accommodation: 'Stay',
    tickets: 'Tickets', entertainment: 'Fun', shopping: 'Shopping', utilities: 'Utilities', rent: 'Rent', other: 'Other', settlement: 'Repayment',
  },
  peopleTitle: 'Where everyone stands',
  receive: '↓ Gets back',
  pay: '↑ Owes',
  even: 'Settled',
  nothingToSend: 'Nothing to send',
  payTo: (list) => `To ${list}`,
  allSettled: 'Everyone is settled',
  transfersToSettle: (n) => `${plural(n, 'transfer', 'transfers')} settle everyone`,
  altOwes: (from, to, amount) => `${from} pays ${to} ${amount}`,
  altWhoOwes: 'Who owes whom',
  receiptTitle: (what) => `${what}: who had what`,
  paidBy: (who) => `${who} paid`,
  receivedBy: (who) => `${who} received`,
  total: 'Total',
  amountIn: (symbol) => `Amount ${symbol}`,
  item: (n) => `Item ${n}`,
  extra: 'Service and tax (pro rata)',
  each: 'Each',
  dotLegend: 'Filled dot: had a share of it',
  altReceipt: (what, total, list) => `${what}, ${total} in all: ${list}`,
  posterCounts: (people, days, count) =>
    `${plural(people, 'person', 'people')} · ${plural(days, 'day', 'days')} · ${plural(count, 'expense', 'expenses')}`,
  topPayer: 'Paid most often',
  paidTimes: (n) => `${n}×`,
  largest: 'Biggest expense',
  topCategory: 'Most common',
  times: (n) => plural(n, 'expense', 'expenses'),
  openTransfers: (n, bot) => `${plural(n, 'transfer', 'transfers')} to go. Ask @${bot} "who owes whom"`,
  altPoster: (group, total, count, open) =>
    `${group}: ${total} in all, ${plural(count, 'expense', 'expenses')}${open ? `, ${plural(open, 'transfer', 'transfers')} to go` : ''}`,
  categoriesTitle: 'Where the money went',
  sum: 'Total',
  unit: (symbol) => `Amounts in ${symbol}`,
  others: 'Other',
  dailyTitle: 'Spending by day',
  peakDay: (day, amount) => `Highest on ${day}: ${amount}`,
  lastDaysOnly: (n) => ` (last ${n} days)`,
  expensesTitle: 'Recent expenses',
  earlier: 'more before',
  noExpenses: 'Nothing recorded yet',
  edited: 'edited',
  refund: 'refund',
  pageTotal: (n) => `These ${n} total`,
};

const TABLE = { 'zh-Hant': zhHant, 'zh-Hans': zhHans, en };

export function strings(lang) {
  return TABLE[lang] ?? zhHant;
}

/** Map loose language names to one of LANGS. */
export function normalizeLang(value) {
  const v = String(value ?? '').toLowerCase();
  if (['en', 'en-gb', 'en-us', 'english'].includes(v)) return 'en';
  if (['zh-hans', 'zh-cn', 'zh-sg', 'sc', 'simplified'].includes(v)) return 'zh-Hans';
  return 'zh-Hant';
}
