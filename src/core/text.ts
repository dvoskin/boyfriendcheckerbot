/**
 * Decode HTML entities that arrive in scraped/searched text (Instagram meta tags,
 * search snippets). Without this, "&#064;handle" and "&#x2022;" render literally
 * in the report instead of "@handle" and "•". Numeric refs are decoded first so a
 * following named-entity pass can't corrupt them.
 */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCp(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function safeCp(n: number): string {
  try {
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  } catch {
    return '';
  }
}
