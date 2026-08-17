import { tryCharge } from '../core/budget.js';
import { config } from '../core/config.js';
import { firstNameMatches, stateFromHint } from '../core/names.js';
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

export interface Candidate {
  name: string;
  age?: string;
  city?: string;
  state?: string;
}

/**
 * Cheap candidate lookup (Teaser search) for disambiguation: given a name with
 * no city, list the distinct people who match so the user can pick the right one
 * BEFORE we spend a full deep-search credit on the wrong person.
 */
export async function enformionCandidates(fullName: string): Promise<Candidate[] | null> {
  if (!config.enformionName || !config.enformionPassword) return null;
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return null;

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'galaxy-ap-name': config.enformionName,
        'galaxy-ap-password': config.enformionPassword,
        'galaxy-search-type': 'Teaser',
      },
      body: JSON.stringify({ FirstName: parts[0], LastName: parts[parts.length - 1] }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Obj;
    const people = arr(get(data, 'persons', 'Persons', 'records', 'Records', 'results', 'Results'));

    const seen = new Set<string>();
    const out: Candidate[] = [];
    for (const p of people) {
      const a0 = arr(get(p, 'Addresses', 'addresses'))[0];
      const city = str(get(a0, 'City', 'city'));
      const state = str(get(a0, 'State', 'state'));
      const name = nameOf(p);
      const age = str(get(p, 'Age', 'age'));
      const key = `${name}|${city}|${state}`.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      out.push({ name, age, city, state });
      if (out.length >= 6) break;
    }
    return out;
  } catch {
    return null;
  }
}

