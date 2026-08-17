import { config } from '../core/config.js';
import type { Finding, Source, Subject } from '../core/types.js';

/**
 * Enformion / EnformionGO (formerly Endato) Person Search — the deep-background
 * layer. One name lookup returns the personal-records data the free web can't:
 * relatives and spouse, marriage/divorce indicators, current and past addresses,
 * phones, emails, and civil records (liens, judgments, bankruptcies).
 *
 * This is licensed public-records aggregation — legal, but it is the reason the
 * consent gate exists: results must not drive employment/housing/credit
 * decisions (FCRA). ~$0.35 per match. Pluggable: skipped unless creds are set.
 *
 * Aggregators return the WRONG person surprisingly often on common names, so
 * matches are shown as strong-but-unconfirmed and always paired with the age/
 * location so the reader can sanity-check it is really him.
 */
const ENDPOINT = 'https://devapi.enformion.com/PersonSearch';

interface EnfName {
  Prefix?: string;
  FirstName?: string;
  MiddleName?: string;
  LastName?: string;
  Suffix?: string;
}
interface EnfAddress {
  FullAddress?: string;
  City?: string;
  State?: string;
  FirstReportedDate?: string;
  LastReportedDate?: string;
}
interface EnfPhone {
  PhoneNumber?: string;
  PhoneType?: string;
  Company?: string;
  IsConnected?: boolean;
}
interface EnfEmail {
  EmailAddress?: string;
}
interface EnfRelative {
  Name?: EnfName;
  FullName?: string;
  Relationship?: string;
}
interface EnfIndicators {
  marriages?: boolean | number;
  divorces?: boolean | number;
  liens?: boolean | number;
  judgments?: boolean | number;
  bankruptcy?: boolean | number;
  properties?: boolean | number;
  vehicles?: boolean | number;
  criminal?: boolean | number;
  deathRecords?: boolean | number;
  [k: string]: unknown;
}
interface EnfPerson {
  FullName?: string;
  Name?: EnfName;
  Age?: number | string;
  Dob?: string;
  Addresses?: EnfAddress[];
  PhoneNumbers?: EnfPhone[];
  EmailAddresses?: EnfEmail[];
  RelativesSummary?: EnfRelative[];
  AssociatesSummary?: EnfRelative[];
  Akas?: EnfName[];
  Indicators?: EnfIndicators;
}
interface EnfResponse {
  persons?: EnfPerson[];
  Persons?: EnfPerson[];
}

function fullName(n?: EnfName): string {
  if (!n) return '';
  return [n.FirstName, n.MiddleName, n.LastName, n.Suffix].filter(Boolean).join(' ');
}

/** Enformion "Indicators" are truthy when a record class exists for the person. */
function has(v: unknown): boolean {
  return v === true || (typeof v === 'number' && v > 0);
}

function nameParts(subject: Subject): { first: string; last: string; middle?: string } | null {
  const parts = subject.value.trim().split(/\s+/);
  if (parts.length < 2) return null;
  return { first: parts[0]!, last: parts[parts.length - 1]!, middle: parts.length > 2 ? parts[1] : undefined };
}

