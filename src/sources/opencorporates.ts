import { config } from '../core/config.js';
import { httpJson } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

/**
 * OpenCorporates officer search — companies he runs or is an officer of. Reveals
 * business ownership (LLCs, corporations), which is both a wealth/stability
 * signal and a lead into further records. Public company-registry data.
 *
 * Pluggable: the free tier needs an API token, so this is skipped without one.
 */
const API = 'https://api.opencorporates.com/v0.4/officers/search';

interface OfficerWrap {
  officer?: {
    name?: string;
    position?: string;
    inactive?: boolean;
    company?: {
      name?: string;
      jurisdiction_code?: string;
      company_number?: string;
      opencorporates_url?: string;
      inactive?: boolean;
    };
  };
}
interface OcResponse {
  results?: { officers?: OfficerWrap[] };
}

export const openCorporatesSource: Source = {
  id: 'opencorporates',
  label: 'Business registrations',
  accepts: ['person', 'company'],

  async run(subject, ctx) {
    if (!config.openCorporatesToken) return null;
    const parts = subject.value.trim().split(/\s+/);
    const first = parts[0]!.toLowerCase();
    const last = parts[parts.length - 1]!.toLowerCase();

    const params = new URLSearchParams({
      q: subject.value,
      api_token: config.openCorporatesToken,
      order: 'score',
      per_page: '30',
    });

    const data = await httpJson<OcResponse>(`${API}?${params}`, { timeoutMs: 10_000, cacheTtl: 86_400 });
    const officers = (data.results?.officers ?? []).map((o) => o.officer).filter(Boolean) as NonNullable<OfficerWrap['officer']>[];

    // Name-match filter — officer search is fuzzy and returns near-misses.
    const mine =
      subject.kind === 'company'
        ? officers
        : officers.filter((o) => {
            const hay = (o.name ?? '').toLowerCase();
            return hay.includes(last) && (parts.length < 2 || hay.includes(first));
          });
    if (mine.length === 0) return [];

    // De-dupe by company; keep active ones first.
    const seen = new Set<string>();
    const rows = mine
      .filter((o) => o.company?.name && !seen.has(o.company.name) && seen.add(o.company.name))
      .sort((a, b) => Number(a.company?.inactive ?? false) - Number(b.company?.inactive ?? false));

    const findings: Finding[] = [
      {
        source: 'opencorporates',
        label: 'Businesses',
        title: `🏢 ${rows.length} business${rows.length === 1 ? '' : 'es'} linked to this name`,
        detail: 'Company-registry records — confirm it’s the same person.',
        url: `https://opencorporates.com/officers?q=${encodeURIComponent(subject.value)}`,
        retrievedAt: ctx.now,
        confidence: 0.5,
      },
    ];

    for (const o of rows.slice(0, 8)) {
      const c = o.company!;
      findings.push({
        source: 'opencorporates',
        label: 'Company',
        title: `${c.name}${c.inactive ? ' (inactive)' : ''}`,
        detail: [o.position && `Role: ${o.position}`, c.jurisdiction_code && `Registered: ${c.jurisdiction_code.toUpperCase()}`].filter(Boolean).join(' · '),
        url: c.opencorporates_url ? `https://opencorporates.com${c.opencorporates_url}` : undefined,
        retrievedAt: ctx.now,
        confidence: 0.5,
      });
    }

    return findings;
  },
};