export const enformionSource: Source = {
  id: 'enformion',
  label: 'Deep background',
  accepts: ['person'],

  async run(subject, ctx) {
    if (!config.enformionName || !config.enformionPassword) return null;
    const np = nameParts(subject);
    if (!np) return null;

    // Respect the daily spend cap — deep background is the priciest source.
    if (!(await tryCharge('enformion'))) {
      return [
        {
          source: 'enformion',
          label: 'Deep background',
          title: '🔒 Deep background paused (daily budget reached)',
          detail: 'The daily spend cap for paid data was hit. It resets tomorrow, or raise DAILY_SPEND_CAP_USD.',
          retrievedAt: ctx.now,
          confidence: 0.3,
        },
      ];
    }

    const stateHint = stateFromHint(ctx.hints);

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

    // Wrong-person guard. Aggregators fall back to a "closest" record when there
    // is no real match — which is how a search for "Ariel Voskin" returned
    // "Michael Voskian" and showed a stranger's family and emails as his. The
    // first name is the reliable discriminator: Daniel→Daniel is fine (a last
    // name can be anglicised), but Ariel→Michael is a different human. If the
    // first name doesn't line up, refuse to present the record.
    const returnedFirst = (str(get(get(p, 'Name', 'name'), 'FirstName', 'firstName')) ?? displayName.split(/\s+/)[0] ?? '').toLowerCase();
    // Nickname-aware: "Mike" matches "Mikhail"/"Michael", "Dan" matches "Daniel".
    const firstOk = !returnedFirst || firstNameMatches(np.first, returnedFirst);
    if (!firstOk) {
      return [
        {
          source: 'enformion',
          label: 'Deep background',
          title: `🤷‍♀️ No confident records match for ${subject.raw}`,
          detail: `The closest record is a different person (${displayName}) — so I’m NOT showing their family, phones or addresses as his. Try adding his state (e.g. "${subject.raw} | NY") or his exact legal name.`,
          retrievedAt: ctx.now,
          confidence: 0.4,
        },
      ];
    }
    const addresses = arr(get(p, 'Addresses', 'addresses'));
    const a0 = addresses[0];
    const where = a0 ? `${str(get(a0, 'City', 'city')) ?? ''} ${str(get(a0, 'State', 'state')) ?? ''}`.trim() : '';
    const age = str(get(p, 'Age', 'age'));
    const dob = str(get(p, 'Dob', 'dob', 'DateOfBirth'));
    const akas = arr(get(p, 'Akas', 'akas', 'AKAs')).map(nameOf).filter(Boolean);

    findings.push({
      source: 'enformion',
      label: 'Identity',
      title: `👤 His real name: ${displayName}${age ? `, age ${age}` : ''}`,
      detail: [
        where && `Lives in: ${where}`,
        dob && `Birthday on file: ${dob}`,
        akas.length && `Also goes by: ${akas.slice(0, 4).join(', ')}`,
        people.length > 1 && `⚠️ ${people.length} people match this name — make sure it’s the right one.`,
      ]
        .filter(Boolean)
        .join('\n'),
      retrievedAt: ctx.now,
      confidence: stateHint ? 0.75 : 0.6,
      extra: { age, city: where },
    });

    // Indicators live under one object of unknown casing; read keys loosely.
    const ind = get(p, 'Indicators', 'indicators') ?? {};
    const indHas = (...keys: string[]) => truthy(get(ind, ...keys));

    const relatives = arr(get(p, 'RelativesSummary', 'relativesSummary', 'Relatives', 'relatives'));
    const relOf = (r: any) => str(get(r, 'Relationship', 'relationship', 'RelationshipType', 'relationshipType'));
    const spouse = relatives.find((r) => /spouse|wife|husband/i.test(relOf(r) ?? ''));

    // Always answer "is he married?" explicitly — even a clean result is useful.
    const marriedRec = indHas('marriages', 'marriage', 'married') || Boolean(spouse);
    const divorcedRec = indHas('divorces', 'divorce', 'divorced');
    const statusLine = marriedRec
      ? spouse
        ? `💍 Marriage record found — possible spouse: ${nameOf(spouse)}`
        : '💍 Marriage record on file'
      : '💚 No marriage record surfaced';
    findings.push({
      source: 'enformion',
      label: 'Relationship status',
      title: statusLine,
      detail: [
        divorcedRec && '💔 Divorce record also on file',
        !marriedRec && 'No public marriage record came up — this does NOT fully rule it out (records lag and vary by state).',
        'Public records — confirm before believing it.',
      ]
        .filter(Boolean)
        .join('\n'),
      retrievedAt: ctx.now,
      confidence: 0.55,
      extra: { status: divorcedRec ? 'divorced' : marriedRec ? 'married' : 'single' },
    });

    if (relatives.length) {
      const relSeen = new Set<string>();
      const list = relatives
        .map((r) => {
          const nm = nameOf(r);
          const rel = relOf(r);
          const age = str(get(r, 'Age', 'age'));
          const tag = [rel, age && `age ${age}`].filter(Boolean).join(', ');
          return nm ? `${nm}${tag ? ` — ${tag}` : ''}` : '';
        })
        .filter((s) => s && !relSeen.has(s.toLowerCase()) && relSeen.add(s.toLowerCase()));
      if (list.length) {
        findings.push({
          source: 'enformion',
          label: 'Relatives',
          title: `👨‍👩‍👧 His family (${list.length})`,
          detail: [list.slice(0, 12).join('\n'), 'Same last name usually = parents/siblings. A much younger one could be a kid — worth noticing.'].join('\n'),
          retrievedAt: ctx.now,
          confidence: 0.6,
        });
      }
    }

    const assocSeen = new Set<string>();
    const associates = arr(get(p, 'AssociatesSummary', 'associatesSummary', 'Associates', 'associates'))
      .map(nameOf)
      .filter((s) => s && !assocSeen.has(s.toLowerCase()) && assocSeen.add(s.toLowerCase()));
    if (associates.length) {
      findings.push({
        source: 'enformion',
        label: 'Associates',
        title: `👯‍♀️ People in his circle (${associates.length})`,
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
        title: `📱 His phone numbers (${phones.length})`,
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
        title: `📧 His emails (${emails.length})`,
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
        title: `🏠 Places he's lived (${addrList.length})`,
        detail: addrList.slice(0, 6).join('\n'),
        retrievedAt: ctx.now,
        confidence: 0.55,
      });
    }

    // Criminal + court indicators are SAFETY signals — surface them separately so
    // the report routes them into "Is he safe?", not buried in background.
    const criminal: string[] = [];
    if (indHas('criminal', 'criminalRecords')) criminal.push('⚠️ Criminal record on file');
    if (indHas('judgments', 'judgment')) criminal.push('Civil judgment(s) against him');
    if (indHas('sexualOffenses', 'sexOffender', 'sexOffenses')) criminal.push('🔴 Sex-offense record indicator');
    if (criminal.length) {
      findings.push({
        source: 'enformion',
        label: 'Criminal record',
        title: criminal[0]!.startsWith('🔴') || criminal[0]!.startsWith('⚠️') ? `🔴 ${criminal[0]!.replace(/^[🔴⚠️]\s*/, '')}` : `🔴 ${criminal[0]}`,
        detail: [...criminal.slice(1), 'Public-records indicator — pull the actual case to confirm (some are sealed). Verify it’s him.'].filter(Boolean).join('\n'),
        retrievedAt: ctx.now,
        confidence: 0.55,
      });
    }

    // Money/assets stay in the background section.
    const legal: string[] = [];
    if (indHas('liens', 'lien', 'taxLiens')) legal.push('Tax lien(s) on file');
    if (indHas('bankruptcy', 'bankruptcies')) legal.push('Bankruptcy record(s)');
    if (indHas('properties', 'property')) legal.push('Owns property (records on file)');
    if (indHas('vehicles', 'vehicle', 'vehicleRegistrations')) legal.push('Vehicle registration(s)');
    if (indHas('business', 'businesses')) legal.push('Business ownership on file');
    if (legal.length) {
      findings.push({
        source: 'enformion',
        label: 'Money & assets',
        title: '💰 Money &amp; assets',
        detail: [...legal, 'Indicators only — confirm before believing.'].join('\n'),
        retrievedAt: ctx.now,
        confidence: 0.55,
      });
    }

    return findings;
  },
};
