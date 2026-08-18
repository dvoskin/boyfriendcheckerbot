import { Resvg } from '@resvg/resvg-js';
import type { ReportSummary } from '../report.js';

/**
 * A branded, screenshot-perfect verdict card — the growth engine. It is
 * deliberately ANONYMIZED (no name, no photo): sharing it sells Checkmate, it
 * never publishes a claim about a named person, which keeps it defamation-safe.
 */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderCardPng(summary: ReportSummary): Buffer {
  const { verdict, score, red, green } = summary;
  const accent = score >= 75 ? '#38d39f' : score >= 45 ? '#f5c451' : '#ff5c7a';
  const verdictText = esc(verdict);
  const filled = Math.max(0, Math.min(10, Math.round(score / 10)));
  const barW = 60;
  const gap = 10;
  const barsStartX = (760 - (barW * 10 + gap * 9)) / 2 + 20;

  const bars = Array.from({ length: 10 }, (_, i) => {
    const x = barsStartX + i * (barW + gap);
    return `<rect x="${x}" y="470" width="${barW}" height="40" rx="6" fill="${i < filled ? accent : '#2b2f3a'}"/>`;
  }).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000" viewBox="0 0 800 1000">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#161922"/>
        <stop offset="1" stop-color="#0e1017"/>
      </linearGradient>
    </defs>
    <rect width="800" height="1000" fill="url(#bg)"/>
    <rect x="24" y="24" width="752" height="952" rx="28" fill="none" stroke="#232735" stroke-width="2"/>

    <text x="400" y="150" text-anchor="middle" font-family="Arial, sans-serif" font-size="64" font-weight="bold" fill="#ffffff">♟️ CHECKMATE</text>
    <text x="400" y="200" text-anchor="middle" font-family="Arial, sans-serif" font-size="26" fill="#8b90a0">dating-safety report</text>

    <text x="400" y="360" text-anchor="middle" font-family="Arial, sans-serif" font-size="58" font-weight="bold" fill="${accent}">${verdictText}</text>

    <text x="400" y="450" text-anchor="middle" font-family="Arial, sans-serif" font-size="30" fill="#c9cdd8">Vibe check: ${score}/100</text>
    ${bars}

    <rect x="70" y="600" width="310" height="220" rx="20" fill="#1c2029"/>
    <text x="225" y="675" text-anchor="middle" font-family="Arial, sans-serif" font-size="80" font-weight="bold" fill="#ff5c7a">${red}</text>
    <text x="225" y="740" text-anchor="middle" font-family="Arial, sans-serif" font-size="30" fill="#c9cdd8">🚩 red flags</text>

    <rect x="420" y="600" width="310" height="220" rx="20" fill="#1c2029"/>
    <text x="575" y="675" text-anchor="middle" font-family="Arial, sans-serif" font-size="80" font-weight="bold" fill="#38d39f">${green}</text>
    <text x="575" y="740" text-anchor="middle" font-family="Arial, sans-serif" font-size="30" fill="#c9cdd8">💚 green flags</text>

    <text x="400" y="910" text-anchor="middle" font-family="Arial, sans-serif" font-size="30" font-weight="bold" fill="#ffffff">Check anyone before you meet them</text>
    <text x="400" y="952" text-anchor="middle" font-family="Arial, sans-serif" font-size="26" fill="${accent}">yourcheckmate.app</text>
  </svg>`;

  return Buffer.from(new Resvg(svg).render().asPng());
}
