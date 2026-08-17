import { httpJson } from '../core/http.js';
import { firstNameMatches, stateFromHint } from '../core/names.js';
import type { Finding, Source } from '../core/types.js';

/**
 * NPPES is the CMS registry of every US healthcare provider with an NPI — about
 * 8M records, no auth, no key. It is unusually strong for identity work because
 * each record ties a legal name to a practice address, a taxonomy and, crucially,
 * a state license number.
 *
 * The full monthly dissemination file is also public; load that locally when
 * per-request latency starts to matter.
 */
const API = 'https://npiregistry.cms.hhs.gov/api/';

interface Address {
  address_purpose: string;
  address_1?: string;
  address_2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  telephone_number?: string;
  fax_number?: string;
}

interface Taxonomy {
  code?: string;
  desc?: string;
  primary?: boolean;
  state?: string;
  license?: string;
}

interface Basic {
  first_name?: string;
  last_name?: string;
  middle_name?: string;
  credential?: string;
  sole_proprietor?: string;
  gender?: string;
  enumeration_date?: string;
  status?: string;
  organization_name?: string;
  authorized_official_first_name?: string;
  authorized_official_last_name?: string;
  authorized_official_title_or_position?: string;
  authorized_official_telephone_number?: string;
}

interface Result {
  number: number;
  enumeration_type?: string;
  basic: Basic;
  addresses?: Address[];
  taxonomies?: Taxonomy[];
}

interface ApiResponse {
  result_count?: number;
  results?: Result[];
  Errors?: { description: string }[];
}

function fmtAddress(a: Address): string {
  return [a.address_1, a.address_2, a.city, a.state, a.postal_code]
    .filter(Boolean)
    .join(', ');
}


export const nppesSource: Source = {
  id: 'nppes',
  label: 'NPPES (healthcare providers)',
  accepts: ['person', 'company'],

  async run(subject, ctx) {
    const params = new URLSearchParams({ version: '2.1', limit: '20' });
    const parts = subject.value.trim().split(/\s+/);
    const first = parts[0]!.toLowerCase();
    const middle = parts.length > 2 ? parts[1]!.toLowerCase() : undefined;
    const last = parts[parts.length - 1]!.toLowerCase();

    if (subject.kind === 'person') {
      if (parts.length < 2) return null;
      params.set('first_name', parts[0]!);
      params.set('last_name', parts[parts.length - 1]!);
    } else {
      params.set('organization_name', subject.value.trim());
    }

    const state = stateFromHint(ctx.hints);
    if (state) params.set('state', state);

    const res = await httpJson<ApiResponse>(`${API}?${params}`, {
      timeoutMs: 7000,
      cacheTtl: 86_400,
    });

    if (res.Errors?.length) {
      throw new Error(res.Errors.map((e) => e.description).join('; '));
    }
    if (!res.results?.length) return [];

    // Narrow to the real person: nickname-match the first name, and if a middle
    // name was given, require it too. This kills the "8 random Ebony Jacksons".
    if (subject.kind === 'person') {
      res.results = res.results.filter((r) => {
        const bf = (r.basic.first_name ?? '').toLowerCase();
        const bm = (r.basic.middle_name ?? '').toLowerCase();
        if (!firstNameMatches(first, bf)) return false;
        if (middle && bm && !bm.startsWith(middle) && !middle.startsWith(bm)) return false;
        return true;
      });
      if (res.results.length === 0) return [];
      // Still ambiguous (common name, no city) → summarise instead of listing strangers.
      if (res.results.length > 4 && !state) {
        return [
          {
            source: 'nppes',
            label: 'NPPES',
            title: `${res.results.length}+ healthcare providers named ${subject.raw}`,
            detail: 'Too many to tell apart — add a city (e.g. "Name | FL") to find the right one.',
            url: `https://npiregistry.cms.hhs.gov/search?first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(last)}`,
            retrievedAt: ctx.now,
            confidence: 0.3,
          },
        ];
      }
    }

    return res.results.slice(0, 8).map((r): Finding => {
      const b = r.basic;
      const name =
        b.organization_name ??
        [b.first_name, b.middle_name, b.last_name].filter(Boolean).join(' ');
      const primary = r.taxonomies?.find((t) => t.primary) ?? r.taxonomies?.[0];
      const location = r.addresses?.find((a) => a.address_purpose === 'LOCATION');

      const detail = [
        `NPI ${r.number}${b.status === 'A' ? ' (active)' : ''}`,
        b.credential && `Credential: ${b.credential}`,
        primary?.desc && `Specialty: ${primary.desc}`,
        // The license number + state pair is the handoff into state professional
        // license boards, which is where disciplinary history lives.
        primary?.license && `License: ${primary.license} (${primary.state ?? '?'})`,
        location && `Practice: ${fmtAddress(location)}`,
        location?.telephone_number && `Phone: ${location.telephone_number}`,
        b.authorized_official_last_name &&
          `Authorized official: ${b.authorized_official_first_name ?? ''} ${b.authorized_official_last_name} ${
            b.authorized_official_title_or_position
              ? `(${b.authorized_official_title_or_position})`
              : ''
          }`.trim(),
        b.enumeration_date && `Enumerated: ${b.enumeration_date}`,
      ]
        .filter(Boolean)
        .join('\n');

      return {
        source: 'nppes',
        label: 'NPPES',
        title: name || `NPI ${r.number}`,
        detail,
        url: `https://npiregistry.cms.hhs.gov/provider-view/${r.number}`,
        retrievedAt: ctx.now,
        confidence: state ? 0.8 : 0.6,
        extra: { npi: r.number, license: primary?.license, licenseState: primary?.state },
      };
    });
  },
};
