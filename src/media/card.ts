import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import type { ReportSummary } from '../report.js';

/**
 * A branded, screenshot-perfect verdict card — the growth engine. Deliberately
 * ANONYMIZED (no name, no photo): sharing it sells Checkmate, never publishes a
 * claim about a named person. Fonts are BUNDLED (the Render host has no Arial and
 * no emoji font), and we draw icons as shapes rather than relying on emoji glyphs.
 */
const FONT = fileURLToPath(new URL('../../assets/DejaVuSans.ttf', import.meta.url));
const FONT_BOLD = fileURLToPath(new URL('../../assets/DejaVuSans-Bold.ttf', import.meta.url));

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** Trim a label so it never overruns the panel width. */
function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function renderCardPng(summary: ReportSummary): Buffer {
  const { verdict, score, red, green, redLabels, greenLabels } = summary;
  const accent = score >= 75 ? '#38d39f' : score >= 45 ? '#f5c451' : '#ff5c7a';

  // Auto-fit the verdict so long strings never clip.
  const vSize = verdict.length > 20 ? 48 : verdict.length > 14 ? 56 : 64;

  const filled = Math.max(0, Math.min(10, Math.round(score / 10)));
  const barW = 60;
  const gap = 10;
  const barsX = (760 - (barW * 10 + gap * 9)) / 2 + 20;
  const bars = Array.from({ length: 10 }, (_, i) => {
    const x = barsX + i * (barW + gap);
    return `<rect x="${x}" y="452" width="${barW}" height="38" rx="6" fill="${i < filled ? accent : '#2b2f3a'}"/>`;
  }).join('');

  // Top flag rows (the viral hook — the actual reasons, not just a count).
  const rows = (labels: string[], color: string, x: number): string =>
    labels
      .slice(0, 3)
      .map((l, i) => `<text x="${x}" y="${712 + i * 46}" font-family="DejaVu Sans" font-size="26" fill="${color}">•  ${esc(clip(l, 26))}</text>`)
      .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000" viewBox="0 0 800 1000">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#161922"/><stop offset="1" stop-color="#0e1017"/>
    </linearGradient></defs>
    <rect width="800" height="1000" fill="url(#bg)"/>
    <rect x="24" y="24" width="752" height="952" rx="28" fill="none" stroke="#232735" stroke-width="2"/>

    <text x="400" y="132" text-anchor="middle" font-family="DejaVu Sans" font-weight="bold" font-size="60" fill="#ffffff">CHECKMATE</text>
    <text x="400" y="180" text-anchor="middle" font-family="DejaVu Sans" font-size="25" fill="#8b90a0">dating-safety report</text>

    <text x="400" y="340" text-anchor="middle" font-family="DejaVu Sans" font-weight="bold" font-size="${vSize}" fill="${accent}">${esc(verdict)}</text>
    <text x="400" y="420" text-anchor="middle" font-family="DejaVu Sans" font-size="30" fill="#c9cdd8">Vibe check: ${score}/100</text>
    ${bars}

    <rect x="70" y="560" width="310" height="330" rx="20" fill="#1c2029"/>
    <text x="225" y="632" text-anchor="middle" font-family="DejaVu Sans" font-weight="bold" font-size="72" fill="#ff5c7a">${red}</text>
    <text x="225" y="676" text-anchor="middle" font-family="DejaVu Sans" font-size="26" fill="#c9cdd8">RED FLAGS</text>
    ${rows(redLabels, '#ffb3c4', 92)}

    <rect x="420" y="560" width="310" height="330" rx="20" fill="#1c2029"/>
    <text x="575" y="632" text-anchor="middle" font-family="DejaVu Sans" font-weight="bold" font-size="72" fill="#38d39f">${green}</text>
    <text x="575" y="676" text-anchor="middle" font-family="DejaVu Sans" font-size="26" fill="#c9cdd8">GREEN FLAGS</text>
    ${rows(greenLabels, '#a6e9cf', 442)}

    <text x="400" y="944" text-anchor="middle" font-family="DejaVu Sans" font-size="26" fill="${accent}">Check anyone before you meet them · yourcheckmate.app</text>
  </svg>`;

  const png = new Resvg(svg, {
    font: { fontFiles: [FONT, FONT_BOLD], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' },
  })
    .render()
    .asPng();
  return Buffer.from(png);
}
