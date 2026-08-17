import { config } from '../core/config.js';
import { httpJson } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

/**
 * Adverse-media check — the "is he dangerous / a mess" scan. Runs his name against
 * negative-news terms and surfaces anything that looks like an arrest, charge,
 * lawsuit, fraud or scandal. This is the single most safety-relevant free source:
 * a normal person returns nothing, and a real problem tends to leave a news trail.
 *
 * Uses Brave. Results are name-matched and clearly framed as UNVERIFIED leads —
 * a same-name stranger's arrest must never be pinned on him.
 */
interface BraveResult {
  web?: { results?: { title?: string; url?: string; description?: string; age?: string }[] };
}

const ADVERSE_TERMS =
  'arrested OR charged OR convicted OR lawsuit OR sued OR fraud OR scam OR assault OR "restraining order" OR DUI OR indicted OR "sex offender" OR harassment';

export const adverseSource: Source = {
  id: 'adverse',
  label: 'Adverse news',
  accepts: ['person'],

  async run(subject, ctx) {
    if (!config.braveKey) return null;
    const parts = subject.value.trim().split(/\s+/);
    if (parts.length < 2) return null;
    const first = parts[0]!.toLowerCase();
    const last = parts[parts.length - 1]!.toLowerCase();

    const hint = ctx.hints ? ` ${ctx.hints}` : '';
    const query = `"${subject.value}"${hint} (${ADVERSE_TERMS})`;

    const res = await httpJson<BraveResult>(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`,
      { timeoutMs: 8000, cacheTtl: 21_600, headers: { 'X-Subscription-Token': config.braveKey, Accept: 'application/json' } },
    );

    const raw = res.web?.results ?? [];
    // Require his full name in the title/description so we don't attach a random
    // same-name person's crime to him.
    const hits = raw.filter((r) => {
      const hay = `${r.title ?? ''} ${r.description ?? ''}`.toLowerCase();
      return r.url && hay.includes(first) && hay.includes(last);
    });

    if (hits.length === 0) {
      return [
        {
          source: 'adverse',
          label: 'Adverse news',
          title: '✅ No arrests / lawsuits / scandals in the news',
          detail: 'No negative news matched his name. Reassuring, not a guarantee — minor or local records don’t always make the news.',
          retrievedAt: ctx.now,
          confidence: 0.5,
        },
      ];
    }

    const findings: Finding[] = [
      {
        source: 'adverse',
        label: 'Adverse news',
        title: `🚨 ${hits.length} possible negative news result(s) — READ these`,
        detail: 'His name appears alongside serious keywords. UNVERIFIED — open each one and confirm it’s actually him (photo, city, age), not a namesake.',
        retrievedAt: ctx.now,
        confidence: 0.55,
      },
    ];
    for (const h of hits.slice(0, 6)) {
      findings.push({
        source: 'adverse',
        label: 'News',
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
