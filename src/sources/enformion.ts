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
 * Parsing is deliberately CASE-INSENSITIVE and forgiving: the published docs show
 * PascalCase (FullName, PhoneNumbers) but the live API may return camelCase, and
 * a person-check must not silently show nothing just because a key was `fullName`
 * instead of `FullName`. Every accessor tries several spellings.
 */
const ENDPOINT = 'https://devapi.enformion.com/PersonSearch';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

/** Case-insensitive multi-name property lookup. */
function get(obj: any, ...names: string[]): any {
  if (!obj || typeof obj !== 'object') return undefined;
  const map = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const real = map.get(n.toLowerCase());
    if (real !== undefined) return obj[real];
  }
  return undefined;
}

function arr(v: any): Obj[] {
  return Array.isArray(v) ? v : [];
}

function str(v: any): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s && s !== '-0-' ? s : undefined;
}

/** Build a display name from a Name object of unknown casing. */
function nameOf(person: any): string {
  const direct = str(get(person, 'FullName', 'fullName', 'name'));
  if (direct && typeof get(person, 'FullName', 'fullName') === 'string') return direct;
  const n = get(person, 'Name', 'name') ?? person;
  return [
    str(get(n, 'FirstName', 'firstName')),
    str(get(n, 'MiddleName', 'middleName')),
    str(get(n, 'LastName', 'lastName')),
    str(get(n, 'Suffix', 'suffix')),
  ]
    .filter(Boolean)
    .join(' ');
}

