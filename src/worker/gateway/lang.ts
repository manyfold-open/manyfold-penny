/**
 * Per-speaker trilingual language detection for Penny's gateway:
 * Traditional Chinese ('zh-Hant'), Simplified Chinese ('zh-Hans'), and English ('en').
 *
 * Strips @mentions, URLs, numbers/amounts, filenames, and pure ASCII brand or short
 * confirmation tokens ("ok", "boots") before classifying so neutral messages inherit
 * the speaker's recent language or the room's dominant language.
 */

export type DetectedLang = 'zh-Hant' | 'zh-Hans' | 'en';

// High-frequency Simplified-only characters (never standard Traditional).
const HANS_ONLY = new Set(
  '这们么吗没为会来对说话请谢问记账帐钱块还转给买卖费结单据发认确关开车东电点时间现应该让帮带张页过进达运远边头门专业两个举义乌乐习书乡乱争亏亚产亲仅从仓仪价众优伟传伤伦伪体侦侧侨俩俭债倾偿储儿兑党兰兴养兽军农决况冻净减凑击划刘刚创剑剧办劝务动劳势勋励区医华协卫厂厅历压厌厕厢厦厨县参双变叙叠号叹吓听启吴员响哑图团园国围圆圣场坏坚坛坝坠垒垦垫报执扩扫扬扰抚护拥拦拧拨择换损摇摊摄摆敌数斋断无旧显晒晓晕暂术机杀杂权条杨极构标栈栋栏树样桥检楼档欢欧残毁毕气汇汉汤沟泽洁测济浓涂涨涛润湾满滤滥滨灯灵灾灿炉点炼烂热烧营爱爷牵牺状独狭狮狱猎献环琐画畅疯盘监盖盗矿码砖硕礼离种积称稳穷竞笔筑简粮紧红约级纪纯纸纷线练组细织终经绝统继绩绪续维综绿缩网罗罚罢联聪肠肤胜胶脑脸腾舰节艺范药萧萨蓝虽虾蜡蝇补装裤见观规视览觉触订计讨议讯讲许论设访证评识诉词译试诗诚诞询详语误诸诺读课谁调谈谋谨负财责贤败货质贪贫购贴贵贷贸贺资赔赏赐赛赞赢轮软轻载较辅辆辈辉输辞迁违连迟适选递遗邮邻释针钉钟钢钻铁铃银锁锅错锡锦键镇镜长闪闭闲闷闹闻阁阅队阳阴阵阶际陆陈险随隐难项顺须顾顿预领频颗题额风飞饭饮饰饱饼馆马驰驱驳驻驾验骑骗骚惊鱼鲁鲜鸡鸭鹅麦齐齿龙龟'
    .split(''),
);

// Matching Traditional-only characters (never standard Simplified).
const HANT_ONLY = new Set(
  '這們麼嗎沒為會來對說話請謝問記帳賬錢塊還轉給買賣費結單據發認確關開車東電點時間現應該讓幫帶張頁裡裏過進達運遠邊頭門專業兩個豐臨舉義烏樂習書鄉亂爭虧亞產親僅從倉儀價眾優偉傳傷倫偽體偵側僑倆儉債傾償儲兒兌黨蘭興養獸軍農決況凍淨減湊擊劃劉剛創劍劇辦勸務動勞勢勳勵區醫華協衛廠廳歷壓厭廁廂廈廚縣參雙變敘疊號嘆嚇聽啟吳員響啞圖團園國圍圓聖場壞堅壇壩墜壘墾墊報執擴掃揚擾撫護擁攔擰撥擇換損搖攤攝擺敵數齋斷無舊顯曬曉暈暫術機殺雜權條楊極構標棧棟欄樹樣橋檢樓檔歡歐殘毀畢氣匯漢湯溝澤潔測濟濃塗漲濤潤灣滿濾濫濱燈靈災燦爐點煉爛熱燒營愛爺牽犧狀獨狹獅獄獵獻環瑣畫暢瘋盤監蓋盜礦碼磚碩禮離種積稱穩窮競筆築簡糧緊紅約級紀純紙紛線練組細織終經絕統繼績緒續維綜綠縮網羅罰罷聯聰腸膚勝膠腦臉騰緻艦節藝範藥蕭薩藍雖蝦蠟蠅補裝褲見觀規視覽覺觸訂計討議訊講許論設訪證評識訴詞譯試詩誠誕詢詳語誤諸諾讀課誰調談謀謹負財責賢敗貨質貪貧購貼貴貸貿賀資賠賞賜賽讚贏輪軟輕載較輔輛輩輝輸辭遷違連遲適選遞遺郵鄰採釋針釘鐘鍾鋼鑽鐵鈴銀鎖鍋錯錫錦鍵鎮鏡長閃閉閑悶鬧聞閣閱隊陽陰陣階際陸陳險隨隱難項順須鬚顧頓預領頻顆題額風飛飯飲飾飽餅館馬馳驅駁駐駕驗騎騙騷驚魚魯鮮雞鴨鵝麥齊齒龍龜'
    .split(''),
);

