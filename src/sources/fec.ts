import { config } from '../core/config.js';
import { httpJson } from '../core/http.js';
import { stateFromHint } from '../core/names.js';
import type { Finding, Source } from '../core/types.js';

/**
 * FEC political-donations lookup (openFEC). Individual federal contributions are
 * public by law and unusually revealing for a dossier: each record carries the
 * donor's EMPLOYER and OCCUPATION (self-reported), their city/state, the amount,
 * and who they gave to. In one call you often learn where he works, what he does,
 * roughly what he earns (by how much he gives), and his politics.
 *
 * Free. DEMO_KEY works but is throttled; a free api.data.gov key removes the cap.
 */
const API = 'https://api.open.fec.gov/v1/schedules/schedule_a/';

interface Contribution {
  contributor_name?: string;
  contributor_first_name?: string;
  contributor_last_name?: string;
  contributor_employer?: string;
  contributor_occupation?: string;
  contributor_city?: string;
  contributor_state?: string;
  contribution_receipt_amount?: number;
  contribution_receipt_date?: string;
  committee?: { name?: string; party?: string };
}
interface FecResponse {
  results?: Contribution[];
  pagination?: { count?: number };
}

export const fecSource: Source = {
  id: 'fec',
  label: 'Political donations',
  accepts: ['person'],

  async run(subject, ctx) {
    const parts = subject.value.trim().split(/\s+/);
    if (parts.length < 2) return null;
    const first = parts[0]!.toLowerCase();
    const last = parts[parts.length - 1]!.toLowerCase();

    const params = new URLSearchParams({
      api_key: config.fecKey,
      contributor_name: subject.value,
      per_page: '30',
      sort: '-contribution_receipt_date',
    });
    // A state hint sharply cuts wrong-person matches on common names.
    const state = stateFromHint(ctx.hints);
    if (state) params.append('contributor_state', state);

    const data = await httpJson<FecResponse>(`${API}?${params}`, { timeoutMs: 10_000, cacheTtl: 86_400 });
    const all = data.results ?? [];

    // Keep only rows whose name actually matches — FEC's name search is loose.
    const mine = all.filter((c) => {
      const hay = `${c.contributor_name ?? ''} ${c.contributor_first_name ?? ''} ${c.contributor_last_name ?? ''}`.toLowerCase();
      return hay.includes(last) && hay.includes(first);
    });
    if (mine.length === 0) return [];

    // Aggregate the revealing bits across his donations.
    const employers = new Map<string, number>();
    const occupations = new Map<string, number>();
    const recipients = new Map<string, number>();
    const cities = new Set<string>();
    let total = 0;

    for (const c of mine) {
      if (c.contributor_employer && !/^(none|n\/a|retired|self|self-employed|not employed)$/i.test(c.contributor_employer.trim())) {
        employers.set(c.contributor_employer, (employers.get(c.contributor_employer) ?? 0) + 1);
      }
      if (c.contributor_occupation) occupations.set(c.contributor_occupation, (occupations.get(c.contributor_occupation) ?? 0) + 1);
      if (c.committee?.name) recipients.set(c.committee.name, (recipients.get(c.committee.name) ?? 0) + (c.contribution_receipt_amount ?? 0));
      if (c.contributor_city && c.contributor_state) cities.add(`${c.contributor_city}, ${c.contributor_state}`);
      total += c.contribution_receipt_amount ?? 0;
    }

    const top = (m: Map<string, number>, n: number) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

    const findings: Finding[] = [
      {
        source: 'fec',
        label: 'Political donations',
        title: `💸 ${mine.length} political donation(s) — $${Math.round(total).toLocaleString()} total`,
        detail: [
          employers.size && `Employer: ${top(employers, 2).join(' / ')}`,
          occupations.size && `Job: ${top(occupations, 2).join(' / ')}`,
          cities.size && `Donor city: ${[...cities].slice(0, 3).join('; ')}`,
          recipients.size && `Gave to: ${top(recipients, 3).join(', ')}`,
          'Self-reported to the FEC — public record.',
        ]
          .filter(Boolean)
          .join('\n'),
        url: `https://www.fec.gov/data/receipts/individual-contributions/?contributor_name=${encodeURIComponent(subject.value)}`,
        retrievedAt: ctx.now,
        confidence: state ? 0.65 : 0.5,
        extra: { employer: top(employers, 1)[0], occupation: top(occupations, 1)[0] },
      },
    ];

    return findings;
  },
};
