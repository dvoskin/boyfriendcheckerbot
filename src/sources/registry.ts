import { config } from '../core/config.js';
import { httpJson } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

/**
 * Sex-offender registry check.
 *
 * Honesty about scope: the national registry (NSOPW) and most state registries
 * have no open API and sit behind bot-protection, so a server cannot query them
 * authoritatively. Rather than fake it, this does a registry-domain-scoped web
 * search — it surfaces registry PAGES that mention the name and hands the user a
 * direct link to verify on the official site. It is a POINTER, explicitly not a
 * verdict, and it is labelled that way so nobody acts on an unconfirmed match.
 *
 * Doing a proper check requires a licensed provider; that is a paid upgrade slot.
 * Needs a search key (Brave or SerpAPI); returns null (skipped) otherwise.
 */

const REGISTRY_SITES = [
  'nsopw.gov',
  'familywatchdog.us',
  'offender.fdle.state.fl.us', // Florida (this audience skews FL)
  'meganslaw.ca.gov', // California
  'records.txdps.state.tx.us', // Texas
  'communitynotification.com',
];

interface BraveResult {
  web?: { results?: { title?: string; url?: string; description?: string }[] };
}

export const registrySource: Source = {
  id: 'registry',
  label: 'Sex-offender registry',
  accepts: ['person'],

  async run(subject, ctx) {
    if (!config.braveKey) return null; // uses Brave specifically for the site-scoped query
    const name = subject.value.trim();
    if (!name.includes(' ')) return null; // need a full name to be meaningful

    const siteClause = REGISTRY_SITES.map((s) => `site:${s}`).join(' OR ');
    const query = `"${name}" (${siteClause})`;

    const res = await httpJson<BraveResult>(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=6`,
      {
        timeoutMs: 8000,
        cacheTtl: 21_600,
        headers: { 'X-Subscription-Token': config.braveKey, Accept: 'application/json' },
      },
    );

    const hits = (res.web?.results ?? []).filter((r) => r.url);

    if (hits.length === 0) {
      return [
        {
          source: 'registry',
          label: 'Registry',
          title: '✅ No registry pages matched this name',
          detail:
            'Nothing surfaced on public sex-offender registry sites for this exact name. NOT a clearance — registries are best searched by location on the official site, and names are not unique. Confirm at nsopw.gov.',
          url: 'https://www.nsopw.gov',
          retrievedAt: ctx.now,
          confidence: 0.5,
        },
      ];
    }

    const findings: Finding[] = [
      {
        source: 'registry',
        label: 'Registry',
        title: `🔴 ${hits.length} registry page(s) mention this name — VERIFY on the official site`,
        detail:
          'This is an UNCONFIRMED pointer, not a match. Names are not unique and search engines are imprecise. Open the official record and confirm the photo, DOB and location before believing it. Never act on this alone.',
        url: 'https://www.nsopw.gov',
        retrievedAt: ctx.now,
        // Deliberately capped low: a name-only web hit must never read as fact.
        confidence: 0.4,
      },
    ];

    for (const h of hits.slice(0, 5)) {
      findings.push({
        source: 'registry',
        label: 'Registry page',
        title: (h.title ?? h.url ?? '').slice(0, 120),
        detail: h.description?.replace(/\s+/g, ' ').slice(0, 200),
        url: h.url,
        retrievedAt: ctx.now,
        confidence: 0.35,
      });
    }

    return findings;
  },
};
