// Drawing helpers shared by the cards: escaping, text measuring, money formatting, colours.

export const WIDTH = 360;
export const PAD = 16;
export const FONT = 'Noto Sans TC';

export const C = {
  ink: '#16202E',
  quiet: '#55606E',
  faint: '#8A94A3',
  rule: '#E3E7ED',
  ruleStrong: '#D5DBE3',
  paper: '#FFFFFF',
  receive: '#1D4A8F',
  receiveTint: '#E3ECFB',
  pay: '#8F3A12',
  payTint: '#FBE9DF',
  even: '#3D4B5F',
  evenTint: '#EEF1F5',
  navy: '#14213D',
  navyPanel: '#22335C',
  navyText: '#C5D0E0',
  bar: '#2A78D6',
  // Fixed category order, never cycled: a fifth category and beyond is folded into "其他".
  series: ['#2A78D6', '#EB6834', '#1BAF7A', '#EDA100'],
  other: '#8A94A3',
};

const SYMBOL = { GBP: '£', USD: '$', EUR: '€', JPY: '¥', TWD: 'NT$', HKD: 'HK$', CNY: '¥', KRW: '₩', AUD: 'A$', CAD: 'C$', SGD: 'S$' };

export const esc = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

/** Approximate rendered width: CJK and full-width characters take one em, Latin a bit over half. */
export function measure(text, size) {
  let em = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code > 0x2e80) em += 1;
    else if (/[A-Z0-9@#%&mwMW]/.test(ch)) em += 0.62;
    else if (/[ il.,:;'|!]/.test(ch)) em += 0.3;
    else em += 0.52;
  }
  return em * size;
}

/** Cut text to fit `max` pixels, ending in an ellipsis when it had to cut. */
export function fit(text, size, max) {
  const value = String(text ?? '');
  if (measure(value, size) <= max) return value;
  let out = '';
  for (const ch of value) {
    if (measure(`${out}${ch}…`, size) > max) break;
    out += ch;
  }
  return `${out}…`;
}

/**
 * A money formatter for one card. Decimals are shown only when some amount on the card needs
 * them, so a card reads either £120 / £32 or £12.50 / £3.20, never a mix.
 */
export function moneyFormat(currency, minorUnit, amounts) {
  const unit = 10 ** minorUnit;
  const decimals = amounts.some((a) => a % unit !== 0) ? minorUnit : 0;
  const symbol = SYMBOL[currency] ?? `${currency} `;
  const number = (minor) =>
    (Math.abs(minor) / unit).toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return {
    /** £1,234.50 */
    money: (minor) => `${minor < 0 ? '−' : ''}${symbol}${number(minor)}`,
    /** 1,234.50, for columns whose header already names the currency */
    plain: (minor) => `${minor < 0 ? '−' : ''}${number(minor)}`,
    symbol,
  };
}

/** One text element. `anchor` is start, middle or end. */
export function t(x, y, text, { size = 13, weight = 400, fill = C.ink, anchor = 'start', tabular = false } = {}) {
  const features = tabular ? ' font-feature-settings="tnum"' : '';
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${features}>${esc(text)}</text>`;
}

export function rect(x, y, w, h, fill, r = 0, extra = '') {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" ${extra}/>`;
}

export function line(x1, y1, x2, y2, stroke = C.rule, width = 1) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${width}"/>`;
}

/** Wrap card content in an SVG document of the card width. */
export function svg(height, body, background = C.paper, font = FONT) {
  const h = Math.ceil(height);
  // The fallback family covers Latin text and any glyph the chosen subset lacks.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${h}" viewBox="0 0 ${WIDTH} ${h}" font-family="${font}, ${FONT}">${rect(0, 0, WIDTH, h, background)}${body}</svg>`;
}

/** Title on the left, a quiet note on the right. Returns [markup, next y]. */
export function header(title, note, y = 28, colors = { title: C.ink, note: C.quiet }) {
  const noteWidth = note ? Math.min(measure(note, 12), 150) : 0;
  return [
    t(PAD, y, fit(title, 15, WIDTH - PAD * 2 - noteWidth - 12), { size: 15, weight: 700, fill: colors.title }) +
      (note ? t(WIDTH - PAD, y, fit(note, 12, 150), { size: 12, fill: colors.note, anchor: 'end' }) : ''),
    y + 18,
  ];
}

export const initial = (name) => [...String(name).trim()][0]?.toUpperCase() ?? '?';
