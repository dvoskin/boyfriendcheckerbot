import { config } from '../core/config.js';
import { httpJson } from '../core/http.js';
import type { Finding, Source, Subject } from '../core/types.js';

/**
 * The search layer is how we reach the platforms that block direct access —
 * Instagram, LinkedIn, Facebook, TikTok. We cannot read those profiles, but a
 * site-scoped query proves the profile exists and returns its public snippet,
 * which is usually the bio.
 *
 * Note there is no Bing option: Microsoft decommissioned the Bing Search APIs on
 * 2025-08-11. Brave and SerpAPI are the practical choices.
 */
interface BraveResponse {
  web?: { results?: { title?: string; url?: string; description?: string }[] };
}

interface SerpApiResponse {
  organic_results?: { title?: string; link?: string; snippet?: string }[];
}

interface Hit {
  title: string;
  url: string;
  snippet?: string;
}

async function brave(query: string): Promise<Hit[]> {
  const res = await httpJson<BraveResponse>(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`,
    {
      timeoutMs: 8000,
      cacheTtl: 21_600,
      headers: {
        'X-Subscription-Token': config.braveKey!,
        Accept: 'application/json',
      },
    },
  );
  return (res.web?.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({ title: r.title ?? r.url!, url: r.url!, snippet: r.description }));
}

async function serpapi(query: string): Promise<Hit[]> {
  const res = await httpJson<SerpApiResponse>(
    `https://serpapi.com/search.json?engine=google&num=8&q=${encodeURIComponent(query)}&api_key=${config.serpapiKey}`,
    { timeoutMs: 12_000, cacheTtl: 21_600 },
  );
  return (res.organic_results ?? [])
    .filter((r) => r.link)
    .map((r) => ({ title: r.title ?? r.link!, url: r.link!, snippet: r.snippet }));
}

async function search(query: string): Promise<Hit[]> {
  if (config.braveKey) return brave(query);
  if (config.serpapiKey) return serpapi(query);
  return [];
}

/** Platforms we cannot read directly, so we ask the index about them instead. */
const LOCKED_PLATFORMS = [
  'linkedin.com/in',
  'instagram.com',
  'facebook.com',
  'tiktok.com',
  'x.com',
];

function buildQueries(subject: Subject, hints?: string): string[] {
  const v = subject.value;
  const withHint = hints ? `${v} ${hints}` : v;

  if (subject.kind === 'username') {
    return [`"${v}"`, ...LOCKED_PLATFORMS.slice(0, 3).map((p) => `site:${p} "${v}"`)];
  }
  if (subject.kind === 'domain') {
    return [`site:${v}`, `"${v}" -site:${v}`];
  }
  return [`"${withHint}"`, ...LOCKED_PLATFORMS.slice(0, 3).map((p) => `site:${p} "${v}"`)];
}

export const searchSource: Source = {
  id: 'search',
  label: 'Web search',
  accepts: ['username', 'person', 'company', 'domain', 'email', 'phone'],

  async run(subject, ctx) {
    if (!config.braveKey && !config.serpapiKey) return null;

    const queries = buildQueries(subject, ctx.hints);
    const settled = await Promise.allSettled(queries.map((q) => search(q)));

    const seen = new Set<string>();
    const findings: Finding[] = [];

    settled.forEach((result, i) => {
      if (result.status !== 'fulfilled') return;
      const query = queries[i]!;
      const isSiteScoped = query.startsWith('site:');

      for (const hit of result.value) {
        if (seen.has(hit.url)) continue;
        seen.add(hit.url);
        // A result that IS a social profile URL is high-signal even from a plain
        // query — and we want the graph to pivot on it (extract the handle and
        // enumerate his other accounts), which needs it above the pivot bar.
        const isSocial = /(?:instagram|facebook|tiktok|twitter|x|linkedin|threads|pinterest)\.com\//i.test(hit.url);
        findings.push({
          source: 'search',
          label: isSocial ? 'Social profile' : isSiteScoped ? 'Platform profile' : 'Web',
          title: hit.title.slice(0, 120),
          detail: hit.snippet?.replace(/\s+/g, ' ').slice(0, 250),
          url: hit.url,
          retrievedAt: ctx.now,
          confidence: isSocial || isSiteScoped ? 0.65 : 0.4,
          extra: { query, isSocial },
        });
      }
    });

    return findings.slice(0, 20);
  },
};
