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

    const raw = (res.web?.results ?? []).filter((r) => r.url);

    // Critical safety filter: a registry-site web result only counts if the
    // person's LAST name (and, when present, first name) actually appears in the
    // page's title or description. Without this, Brave returns generic registry
    // landing pages and entries for *other* people who merely share a first name
    // — which is exactly how you end up showing a stranger's offender record next
    // to an innocent person. Names on this topic must be exact or not shown.
    const parts = name.toLowerCase().split(/\s+/);
    const first = parts[0]!;
    const last = parts[parts.length - 1]!;
    const isRealMatch = (r: { title?: string; description?: string }): boolean => {
      const hay = `${r.title ?? ''} ${r.description ?? ''}`.toLowerCase();
      return hay.includes(last) && hay.includes(first);
    };

    const matches = raw.filter(isRealMatch);

    if (matches.length === 0) {
      // No page actually names this person. Report the all-clear plainly — and
      // never list the different-people pages that got filtered out.
      return [
        {
          source: 'registry',
          label: 'Registry',
          title: `✅ No sex-offender registry match for ${name}`,
          detail:
            'No registry page actually names this person. Not a formal clearance — the official registries have no open search, so for full peace of mind search his exact name + location yourself at nsopw.gov.',
          url: 'https://www.nsopw.gov',
          retrievedAt: ctx.now,
          confidence: 0.55,
        },
      ];
    }

    const findings: Finding[] = [
      {
        source: 'registry',
        label: 'Registry',
        title: `🔴 A registry page names "${name}" — VERIFY before believing it`,
        detail:
          'A public registry page mentions this exact name. This is still NOT confirmation — names repeat. Open the official record and match the PHOTO, date of birth and location before you trust it. Never act on this alone.',
        url: 'https://www.nsopw.gov',
        retrievedAt: ctx.now,
        confidence: 0.5,
      },
    ];

    for (const h of matches.slice(0, 4)) {
      findings.push({
        source: 'registry',
        label: 'Registry page',
        // Title only — the descriptions are just the site's legal boilerplate.
        title: (h.title ?? h.url ?? '').slice(0, 120),
        url: h.url,
        retrievedAt: ctx.now,
        confidence: 0.4,
      });
    }

    return findings;
  },
};
