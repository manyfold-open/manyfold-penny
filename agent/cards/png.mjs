// SVG to PNG with resvg and Noto Sans TC / SC. Downloads the fonts on first use.

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fonts');
const FONTS = {
  'NotoSansTC-Regular.otf': 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/SubsetOTF/TC/NotoSansTC-Regular.otf',
  'NotoSansTC-Bold.otf': 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/SubsetOTF/TC/NotoSansTC-Bold.otf',
  // Simplified Chinese has characters the Traditional subset does not.
  'NotoSansSC-Regular.otf': 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf',
  'NotoSansSC-Bold.otf': 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/SubsetOTF/SC/NotoSansSC-Bold.otf',
};

/** Make sure the fonts are on disk, fetching any that are missing. */
export async function ensureFonts() {
  mkdirSync(FONT_DIR, { recursive: true });
  const files = [];
  for (const [name, url] of Object.entries(FONTS)) {
    const file = join(FONT_DIR, name);
    if (!existsSync(file)) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not download ${name}: HTTP ${response.status}`);
      const partial = `${file}.part`;
      writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
      renameSync(partial, file);
    }
    files.push(file);
  }
  return files;
}

/** Render at twice the card's size so text stays sharp on phones. */
export async function toPng(svg, scale = 2) {
  const fontFiles = await ensureFonts();
  const width = Number(/width="(\d+)"/.exec(svg)[1]) * scale;
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Noto Sans TC' },
  });
  const image = resvg.render();
  return { png: image.asPng(), width: image.width, height: image.height };
}
