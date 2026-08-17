import { config } from '../core/config.js';
import { httpJson } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

/**
 * CourtListener's free API tier was cut to 5/min, 50/hour and 125/DAY in May 2026.
 * That is a testing budget, not a production one, so this source deliberately
 * refuses to run once the daily allowance is spent rather than serving errors.
 *
 * The production path is the quarterly bulk snapshot loaded into your own
 * Postgres (see README). When you do that, remember to propagate *removals*:
 * CourtListener honours sealing and takedown requests, and a stale snapshot will
 * happily keep serving a case a court has ordered closed.
 */
const API = 'https://www.courtlistener.com/api/rest/v4';
const DAILY_BUDGET = 100; // leave headroom under the 125/day cap

let spent = 0;
let windowDay = '';

function budgetRemaining(): number {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== windowDay) {
    windowDay = today;
    spent = 0;
  }
  return DAILY_BUDGET - spent;
}

interface SearchResult {
  count?: number;
  results?: {
    caseName?: string;
    court?: string;
    dateFiled?: string;
    absolute_url?: string;
    docketNumber?: string;
    snippet?: string;
    court_id?: string;
  }[];
}

export const courtListenerSource: Source = {
  id: 'courtlistener',
  label: 'CourtListener',
  accepts: ['person', 'company'],

  async run(subject, ctx) {
    if (!config.courtListenerToken) return null;
    if (budgetRemaining() <= 0) {
      throw new Error('daily CourtListener API budget spent — switch to the bulk snapshot');
    }
    spent++;

    const params = new URLSearchParams({
      q: `"${subject.value.replace(/"/g, '')}"`,
      type: 'r', // RECAP: federal dockets and documents
      order_by: 'dateFiled desc',
    });

    const res = await httpJson<SearchResult>(`${API}/search/?${params}`, {
      timeoutMs: 10_000,
      cacheTtl: 86_400,
      headers: { Authorization: `Token ${config.courtListenerToken}` },
    });

    const results = res.results ?? [];
    if (results.length === 0) return [];

    const findings: Finding[] = [
      {
        source: 'courtlistener',
        label: 'CourtListener',
        title: `${res.count ?? results.length} federal court records matched`,
        detail:
          'Court records are public. Using them to decide employment, housing, credit or insurance makes this a consumer report under FCRA.',
        url: `https://www.courtlistener.com/?q=${encodeURIComponent(subject.value)}&type=r`,
        retrievedAt: ctx.now,
        confidence: 0.8,
      },
    ];

    for (const r of results.slice(0, 6)) {
      findings.push({
        source: 'courtlistener',
        label: r.court ?? 'Court',
        title: r.caseName ?? 'Unnamed case',
        detail: [
          r.docketNumber && `Docket: ${r.docketNumber}`,
          r.dateFiled && `Filed: ${r.dateFiled}`,
          r.snippet && r.snippet.replace(/<[^>]+>/g, '').slice(0, 200),
        ]
          .filter(Boolean)
          .join('\n'),
        url: r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : undefined,
        retrievedAt: ctx.now,
        confidence: 0.6,
      });
    }

    return findings;
  },
};
