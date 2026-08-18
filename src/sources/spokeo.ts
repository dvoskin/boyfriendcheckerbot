import { config } from '../core/config.js';
import { httpJson } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

/**
 * Spokeo People Intelligence API — deep, LEGAL people search. Phone, email or
 * name → the person's relatives, addresses, aliases, phones, emails and social
 * profiles, aggregated from public records + licensed commercial/telecom data.
 * This is the accessible "eye of god" tier for the US, alongside Enformion.
 *
 * ⚠️ VERIFY-ON-CONNECT: the exact endpoint/response shape is behind Spokeo's
 * account docs, so parsing is deliberately CASE-INSENSITIVE and forgiving (same
 * approach that made Enformion work first-try). Confirm the mapping with one live
 * response once the key is set. Pluggable: skipped unless a key is present.
 */
const BASE = 'https://api.spokeo.com/v1';

/* eslint-disable @typescript-eslint/no-explicit-any */
function get(obj: any, ...names: string[]): any {
  if (!obj || typeof obj !== 'object') return undefined;
  const map = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const real = map.get(n.toLowerCase());
    if (real !== undefined) return obj[real];
  }
  return undefined;
}
const arr = (v: any): any[] => (Array.isArray(v) ? v : v ? [v] : []);
const str = (v: any): string | undefined => {
  const s = v == null ? '' : String(v).trim();
  return s || undefined;
};

export const spokeoSource: Source = {
  id: 'spokeo',
  label: 'Deep search (Spokeo)',
  accepts: ['phone', 'email', 'person'],

  async run(subject, ctx) {
    if (!config.spokeoKey) return null;

    let url: string;
    if (subject.kind === 'phone') url = `${BASE}/phone-search?phone=${encodeURIComponent(subject.value.replace(/[^\d+]/g, ''))}`;
    else if (subject.kind === 'email') url = `${BASE}/email-search?email=${encodeURIComponent(subject.value)}`;
    else {
      const parts = subject.value.trim().split(/\s+/);
      if (parts.length < 2) return null;
      const st = subject.hints ? `&state=${encodeURIComponent(subject.hints)}` : '';
      url = `${BASE}/name-search?first_name=${encodeURIComponent(parts[0]!)}&last_name=${encodeURIComponent(parts[parts.length - 1]!)}${st}`;
    }

    const data = await httpJson<any>(url, {
      timeoutMs: 12_000,
      cacheTtl: 86_400,
      headers: { Authorization: `Bearer ${config.spokeoKey}`, Accept: 'application/json' },
    });

    const people = arr(get(data, 'people', 'results', 'records', 'data'));
    const p = people[0] ?? (get(data, 'person') || data);
    if (!p || typeof p !== 'object') return [];

    const name = str(get(p, 'full_name', 'fullName', 'name'));
    const relatives = arr(get(p, 'relatives', 'family')).map((r) => str(get(r, 'full_name', 'fullName', 'name')) ?? (typeof r === 'string' ? r : undefined)).filter(Boolean);
    const addresses = arr(get(p, 'addresses', 'address_history')).map((a) => str(get(a, 'full_address', 'display', 'line')) ?? (typeof a === 'string' ? a : undefined)).filter(Boolean);
    const phones = arr(get(p, 'phones', 'phone_numbers')).map((ph) => str(get(ph, 'number', 'display')) ?? (typeof ph === 'string' ? ph : undefined)).filter(Boolean);
    const emails = arr(get(p, 'emails', 'email_addresses')).map((e) => str(get(e, 'address', 'email')) ?? (typeof e === 'string' ? e : undefined)).filter(Boolean);
    const aliases = arr(get(p, 'aliases', 'aka', 'akas')).map((a) => str(a?.name ?? a)).filter(Boolean);

    if (!name && relatives.length === 0 && phones.length === 0) return [];

    const findings: Finding[] = [
      {
        source: 'spokeo',
        label: 'Deep search',
        title: `🔮 ${name ?? 'Match found'}${get(p, 'age') ? `, age ${get(p, 'age')}` : ''}`,
        detail: [
          aliases.length && `Also known as: ${aliases.slice(0, 4).join(', ')}`,
          addresses.length && `Addresses:\n${addresses.slice(0, 4).join('\n')}`,
          phones.length && `Phones: ${phones.slice(0, 5).join(', ')}`,
          emails.length && `Emails: ${emails.slice(0, 5).join(', ')}`,
          relatives.length && `Relatives: ${relatives.slice(0, 8).join(', ')}`,
          'Public-records data — confirm it’s the right person.',
        ]
          .filter(Boolean)
          .join('\n'),
        retrievedAt: ctx.now,
        confidence: subject.hints || subject.kind !== 'person' ? 0.7 : 0.55,
      },
    ];
    return findings;
  },
};
