import { config } from '../core/config.js';
import { httpJson } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

/**
 * Dating-scam / complaint check. Searches his name (or email) against scam-report
 * and consumer-complaint sites — the places victims post about catfish, romance
 * scammers and con artists. A hit is a serious lead worth reading; nothing is
 * reassuring. Uses the existing Brave key.
 */
interface BraveResult {
  web?: { results?: { title?: string; url?: string; description?: string }[] };
}

const SCAM_SITES = [
  'ripoffreport.com',
  'scamwarners.com',
  'romancescams.org',
  'scamdigging.com',
  'scamhaters.com',
  'complaintsboard.com',
  'reddit.com/r/scams',
  'socialcatfish.com',
];

export const scamSource: Source = {
  id: 'scam',
  label: 'Scam / complaint check',
  accepts: ['person', 'email'],

  async run(subject, ctx) {
    if (!config.braveKey) return null;
    const term = subject.value.trim();
    const isEmail = subject.kind === 'email';
    if (!isEmail && !term.includes(' ')) return null;

    const siteClause = SCAM_SITES.map((s) => `site:${s}`).join(' OR ');
    const query = isEmail
      ? `"${term}" (${siteClause})`
      : `"${term}"${ctx.hints ? ` ${ctx.hints}` : ''} (${siteClause} OR scammer OR catfish OR "romance scam")`;

    const res = await httpJson<BraveResult>(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`,
      { timeoutMs: 8000, cacheTtl: 21_600, headers: { 'X-Subscription-Token': config.braveKey, Accept: 'application/json' } },
    );

    const raw = res.web?.results ?? [];
    // Name/email must actually appear so a random scam page isn't pinned on him.
    const parts = term.toLowerCase().split(/\s+/);
    const hits = raw.filter((r) => {
      const hay = `${r.title ?? ''} ${r.description ?? ''}`.toLowerCase();
      return r.url && (isEmail ? hay.includes(term.toLowerCase()) : parts.every((p) => hay.includes(p)));
    });

    if (hits.length === 0) {
      return [
        {
          source: 'scam',
          label: 'Scam check',
          title: '✅ Not found on scam/complaint sites',
          detail: 'He doesn’t turn up on romance-scam or complaint boards. Good sign — not a guarantee.',
          retrievedAt: ctx.now,
          confidence: 0.5,
        },
      ];
    }

    const findings: Finding[] = [
      {
        source: 'scam',
        label: 'Scam check',
        title: `🚨 ${hits.length} scam/complaint mention(s) — READ THESE`,
        detail: 'His name/email appears on scam-report or complaint sites. UNVERIFIED — open each and check it’s actually him before believing it.',
        retrievedAt: ctx.now,
        confidence: 0.55,
      },
    ];
    for (const h of hits.slice(0, 5)) {
      findings.push({
        source: 'scam',
        label: 'Report',
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