// Pure ASCII short confirmation / filler / currency / brand tokens that should not force 'en'.
const NEUTRAL_ASCII = new Set([
  'ok',
  'okay',
  'yes',
  'no',
  'yup',
  'yep',
  'nope',
  'kk',
  'k',
  'aa',
  'thx',
  'ty',
  'lol',
  'lmao',
  'haha',
  'hahaha',
  'hehe',
  'hmm',
  'umm',
  'wow',
  'xd',
  'omg',
  'btw',
  'fyi',
  'tbd',
  'na',
  'pm',
  'am',
  // Currencies
  'gbp',
  'usd',
  'eur',
  'jpy',
  'twd',
  'hkd',
  'cny',
  'rmb',
  'krw',
  'aud',
  'cad',
  'sgd',
  'myr',
  'thb',
  // Common brands / venues / apps
  'boots',
  'pret',
  'uber',
  'tesco',
  'sainsbury',
  'sainsburys',
  'waitrose',
  'lidl',
  'aldi',
  'asda',
  'morrisons',
  'coop',
  'ocado',
  'costco',
  'starbucks',
  'costa',
  'dishoom',
  'nando',
  'nandos',
  'uniqlo',
  'zara',
  'ikea',
  'primark',
  'harrods',
  'selfridges',
  'deliveroo',
  'grab',
  'bolt',
  'lyft',
  'monzo',
  'revolut',
  'venmo',
  'paypal',
  'apple',
  'amazon',
  'subway',
  'kfc',
  'mcdonald',
  'mcdonalds',
  'airbnb',
  'carrefour',
  'muji',
  'watsons',
  'cosmed',
  'familymart',
  'hilton',
  'marriott',
  'hyatt',
  'ryanair',
  'easyjet',
  'eurostar',
  'tfl',
  'oyster',
  'line',
  'payme',
  'octopus',
  'suica',
  'pasmo',
  'netflix',
  'spotify',
  'google',
  'whatsapp',
  'telegram',
  'matrix',
  'narra',
  'penny',
  'pennyworth',
]);

const CJK_RE = /[\u3400-\u9fff]/g;

