import { config } from '../core/config.js';
import { httpJson } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

/**
 * Arrest / criminal-record search. Official state criminal databases have no open
 * API, but a huge amount of arrest data IS published online — county "who's in
 * jail" logs and mugshot aggregators (JailBase, Arrests.org, Mugshots.com). This
 * searches those for the name and surfaces hits as a SAFETY lead.
 *
 * It is NOT the official record and it is NOT complete — it only catches what got
 * published — so every hit is framed as "verify this is actually them". For the
 * authoritative record, a paid court source (UniCourt) is still needed. Uses the
 * existing Brave key.
 */
interface BraveResult {
  web?: { results?: { title?: string; url?: string; description?: string }[] };
}

const ARREST_SITES = [
  'mugshots.com',
  'jailbase.com',
  'arrests.org',
  'bustedmugshots.com',
  'recentarrests.org',
  'mugshotlook.com',
  'arrestfacts.com',
];

export const criminalSource: Source = {
  id: 'criminal',
  label: 'Arrest records',
  accepts: ['person'],

  async run(subject, ctx) {
    if (!config.braveKey) return null;
    const name = subject.value.trim();
    const parts = name.split(/\s+/);
    if (parts.length < 2) return null;
    const first = parts[0]!.toLowerCase();
    const last = parts[parts.length - 1]!.toLowerCase();

    const siteClause = ARREST_SITES.map((s) => `site:${s}`).join(' OR ');
    const loc = subject.hints ? ` ${subject.hints}` : '';
    const query = `"${name}"${loc} (${siteClause} OR arrested OR mugshot OR "booked into" OR "arrest record" OR "county jail")`;

    const res = await httpJson<BraveResult>(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`,
      { timeoutMs: 8000, cacheTtl: 21_600, headers: { 'X-Subscription-Token': config.braveKey, Accept: 'application/json' } },
    );

    const raw = res.web?.results ?? [];
    // Require the full name in the result, and that it actually looks like an
    // arrest/crime page — otherwise a common name pulls in unrelated pages.
    const crimeish = /arrest|mugshot|book|jail|charge|inmate|offender|felony|misdemeanor|custody|warrant/i;
    const hits = raw.filter((r) => {
      const hay = `${r.title ?? ''} ${r.description ?? ''}`.toLowerCase();
      const onArrestSite = ARREST_SITES.some((s) => (r.url ?? '').includes(s));
      return r.url && hay.includes(first) && hay.includes(last) && (onArrestSite || crimeish.test(hay));
    });

    if (hits.length === 0) {
      return [
        {
          source: 'criminal',
          label: 'Arrest records',
          title: `✅ No published arrest records found for ${name}`,
          detail:
            'Nothing surfaced on public arrest/mugshot sites. NOT an official clearance — many records aren’t published online. For the authoritative record, a court-records source is needed.',
          retrievedAt: ctx.now,
          confidence: 0.5,
        },
      ];
    }

    const findings: Finding[] = [
      {
        source: 'criminal',
        label: 'Arrest records',
        title: `🔴 ${hits.length} possible arrest/criminal record(s) — VERIFY it’s them`,
        detail: `${subject.hints ? '' : '⚠️ No city given, so these may be a different person with the same name. '}Open each and confirm the photo, age and location. Common names get false matches.`,
        retrievedAt: ctx.now,
        confidence: subject.hints ? 0.55 : 0.4,
      },
    ];
    for (const h of hits.slice(0, 6)) {
      findings.push({
        source: 'criminal',
        label: 'Record',
        title: `${h.title ?? h.url}`.slice(0, 120),
        detail: h.description?.replace(/\s+/g, ' ').slice(0, 180),
        url: h.url,
        retrievedAt: ctx.now,
        confidence: 0.4,
      });
    }
    return findings;
  },
};
