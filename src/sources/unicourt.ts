import { config } from '../core/config.js';
import type { Finding, Source, Subject } from '../core/types.js';

/**
 * UniCourt — state & federal court records (140M+ cases): criminal, civil, and
 * family/divorce. This is the serious safety layer — DUIs, assault charges,
 * restraining orders, lawsuits, divorce filings.
 *
 * ⚠️ VERIFY-ON-CONNECT: UniCourt's Enterprise API uses OAuth2 client-credentials
 * and its exact endpoint paths/response shape are behind their account docs. The
 * flow below is the documented shape; once real credentials are set, confirm the
 * response mapping the same way we did with Enformion (which then worked). If a
 * path is off it simply errors and shows as a gap — it never breaks the report.
 *
 * Pluggable: skipped unless both client id and secret are set.
 */
const TOKEN_URL = 'https://enterpriseapi.unicourt.com/authenticationApi/authentication/token';
const SEARCH_URL = 'https://enterpriseapi.unicourt.com/dataApi/searchCases';

/* eslint-disable @typescript-eslint/no-explicit-any */
let cachedToken: { value: string; expires: number } | null = null;

async function token(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now()) return cachedToken.value;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grantType: 'client_credentials',
      clientId: config.uniCourtClientId,
      clientSecret: config.uniCourtClientSecret,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`UniCourt auth HTTP ${res.status}`);
  const data = (await res.json()) as any;
  const tok = data.accessToken ?? data.access_token ?? data.token;
  if (!tok) throw new Error('UniCourt auth returned no token');
  cachedToken = { value: tok, expires: Date.now() + 50 * 60_000 };
  return tok;
}

function get(obj: any, ...names: string[]): any {
  if (!obj || typeof obj !== 'object') return undefined;
  const map = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const real = map.get(n.toLowerCase());
    if (real !== undefined) return obj[real];
  }
  return undefined;
}

function nameParts(subject: Subject): { first: string; last: string } | null {
  const parts = subject.value.trim().split(/\s+/);
  if (parts.length < 2) return null;
  return { first: parts[0]!, last: parts[parts.length - 1]! };
}

export const uniCourtSource: Source = {
  id: 'unicourt',
  label: 'Court records',
  accepts: ['person'],

  async run(subject, ctx) {
    if (!config.uniCourtClientId || !config.uniCourtClientSecret) return null;
    const np = nameParts(subject);
    if (!np) return null;

    const tok = await token();
    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ parties: [{ name: subject.value }], pageSize: 20 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`UniCourt search HTTP ${res.status}`);
    const data = (await res.json()) as any;

    const cases: any[] = get(data, 'cases', 'results', 'data') ?? (Array.isArray(data) ? data : []);
    if (cases.length === 0) {
      return [
        {
          source: 'unicourt',
          label: 'Court records',
          title: `✅ No court cases found for ${subject.raw}`,
          detail: 'No matching state/federal court records. Not exhaustive — some courts aren’t digitized.',
          retrievedAt: ctx.now,
          confidence: 0.5,
        },
      ];
    }

    // Name-match filter and light "is it scary" classification.
    const last = np.last.toLowerCase();
    const first = np.first.toLowerCase();
    const mine = cases.filter((c) => {
      const parties = JSON.stringify(get(c, 'parties', 'partyNames') ?? '').toLowerCase();
      return parties.includes(last) && parties.includes(first);
    });
    if (mine.length === 0) return [];

    const scary = /criminal|assault|battery|violence|restraining|protective|dui|dwi|dv |domestic|fraud|theft|stalking|harassment/i;
    const findings: Finding[] = [
      {
        source: 'unicourt',
        label: 'Court records',
        title: `⚖️ ${mine.length} court case(s) involving this name`,
        detail: 'Includes civil, criminal and family court. Confirm it’s him (parties/location) before drawing conclusions.',
        retrievedAt: ctx.now,
        confidence: 0.6,
      },
    ];

    for (const c of mine.slice(0, 8)) {
      const name = get(c, 'caseName', 'name', 'title') ?? 'Case';
      const type = get(c, 'caseType', 'type', 'natureOfSuit');
      const court = get(c, 'court', 'courtName');
      const date = get(c, 'filedDate', 'dateFiled', 'filingDate');
      const isScary = scary.test(`${name} ${type}`);
      findings.push({
        source: 'unicourt',
        label: isScary ? '🔴 Case' : 'Case',
        title: `${isScary ? '🔴 ' : ''}${String(name).slice(0, 100)}`,
        detail: [type && `Type: ${type}`, court && `Court: ${court}`, date && `Filed: ${String(date).slice(0, 10)}`].filter(Boolean).join('\n'),
        retrievedAt: ctx.now,
        confidence: isScary ? 0.6 : 0.45,
      });
    }
    return findings;
  },
};