/** Strip mentions, URLs, filenames, numbers, and neutral ASCII tokens before classification. */
function stripNoise(text: string): string {
  return text
    // Markdown Matrix mentions: [@Name](@user:server)
    .replace(/\[@[^\]\n]+\]\(@[^\s)]+\)/g, ' ')
    // Full Matrix user IDs: @user:server
    .replace(/(?<![a-zA-Z0-9._%+-])@[A-Za-z0-9._=\-/+]+:[A-Za-z0-9.-]+(?::\d{1,5})?/g, ' ')
    // @mentions (ASCII handles or non-whitespace mention tokens followed by space/end)
    .replace(/(?<![a-zA-Z0-9._%+-])@[A-Za-z0-9_.-]+/g, ' ')
    .replace(/(?<![a-zA-Z0-9._%+-])@\S+(?=\s|$)/g, ' ')
    // URLs
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    // Image/document filenames (e.g. IMG_1234.jpg)
    .replace(/\b\S+\.(?:jpe?g|png|gif|webp|heic|pdf|mp4|mov)\b/gi, ' ')
    // Entry references and numbers/amounts
    .replace(/#\d+/g, ' ')
    .replace(/[£$€¥₩]|\d+(?:[.,]\d+)?/g, ' ')
    // Neutral ASCII brand / confirmation tokens (also possessive like Sainsbury's)
    .replace(/\b([a-zA-Z]+)(?:'s)?\b/g, (whole, word: string) => (NEUTRAL_ASCII.has(word.toLowerCase()) ? ' ' : whole))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Inspect the message itself for an explicit language signal.
 * Returns 'zh' when CJK characters are present without distinctive Simplified/Traditional forms,
 * or null when the message carries no language signal (e.g. "OK", "Boots 15", "👍").
 */
export function detectExplicitLang(text: string): DetectedLang | 'zh' | null {
  const cleaned = stripNoise(text);
  if (!cleaned) return null;

  const cjk = cleaned.match(CJK_RE) ?? [];
  const enWords = cleaned.match(/\b[a-zA-Z]{2,}\b/g) ?? [];

  if (cjk.length > 0) {
    // Only treat mixed text as English when substantive English clearly dominates.
    if (enWords.length >= 3 && enWords.length * 2 > cjk.length) return 'en';
    let hans = 0;
    let hant = 0;
    for (const ch of cjk) {
      if (HANS_ONLY.has(ch)) hans++;
      else if (HANT_ONLY.has(ch)) hant++;
    }
    if (hans > hant) return 'zh-Hans';
    if (hant > hans) return 'zh-Hant';
    return 'zh';
  }

  if (enWords.length > 0) return 'en';
  return null;
}

/** An explicit response-language request at the end of this turn. */
export function requestedReplyLanguage(text: string): DetectedLang | undefined {
  const request = /(?:請|请|能不能|可以)?\s*(?:用|以)\s*(英文|英語|英语|簡體(?:中文)?|简体(?:中文)?|繁體(?:中文)?|繁体(?:中文)?)\s*(?:回答|回覆|回复|重[說说])\s*[。.!！?？]*\s*$/.exec(text)?.[1];
  if (!request) return undefined;
  if (request.startsWith('英')) return 'en';
  return /^[簡简]/.test(request) ? 'zh-Hans' : 'zh-Hant';
}

/**
 * Classify a message as 'zh-Hant', 'zh-Hans', or 'en', using the speaker's history and the
 * room's dominant language as fallbacks for ambiguous or stripped messages.
 */
export function detectLang(
  text: string,
  userHistoryLang?: DetectedLang,
  roomHistoryLang?: DetectedLang,
): DetectedLang {
  const requested = requestedReplyLanguage(text);
  if (requested) return requested;
  const explicit = detectExplicitLang(text);
  if (explicit === 'en' || explicit === 'zh-Hans' || explicit === 'zh-Hant') return explicit;
  if (explicit === 'zh') {
    if (userHistoryLang === 'zh-Hant' || userHistoryLang === 'zh-Hans') return userHistoryLang;
    if (roomHistoryLang === 'zh-Hant' || roomHistoryLang === 'zh-Hans') return roomHistoryLang;
    return 'zh-Hant';
  }
  return userHistoryLang ?? roomHistoryLang ?? 'zh-Hant';
}

/** Pick the dominant language from a recent room window, preferring the current dominant on ties. */
export function dominantLang(recent: DetectedLang[], current?: DetectedLang): DetectedLang {
  if (recent.length === 0) return current ?? 'zh-Hant';
  const counts: Record<DetectedLang, number> = { 'zh-Hant': 0, 'zh-Hans': 0, en: 0 };
  for (const lang of recent) counts[lang]++;
  let best: DetectedLang = current && counts[current] > 0 ? current : recent[recent.length - 1];
  for (const lang of ['zh-Hant', 'zh-Hans', 'en'] as const) {
    if (counts[lang] > counts[best]) best = lang;
  }
  return best;
}