/** Enformion "Indicators" are truthy when a record class exists for the person. */
function truthy(v: any): boolean {
  return v === true || v === 'true' || (typeof v === 'number' && v > 0) || (typeof v === 'string' && /^\d+$/.test(v) && Number(v) > 0);
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

    const stateHint = /\b([A-Z]{2})\b/.exec((ctx.hints ?? '').toUpperCase())?.[1];

    const body: Obj = {
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

    if (res.status === 401 || res.status === 403) throw new Error('Enformion rejected the credentials (check AP name/password)');
    if (!res.ok) throw new Error(`Enformion HTTP ${res.status}`);

    const data = (await res.json()) as Obj;
    // Person array can arrive under several keys, or as the root array.
    const people = arr(get(data, 'persons', 'Persons', 'records', 'Records', 'results', 'Results')).length
      ? arr(get(data, 'persons', 'Persons', 'records', 'Records', 'results', 'Results'))
      : Array.isArray(data)
        ? data
        : [];
    if (people.length === 0) return [];

    const p = people[0]!;
    const findings: Finding[] = [];
    const displayName = nameOf(p) || subject.raw;
    const addresses = arr(get(p, 'Addresses', 'addresses'));
    const a0 = addresses[0];
    const where = a0 ? `${str(get(a0, 'City', 'city')) ?? ''} ${str(get(a0, 'State', 'state')) ?? ''}`.trim() : '';
    const age = str(get(p, 'Age', 'age'));
    const dob = str(get(p, 'Dob', 'dob', 'DateOfBirth'));
    const akas = arr(get(p, 'Akas', 'akas', 'AKAs')).map(nameOf).filter(Boolean);

    findings.push({
      source: 'enformion',
      label: 'Identity',
      title: `👤 ${displayName}${age ? `, age ${age}` : ''}`,
      detail: [
        where && `Lives around: ${where}`,
        dob && `DOB on file: ${dob}`,
        akas.length && `Also known as: ${akas.slice(0, 4).join(', ')}`,
        people.length > 1 && `⚠️ ${people.length} people match this name — make sure it’s the right one.`,
      ]
        .filter(Boolean)
        .join('\n'),
      retrievedAt: ctx.now,
      confidence: stateHint ? 0.75 : 0.6,
    });

    // Indicators live under one object of unknown casing; read keys loosely.
    const ind = get(p, 'Indicators', 'indicators') ?? {};
    const indHas = (...keys: string[]) => truthy(get(ind, ...keys));

    const relatives = arr(get(p, 'RelativesSummary', 'relativesSummary', 'Relatives', 'relatives'));
    const spouse = relatives.find((r) => /spouse|wife|husband/i.test(str(get(r, 'Relationship', 'relationship')) ?? ''));

    const relStatus: string[] = [];
    if (indHas('marriages', 'marriage', 'married')) relStatus.push('💍 Marriage record(s) on file');
    if (indHas('divorces', 'divorce', 'divorced')) relStatus.push('💔 Divorce record(s) on file');
    if (spouse) relStatus.push(`💍 Possible spouse: ${nameOf(spouse)}`);
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

    if (relatives.length) {
      const list = relatives
        .map((r) => {
          const nm = nameOf(r);
          const rel = str(get(r, 'Relationship', 'relationship'));
          return nm ? `${nm}${rel ? ` (${rel})` : ''}` : '';
        })
        .filter(Boolean);
      if (list.length) {
        findings.push({
          source: 'enformion',
          label: 'Relatives',
          title: `👨‍👩‍👧 Relatives & family (${list.length})`,
          detail: list.slice(0, 10).join('\n'),
          retrievedAt: ctx.now,
          confidence: 0.6,
        });
      }
    }

    const associates = arr(get(p, 'AssociatesSummary', 'associatesSummary', 'Associates', 'associates')).map(nameOf).filter(Boolean);
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

    const phones = arr(get(p, 'PhoneNumbers', 'phoneNumbers', 'Phones', 'phones'))
      .map((ph) => {
        const num = str(get(ph, 'PhoneNumber', 'phoneNumber', 'number'));
        const type = str(get(ph, 'PhoneType', 'phoneType', 'type'));
        const co = str(get(ph, 'Company', 'company', 'carrier'));
        return num ? `${num}${type ? ` (${type})` : ''}${co ? ` — ${co}` : ''}` : '';
      })
      .filter(Boolean);
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

    const emails = arr(get(p, 'EmailAddresses', 'emailAddresses', 'Emails', 'emails'))
      .map((e) => str(get(e, 'EmailAddress', 'emailAddress', 'email')) ?? (typeof e === 'string' ? e : undefined))
      .filter(Boolean) as string[];
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

    const addrList = addresses
      .map((ad) => str(get(ad, 'FullAddress', 'fullAddress')) ?? `${str(get(ad, 'City', 'city')) ?? ''}, ${str(get(ad, 'State', 'state')) ?? ''}`)
      .filter((s) => s && s !== ', ');
    if (addrList.length) {
      findings.push({
        source: 'enformion',
        label: 'Addresses',
        title: `🏠 Addresses on record (${addrList.length})`,
        detail: addrList.slice(0, 6).join('\n'),
        retrievedAt: ctx.now,
        confidence: 0.55,
      });
    }

    const legal: string[] = [];
    if (indHas('liens', 'lien', 'taxLiens')) legal.push('Tax lien(s) on file');
    if (indHas('judgments', 'judgment')) legal.push('Civil judgment(s) on file');
    if (indHas('bankruptcy', 'bankruptcies')) legal.push('Bankruptcy record(s)');
    if (indHas('criminal', 'criminalRecords')) legal.push('⚠️ Criminal record indicator');
    if (indHas('properties', 'property')) legal.push('Property record(s)');
    if (indHas('vehicles', 'vehicle', 'vehicleRegistrations')) legal.push('Vehicle registration(s)');
    if (legal.length) {
      findings.push({
        source: 'enformion',
        label: 'Financial & legal',
        title: '📋 Financial / legal records',
        detail: [...legal, 'Indicators only — pull the actual record to see details (some are sealed).'].join('\n'),
        retrievedAt: ctx.now,
        confidence: 0.55,
      });
    }

    return findings;
  },
};
