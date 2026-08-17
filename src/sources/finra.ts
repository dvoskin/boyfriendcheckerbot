import { httpJson } from '../core/http.js';
import { firstNameMatches } from '../core/names.js';
import type { Finding, Source } from '../core/types.js';

/**
 * FINRA BrokerCheck — if he works (or claims to work) in finance/investing, this
 * is the record that matters: his license, current firm, and crucially the
 * DISCLOSURE flag, which flips when there are customer complaints, regulatory
 * actions, terminations or financial red marks against him.
 *
 * Free public API. Only meaningful for people in the securities industry, so it
 * simply returns nothing for everyone else.
 */
const API = 'https://api.brokercheck.finra.org/search/individual';

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Hit {
  _source?: {
    ind_source_id?: string;
    ind_firstname?: string;
    ind_lastname?: string;
    ind_bc_scope?: string;
    ind_bc_disclosure_fl?: string;
    ind_current_employments?: { firm_name?: string; branch_locations?: { city?: string; state?: string }[] }[];
  };
}
interface FinraResponse {
  hits?: { total?: number; hits?: Hit[] };
}

export const finraSource: Source = {
  id: 'finra',
  label: 'FINRA BrokerCheck',
  accepts: ['person'],

  async run(subject, ctx) {
    const parts = subject.value.trim().split(/\s+/);
    if (parts.length < 2) return null;
    const first = parts[0]!.toLowerCase();
    const last = parts[parts.length - 1]!.toLowerCase();

    const params = new URLSearchParams({
      query: subject.value,
      filter: 'active=true',
      includePrevious: 'true',
      hl: 'true',
      nrows: '12',
      start: '0',
      r: '25',
      wt: 'json',
    });

    const data = await httpJson<FinraResponse>(`${API}?${params}`, {
      timeoutMs: 9000,
      cacheTtl: 86_400,
      headers: { Accept: 'application/json' },
    });

    const hits = (data.hits?.hits ?? []).filter((h) => {
      const s = h._source;
      return firstNameMatches(first, (s?.ind_firstname ?? '').toLowerCase()) && (s?.ind_lastname ?? '').toLowerCase().includes(last);
    });
    if (hits.length === 0) return [];

    return hits.slice(0, 3).map((h): Finding => {
      const s = h._source!;
      const emp = s.ind_current_employments?.[0];
      const loc = emp?.branch_locations?.[0];
      const hasDisclosure = /y/i.test(s.ind_bc_disclosure_fl ?? '');

      return {
        source: 'finra',
        label: 'FINRA BrokerCheck',
        title: hasDisclosure
          ? `🔴 ${s.ind_firstname} ${s.ind_lastname} — financial rep WITH disclosures`
          : `💼 ${s.ind_firstname} ${s.ind_lastname} — registered financial rep`,
        detail: [
          s.ind_source_id && `CRD #${s.ind_source_id}`,
          emp?.firm_name && `Firm: ${emp.firm_name}`,
          loc && `${loc.city ?? ''} ${loc.state ?? ''}`.trim(),
          hasDisclosure
            ? '⚠️ Has DISCLOSURES — customer complaints, regulatory actions or financial marks. Read the full record.'
            : 'No disclosures on file.',
        ]
          .filter(Boolean)
          .join('\n'),
        url: s.ind_source_id ? `https://brokercheck.finra.org/individual/summary/${s.ind_source_id}` : undefined,
        retrievedAt: ctx.now,
        confidence: 0.65,
      };
    });
  },
};
