import { httpJson } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

/**
 * Wikipedia lookup — is he actually a notable public figure? A hit means there's
 * a vetted, sourced biography to read (and to check his claims against). Free,
 * no key. Matches conservatively so a same-named celebrity isn't pinned on him.
 */
interface SearchResponse {
  query?: { search?: { title?: string; snippet?: string; pageid?: number }[] };
}

export const wikipediaSource: Source = {
  id: 'wikipedia',
  label: 'Wikipedia',
  accepts: ['person', 'company'],

  async run(subject, ctx) {
    const name = subject.value.trim();
    const params = new URLSearchParams({
      action: 'query',
      list: 'search',
      srsearch: name,
      srlimit: '3',
      format: 'json',
      origin: '*',
    });

    const data = await httpJson<SearchResponse>(`https://en.wikipedia.org/w/api.php?${params}`, {
      timeoutMs: 7000,
      cacheTtl: 86_400,
      headers: { 'user-agent': 'recon-bot' },
    });

    const results = data.query?.search ?? [];
    // Require the article title to actually contain his full name — Wikipedia
    // search is fuzzy and will otherwise return loosely-related notable people.
    const parts = name.toLowerCase().split(/\s+/);
    const hit = results.find((r) => {
      const t = (r.title ?? '').toLowerCase();
      return parts.every((p) => t.includes(p));
    });
    if (!hit) return [];

    return [
      {
        source: 'wikipedia',
        label: 'Wikipedia',
        title: `📖 He has a Wikipedia page: ${hit.title}`,
        detail: (hit.snippet ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').slice(0, 200),
        url: `https://en.wikipedia.org/?curid=${hit.pageid}`,
        retrievedAt: ctx.now,
        confidence: 0.7,
      },
    ];
  },
};
