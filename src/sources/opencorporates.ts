import { config } from '../core/config.js';
import { httpJson } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

/**
 * Business registrations — companies/LLCs he's tied to. OpenCorporates' API now
 * costs £2,250/yr, so instead we search the FREE public business directories
 * (which index the same state-registry data) with the existing Brave key. Less
 * structured than a paid API, but it surfaces his companies at zero extra cost.
 * Enformion's "business/property" indicators also flag this independently.
 */
interface BraveResult {
  web?: { results?: { title?: string; url?: string; description?: string }[] };
}

const DIRECTORY_SITES = [
  'opencorporates.com',
  'bizapedia.com',
  'corporationwiki.com',
  'opengovus.com',
  'buzzfile.com',
];

export const openCorporatesSource: Source = {
  id: 'opencorporates',
  label: 'Business registrations',
  accepts: ['person', 'company'],

  async run(subject, ctx) {
    if (!config.braveKey) return null;
    const parts = subject.value.trim().split(/\s+/);
    if (subject.kind === 'person' && parts.length < 2) return null;
    const first = parts[0]!.toLowerCase();
    const last = parts[parts.length - 1]!.toLowerCase();

    const siteClause = DIRECTORY_SITES.map((s) => `site:${s}`).join(' OR ');
    const query = `"${subject.value}"${ctx.hints ? ` ${ctx.hints}` : ''} (${siteClause})`;

    const data = await httpJson<BraveResult>(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`,
      { timeoutMs: 8000, cacheTtl: 43_200, headers: { 'X-Subscription-Token': config.braveKey, Accept: 'application/json' } },
    );

    const raw = data.web?.results ?? [];
    // The person's name must actually appear so a stranger's company isn't his.
    const hits = raw.filter((r) => {
      const hay = `${r.title ?? ''} ${r.description ?? ''}`.toLowerCase();
      return r.url && (subject.kind === 'company' ? hay.includes(last) : hay.includes(first) && hay.includes(last));
    });
    if (hits.length === 0) return [];

    const findings: Finding[] = [
      {
        source: 'opencorporates',
        label: 'Businesses',
        title: `🏢 ${hits.length} business record(s) linked to this name`,
        detail: 'From public company directories — confirm it’s the same person.',
        retrievedAt: ctx.now,
        confidence: 0.45,
      },
    ];
    for (const h of hits.slice(0, 6)) {
      findings.push({
        source: 'opencorporates',
        label: 'Company',
        title: `${h.title ?? h.url}`.slice(0, 110),
        detail: h.description?.replace(/\s+/g, ' ').slice(0, 160),
        url: h.url,
        retrievedAt: ctx.now,
        confidence: 0.4,
      });
    }
    return findings;
  },
};
