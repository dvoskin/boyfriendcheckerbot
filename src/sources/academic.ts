import { httpJson } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

/**
 * OpenAlex author search — does his "I'm a doctor / researcher / professor" story
 * hold up? Returns whether a researcher by his name exists, how much they've
 * published, and their institution. Free, no key.
 */
interface Author {
  display_name?: string;
  works_count?: number;
  cited_by_count?: number;
  last_known_institutions?: { display_name?: string }[];
  last_known_institution?: { display_name?: string };
  ids?: { openalex?: string };
  orcid?: string;
}
interface OaResponse {
  results?: Author[];
}

export const academicSource: Source = {
  id: 'academic',
  label: 'Academic record',
  accepts: ['person'],

  async run(subject, ctx) {
    const name = subject.value.trim();
    if (!name.includes(' ')) return null;

    const data = await httpJson<OaResponse>(
      `https://api.openalex.org/authors?search=${encodeURIComponent(name)}&per_page=3`,
      { timeoutMs: 8000, cacheTtl: 86_400, headers: { 'user-agent': 'recon-bot (mailto:hello@example.com)' } },
    );

    const parts = name.toLowerCase().split(/\s+/);
    const author = (data.results ?? []).find((a) => {
      const dn = (a.display_name ?? '').toLowerCase();
      return parts.every((p) => dn.includes(p)) && (a.works_count ?? 0) > 0;
    });
    if (!author) return [];

    const inst = author.last_known_institutions?.[0]?.display_name ?? author.last_known_institution?.display_name;
    return [
      {
        source: 'academic',
        label: 'Academic record',
        title: `🎓 Published researcher: ${author.display_name} (${author.works_count} papers)`,
        detail: [
          inst && `Institution: ${inst}`,
          author.cited_by_count && `Cited ${author.cited_by_count} times`,
          author.orcid && `ORCID: ${author.orcid}`,
        ]
          .filter(Boolean)
          .join('\n'),
        url: author.orcid ?? (author.ids?.openalex ? author.ids.openalex : undefined),
        retrievedAt: ctx.now,
        // Name-only academic match is suggestive, not proof it's the same person.
        confidence: 0.45,
      },
    ];
  },
};
