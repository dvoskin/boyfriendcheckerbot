import { httpJson } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

const CDX = 'https://web.archive.org/cdx/search/cdx';

/**
 * CDX returns a header row followed by value rows, not objects.
 * ["original","timestamp","statuscode","digest"] then N rows of strings.
 */
type CdxRows = string[][];

/** Profiles worth checking for a *historical* capture, ordered by usefulness. */
const PROFILE_PATTERNS: { name: string; path: (u: string) => string }[] = [
  { name: 'X/Twitter', path: (u) => `twitter.com/${u}` },
  { name: 'Instagram', path: (u) => `instagram.com/${u}` },
  { name: 'Facebook', path: (u) => `facebook.com/${u}` },
  { name: 'LinkedIn', path: (u) => `linkedin.com/in/${u}` },
  { name: 'Reddit', path: (u) => `reddit.com/user/${u}` },
  { name: 'TikTok', path: (u) => `tiktok.com/@${u}` },
  { name: 'GitHub', path: (u) => `github.com/${u}` },
  { name: 'Medium', path: (u) => `medium.com/@${u}` },
];

function fmtTs(ts: string): string {
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
}

async function cdxQuery(url: string, extra: Record<string, string>): Promise<CdxRows> {
  const params = new URLSearchParams({
    url,
    output: 'json',
    fl: 'original,timestamp,statuscode,digest',
    filter: 'statuscode:200',
    // Drop consecutive captures with identical content so we see real changes.
    collapse: 'digest',
    limit: '40',
    ...extra,
  });
  const rows = await httpJson<CdxRows>(`${CDX}?${params}`, {
    timeoutMs: 9000,
    // CDX throttles hard and flaps 429/503; a day of caching costs nothing
    // because archived history barely changes.
    cacheTtl: 86_400,
    retries: 3,
  });
  return Array.isArray(rows) && rows.length > 1 ? rows.slice(1) : [];
}

export const waybackSource: Source = {
  id: 'wayback',
  label: 'Internet Archive',
  accepts: ['username', 'domain'],

  async run(subject, ctx) {
    const findings: Finding[] = [];

    if (subject.kind === 'domain') {
      const rows = await cdxQuery(subject.value, { matchType: 'domain' });
      if (rows.length === 0) return [];

      const timestamps = rows.map((r) => r[1] ?? '').filter(Boolean).sort();
      const first = timestamps[0];
      const last = timestamps[timestamps.length - 1];

      findings.push({
        source: 'wayback',
        label: 'Internet Archive',
        title: `${rows.length}+ archived captures of ${subject.value}`,
        detail: first && last ? `Earliest ${fmtTs(first)}, latest ${fmtTs(last)}` : undefined,
        url: `https://web.archive.org/web/*/${subject.value}/*`,
        retrievedAt: ctx.now,
        confidence: 0.9,
      });

      // Pages whose paths hint at people: team/staff/about/contact/leadership.
      const interesting = rows.filter((r) =>
        /\/(about|team|staff|leadership|our-?team|contact|management|founders?|bio)/i.test(r[0] ?? ''),
      );
      for (const row of interesting.slice(0, 8)) {
        const [original, ts] = row;
        if (!original || !ts) continue;
        findings.push({
          source: 'wayback',
          label: 'Archived page',
          title: original.replace(/^https?:\/\//, '').slice(0, 90),
          detail: `Captured ${fmtTs(ts)} — historical people/company info`,
          // The id_ suffix returns the original bytes with no Wayback toolbar
          // injected and no rewritten links, which is what you want to parse.
          url: `https://web.archive.org/web/${ts}id_/${original}`,
          retrievedAt: ctx.now,
          confidence: 0.75,
        });
      }
      return findings;
    }

    // Username: prove a profile existed even if it is gone today. This is the
    // single most useful thing in the archive and almost nothing else does it.
    const username = subject.value.replace(/^@/, '');
    const results = await Promise.allSettled(
      PROFILE_PATTERNS.map(async (p) => {
        const rows = await cdxQuery(p.path(username), { matchType: 'prefix' });
        return { name: p.name, path: p.path(username), rows };
      }),
    );

    for (const r of results) {
      if (r.status !== 'fulfilled' || r.value.rows.length === 0) continue;
      const { name, path, rows } = r.value;
      const timestamps = rows.map((x) => x[1] ?? '').filter(Boolean).sort();
      const first = timestamps[0];
      const last = timestamps[timestamps.length - 1];
      if (!first || !last) continue;

      findings.push({
        source: 'wayback',
        label: `Archived ${name}`,
        title: `${name} profile was archived (${rows.length} captures)`,
        detail: `Seen ${fmtTs(first)} → ${fmtTs(last)}. Snapshot survives even if the live profile is deleted.`,
        url: `https://web.archive.org/web/${last}id_/https://${path}`,
        retrievedAt: ctx.now,
        confidence: 0.8,
      });
    }

    return findings;
  },
};