export const enformionSource: Source = {
  id: 'enformion',
  label: 'Deep background',
  accepts: ['person'],

  async run(subject, ctx) {
    if (!config.enformionName || !config.enformionPassword) return null;
    const np = nameParts(subject);
    if (!np) return null;

    // A US state hint sharply reduces wrong-person matches on common names.
    const stateHint = /\b([A-Z]{2})\b/.exec((ctx.hints ?? '').toUpperCase())?.[1];

    const body: Record<string, unknown> = {
      FirstName: np.first,
      LastName: np.last,
      ...(np.middle ? { MiddleName: np.middle } : {}),
      ...(stateHint ? { Addresses: [{ State: stateHint }] } : {}),
    };

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'galaxy-ap-name': config.enformionName,
        'galaxy-ap-password': config.enformionPassword,
        'galaxy-search-type': 'Person',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) throw new Error(`Enformion HTTP ${res.status}`);
    const data = (await res.json()) as EnfResponse;
    const people = data.persons ?? data.Persons ?? [];
    if (people.length === 0) return [];

    // Multiple people can share a name; take the first (Enformion ranks the best
    // match first) but flag when there is more than one so the reader stays wary.
    const p = people[0]!;
    const findings: Finding[] = [];
    const displayName = p.FullName || fullName(p.Name) || subject.raw;
    const where = p.Addresses?.[0] ? `${p.Addresses[0].City ?? ''} ${p.Addresses[0].State ?? ''}`.trim() : '';

    findings.push({
      source: 'enformion',
      label: 'Identity',
      title: `👤 ${displayName}${p.Age ? `, age ${p.Age}` : ''}`,
      detail: [
        where && `Lives around: ${where}`,
        p.Dob && `DOB on file: ${p.Dob}`,
        p.Akas?.length && `Also known as: ${p.Akas.map(fullName).filter(Boolean).slice(0, 4).join(', ')}`,
        people.length > 1 && `⚠️ ${people.length} people match this name — make sure it’s the right one.`,
      ]
        .filter(Boolean)
        .join('\n'),
      retrievedAt: ctx.now,
      confidence: stateHint ? 0.75 : 0.6,
    });

    // Marriage / divorce — the "is he married?" answer, plus relationships.
    const ind = p.Indicators ?? {};
    const relStatus: string[] = [];
    if (has(ind.marriages)) relStatus.push('💍 Marriage record(s) on file');
    if (has(ind.divorces)) relStatus.push('💔 Divorce record(s) on file');
    const spouse = p.RelativesSummary?.find((r) => /spouse|wife|husband/i.test(r.Relationship ?? ''));
    if (spouse) relStatus.push(`💍 Possible spouse: ${spouse.FullName || fullName(spouse.Name)}`);
    if (relStatus.length) {
      findings.push({
        source: 'enformion',
        label: 'Relationship status',
        title: relStatus[0]!,
        detail: [relStatus.slice(1).join('\n'), 'Public records — confirm before believing it.'].filter(Boolean).join('\n'),
        retrievedAt: ctx.now,
        confidence: 0.6,
      });
    }

    // Relatives & associates → family, kids, connections.
    const relatives = (p.RelativesSummary ?? []).map((r) => `${r.FullName || fullName(r.Name)}${r.Relationship ? ` (${r.Relationship})` : ''}`).filter(Boolean);
    if (relatives.length) {
      findings.push({
        source: 'enformion',
        label: 'Relatives',
        title: `👨‍👩‍👧 Relatives & family (${relatives.length})`,
        detail: relatives.slice(0, 10).join('\n'),
        retrievedAt: ctx.now,
        confidence: 0.6,
      });
    }
    const associates = (p.AssociatesSummary ?? []).map((r) => r.FullName || fullName(r.Name)).filter(Boolean);
    if (associates.length) {
      findings.push({
        source: 'enformion',
        label: 'Associates',
        title: `🔗 Known associates (${associates.length})`,
        detail: associates.slice(0, 8).join('\n'),
        retrievedAt: ctx.now,
        confidence: 0.5,
      });
    }

    // Contact.
    const phones = (p.PhoneNumbers ?? []).map((ph) => `${ph.PhoneNumber}${ph.PhoneType ? ` (${ph.PhoneType})` : ''}${ph.Company ? ` — ${ph.Company}` : ''}`).filter(Boolean);
    if (phones.length) {
      findings.push({
        source: 'enformion',
        label: 'Phones',
        title: `📱 Phone numbers (${phones.length})`,
        detail: phones.slice(0, 6).join('\n'),
        retrievedAt: ctx.now,
        confidence: 0.6,
      });
    }
    const emails = (p.EmailAddresses ?? []).map((e) => e.EmailAddress).filter(Boolean) as string[];
    if (emails.length) {
      findings.push({
        source: 'enformion',
        label: 'Emails',
        title: `📧 Emails (${emails.length})`,
        detail: emails.slice(0, 6).join('\n'),
        retrievedAt: ctx.now,
        confidence: 0.6,
      });
    }

    // Addresses (current + history).
    const addrs = (p.Addresses ?? []).map((a) => a.FullAddress || `${a.City ?? ''}, ${a.State ?? ''}`).filter((s) => s && s !== ', ');
    if (addrs.length) {
      findings.push({
        source: 'enformion',
        label: 'Addresses',
        title: `🏠 Addresses on record (${addrs.length})`,
        detail: addrs.slice(0, 6).join('\n'),
        retrievedAt: ctx.now,
        confidence: 0.55,
      });
    }

    // Money/legal — the closest legal proxy for "alimony and so on".
    const legal: string[] = [];
    if (has(ind.liens)) legal.push('Tax lien(s) on file');
    if (has(ind.judgments)) legal.push('Civil judgment(s) on file');
    if (has(ind.bankruptcy)) legal.push('Bankruptcy record(s)');
    if (has(ind.criminal)) legal.push('⚠️ Criminal record indicator');
    if (has(ind.properties)) legal.push('Property record(s)');
    if (has(ind.vehicles)) legal.push('Vehicle registration(s)');
    if (legal.length) {
      findings.push({
        source: 'enformion',
        label: 'Financial & legal',
        title: `📋 Financial / legal records`,
        detail: [...legal, 'Indicators only — pull the actual record to see details (some are sealed).'].join('\n'),
        retrievedAt: ctx.now,
        confidence: 0.55,
      });
    }

    return findings;
  },
};
