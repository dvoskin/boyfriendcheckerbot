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

    const p0 = people[0]!;
    const findings = parseEnformionPerson(p0, ctx, {
      subjectRaw: subject.raw,
      np,
      peopleCount: people.length,
      stateHint,
    });

    // PersonSearch only returns yes/no indicators — so when it flags a marriage or
    // criminal record, hit the DEDICATED endpoint to fetch the actual details.
    // Gated on the indicator so we only spend the extra call when there's a hit.
    const hasIdentity = findings.some((f) => f.label === 'Identity');
    if (hasIdentity && np) {
      const ind = get(p0, 'indicators', 'Indicators') ?? {};
      const iHas = (...k: string[]) => truthy(get(ind, ...k));
      if (iHas('marriages', 'marriage', 'married', 'divorces', 'divorce')) {
        findings.push(...(await marriageDetails(np, stateHint, ctx).catch(() => [])));
      }
      if (iHas('criminal', 'criminalRecords', 'sexualOffenses', 'sexOffender')) {
        findings.push(...(await criminalDetails(np, stateHint, ctx).catch(() => [])));
      }
    }
    return findings;
  },
};

/** Raw POST to an Enformion endpoint, tolerant of unknown paths/search-types. */
async function enformionRaw(paths: string[], searchTypes: string[], body: Obj): Promise<Obj | null> {
  for (const path of paths) {
    for (const st of searchTypes) {
      let res: Response;
      try {
        res = await fetch(`https://devapi.enformion.com${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'galaxy-ap-name': config.enformionName!,
            'galaxy-ap-password': config.enformionPassword!,
            'galaxy-search-type': st,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        continue;
      }
      if (res.ok) return (await res.json().catch(() => null)) as Obj | null;
      // 404 (wrong path) / 400-403 (wrong search-type) → try the next combo.
    }
  }
  return null;
}

/** Dedicated Marriage + Divorce search → actual spouse names, dates, county. */
async function marriageDetails(np: { first: string; last: string; middle?: string }, state: string | null | undefined, ctx: { now: string }): Promise<Finding[]> {
  const body: Obj = { FirstName: np.first, LastName: np.last, ...(np.middle ? { MiddleName: np.middle } : {}), ...(state ? { State: state } : {}) };
  const spouseOf = (r: any) =>
    str(get(r, 'SpouseName', 'spouseName')) ||
    str(get(r, 'BrideName', 'brideName')) ||
    str(get(r, 'GroomName', 'groomName')) ||
    arr(get(r, 'Names', 'names', 'Parties', 'parties')).map(nameOf).filter(Boolean).join(' & ') ||
    nameOf(get(r, 'Spouse', 'spouse'));
  const dateOf = (r: any) => str(get(r, 'MarriageDate', 'marriageDate', 'DivorceDate', 'divorceDate', 'Date', 'date', 'RecordingDate'));
  const placeOf = (r: any) => [str(get(r, 'CountyName', 'countyName', 'County', 'county')), str(get(r, 'State', 'state'))].filter(Boolean).join(', ');

  const out: Finding[] = [];
  const mData = await enformionRaw(['/MarriageSearch', '/Marriage/Search', '/Marriage'], ['Marriage', 'DevAPIMarriage', 'MarriageSearch'], body);
  const marriages = arr(get(mData ?? {}, 'marriages', 'Marriages', 'records', 'Records', 'results', 'Results', 'data'));
  const mLines = marriages.map((m) => [spouseOf(m) && `💍 to ${spouseOf(m)}`, dateOf(m) && `on ${dateOf(m)}`, placeOf(m) && `in ${placeOf(m)}`].filter(Boolean).join(' ')).filter(Boolean);

  const dData = await enformionRaw(['/DivorceSearch', '/Divorce/Search', '/Divorce'], ['Divorce', 'DevAPIDivorce', 'DivorceSearch'], body);
  const divorces = arr(get(dData ?? {}, 'divorces', 'Divorces', 'records', 'Records', 'results', 'Results', 'data'));
  const dLines = divorces.map((d) => [spouseOf(d) && `💔 from ${spouseOf(d)}`, dateOf(d) && `on ${dateOf(d)}`, placeOf(d) && `in ${placeOf(d)}`].filter(Boolean).join(' ')).filter(Boolean);

  if (mLines.length || dLines.length) {
    out.push({
      source: 'enformion',
      label: 'Relationship status',
      title: mLines.length ? `💍 Marriage record${mLines.length > 1 ? 's' : ''} found (${mLines.length})` : '💔 Divorce record on file',
      detail: [...mLines.slice(0, 5), ...dLines.slice(0, 5), 'From the marriage/divorce index — confirm names and dates match.'].join('\n'),
      retrievedAt: ctx.now,
      confidence: 0.72,
      extra: { status: mLines.length ? 'married' : 'divorced' },
    });
  }
  return out;
}

/** Dedicated Criminal search → actual offenses, dates, states. */
async function criminalDetails(np: { first: string; last: string; middle?: string }, state: string | null | undefined, ctx: { now: string }): Promise<Finding[]> {
  const body: Obj = { FirstName: np.first, LastName: np.last, ...(np.middle ? { MiddleName: np.middle } : {}), ...(state ? { State: state } : {}) };
  const data = await enformionRaw(['/CriminalSearch', '/CriminalSearchV2', '/Criminal/Search', '/Criminal'], ['Criminal', 'CriminalV2', 'DevAPICriminalV2', 'DevAPICriminal'], body);
  const recs = arr(get(data ?? {}, 'criminalRecords', 'CriminalRecords', 'criminals', 'Criminals', 'records', 'Records', 'results', 'Results', 'offenses', 'data'));
  const lines = recs
    .map((c) => {
      const off = str(get(c, 'Offense', 'offense', 'OffenseDescription', 'offenseDescription', 'Charge', 'charge', 'Category', 'category'));
      const date = str(get(c, 'OffenseDate', 'offenseDate', 'ArrestDate', 'arrestDate', 'DispositionDate', 'Date', 'date'));
      const st = str(get(c, 'OffenseState', 'offenseState', 'State', 'state'));
      return [off ?? 'Offense', date && `(${date})`, st].filter(Boolean).join(' ');
    })
    .filter(Boolean);
  if (!lines.length) return [];
  return [
    {
      source: 'enformion',
      label: 'Criminal record',
      title: `🔴 ${recs.length} criminal record(s) found`,
      detail: [...lines.slice(0, 8), 'From the criminal index — pull the actual case to confirm (some are sealed). Verify it’s the right person.'].join('\n'),
      retrievedAt: ctx.now,
      confidence: 0.72,
    },
  ];
}

/**
 * Turn ONE Enformion person record into report findings — shared by Person
 * Search, Reverse Phone and Contact (email) enrichment, so every search type
 * returns the same rich marriage / criminal / relatives / phones / emails data.
 */
export function parseEnformionPerson(
  p: Obj,
  ctx: { now: string },
  opts: { subjectRaw: string; np?: { first: string; last: string; middle?: string }; peopleCount: number; stateHint?: string | null },
): Finding[] {
  const findings: Finding[] = [];
  const displayName = nameOf(p) || opts.subjectRaw;

    // Honor Enformion's own opt-out flag — if the subject removed themselves at
    // the source, show nothing (compliance).
    if (truthy(get(p, 'isOptedOut', 'IsOptedOut')) || truthy(get(p, 'isEnterpriseOptedOut'))) {
      return [
        {
          source: 'enformion',
          label: 'Deep background',
          title: '🛡️ This person opted out of public-records lookups',
          detail: 'They removed themselves from the data source, so their detailed profile isn’t available.',
          retrievedAt: ctx.now,
          confidence: 0.5,
        },
      ];
    }

    // Wrong-person guard. Aggregators fall back to a "closest" record when there
    // is no real match — which is how a search for "Ariel Voskin" returned
    // "Michael Voskian" and showed a stranger's family and emails as his. The
    // first name is the reliable discriminator: Daniel→Daniel is fine (a last
    // name can be anglicised), but Ariel→Michael is a different human. If the
    // first name doesn't line up, refuse to present the record.
    const returnedFirst = (str(get(get(p, 'Name', 'name'), 'FirstName', 'firstName')) ?? displayName.split(/\s+/)[0] ?? '').toLowerCase();
    // Wrong-person guard only applies to NAME searches (we have a name to match).
    // Phone/email searches have no name to compare, so we trust the top match.
    const firstOk = !opts.np || !returnedFirst || firstNameMatches(opts.np.first, returnedFirst);
    if (!firstOk) {
      return [
        {
          source: 'enformion',
          label: 'Deep background',
          title: `🤷‍♀️ No confident records match for ${opts.subjectRaw}`,
          detail: `The closest record is a different person (${displayName}) — so I’m NOT showing their family, phones or addresses as theirs. Try adding a state (e.g. "${opts.subjectRaw} | NY") or the exact legal name.`,
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
    const akaSeen = new Set<string>();
    const akas = [...arr(get(p, 'Akas', 'akas', 'AKAs')), ...arr(get(p, 'MergedNames', 'mergedNames'))]
      .map(nameOf)
      .filter((n) => n && n.toLowerCase() !== displayName.toLowerCase() && !akaSeen.has(n.toLowerCase()) && akaSeen.add(n.toLowerCase()));

    // Death record on a supposedly-live match = classic stolen/reused identity.
    const deaths = arr(get(p, 'DatesOfDeath', 'datesOfDeath'));
    if (deaths.length) {
      findings.push({
        source: 'enformion',
        label: 'Criminal record', // routes into the Safety bucket
        title: '⚰️ 🔴 A death record is on file for this identity',
        detail: 'If the person you’re talking to is alive, their identity may be stolen or reused — a serious catfish/scam red flag. Confirm with a live video call.',
        retrievedAt: ctx.now,
        confidence: 0.6,
      });
    }

    findings.push({
      source: 'enformion',
      label: 'Identity',
      title: `👤 Real name: ${displayName}${age ? `, age ${age}` : ''}`,
      detail: [
        where && `Lives in: ${where}`,
        dob && `Birthday on file: ${dob}`,
        akas.length && `Also goes by: ${akas.slice(0, 4).join(', ')}`,
        opts.peopleCount > 1 && `⚠️ ${opts.peopleCount} people match this name — make sure it’s the right one.`,
      ]
        .filter(Boolean)
        .join('\n'),
      retrievedAt: ctx.now,
      confidence: opts.stateHint ? 0.75 : 0.6,
      extra: { age, city: where },
    });

    // Indicators live under one object of unknown casing; read keys loosely.
    const ind = get(p, 'Indicators', 'indicators') ?? {};
    const indHas = (...keys: string[]) => truthy(get(ind, ...keys));

    const relatives = arr(get(p, 'RelativesSummary', 'relativesSummary', 'Relatives', 'relatives'));
    const relOf = (r: any) => str(get(r, 'Relationship', 'relationship', 'RelationshipType', 'relationshipType'));
    const spouse = relatives.find((r) => /spouse|wife|husband/i.test(relOf(r) ?? ''));

    // Enformion often lists a spouse as a plain "relative" with no relationship
    // label — but a same-surname adult is very likely a spouse (or sibling). When
    // there's no formal marriage record, surface them so "is he married?" isn't
    // silently wrong just because the marriage index didn't have the record.
    const surname = (displayName.trim().split(/\s+/).pop() ?? '').toLowerCase().replace(/[^a-z]/g, '');
    const sameSurnamePartner = spouse
      ? nameOf(spouse)
      : relatives
          .map(nameOf)
          .filter(Boolean)
          .find((nm) => {
            const l = (nm.trim().split(/\s+/).pop() ?? '').toLowerCase().replace(/[^a-z]/g, '');
            return l && surname && l === surname && nm.toLowerCase() !== displayName.toLowerCase();
          }) ?? '';

    // Parse the actual RECORD arrays Person Search returns (nationwide), not just
    // the yes/no indicator — this is the spouse name + date + place across states.
    const dateOf = (r: any) => str(get(r, 'MarriageDate', 'marriageDate', 'DivorceDate', 'divorceDate', 'Date', 'date', 'DateOfMarriage', 'FilingDate', 'filingDate'));
    const placeOf = (r: any) => {
      const c = str(get(r, 'City', 'city', 'CountyName', 'countyName'));
      const s = str(get(r, 'State', 'state'));
      return [c, s].filter(Boolean).join(', ');
    };
    const spouseOf = (r: any) => str(get(r, 'SpouseName', 'spouseName', 'Spouse', 'spouse')) || nameOf(get(r, 'Spouse', 'spouse')) || nameOf(r);

    const marriageRecs = arr(get(p, 'MarriageRecords', 'marriageRecords', 'Marriages', 'marriages'));
    const divorceRecs = arr(get(p, 'DivorceRecords', 'divorceRecords', 'Divorces', 'divorces'));
    const marriageLines = marriageRecs
      .map((m) => [spouseOf(m) && `💍 to ${spouseOf(m)}`, dateOf(m) && `on ${dateOf(m)}`, placeOf(m) && `in ${placeOf(m)}`].filter(Boolean).join(' '))
      .filter(Boolean);
    const divorceLines = divorceRecs
      .map((d) => [spouseOf(d) && `💔 from ${spouseOf(d)}`, dateOf(d) && `on ${dateOf(d)}`, placeOf(d) && `in ${placeOf(d)}`].filter(Boolean).join(' '))
      .filter(Boolean);

    // Only a FORMAL marriage record (or an explicitly spouse-labelled relative)
    // sets "married". A bare same-surname relative is NOT called a partner here —
    // it could be a sibling or parent; the AI read decides that using the ages.
    const hardMarried = marriageRecs.length > 0 || indHas('marriages', 'marriage', 'married') || Boolean(spouse);
    const divorcedRec = divorceRecs.length > 0 || indHas('divorces', 'divorce', 'divorced');
    const statusLine = hardMarried
      ? marriageLines.length
        ? `💍 Marriage record${marriageLines.length > 1 ? 's' : ''} found (${marriageLines.length})`
        : spouse
          ? `💍 Married — spouse on file: ${nameOf(spouse)}`
          : '💍 Marriage record on file'
      : '💚 No formal marriage record on file';
    findings.push({
      source: 'enformion',
      label: 'Relationship status',
      title: statusLine,
      detail: [
        ...marriageLines.slice(0, 4),
        ...(divorceLines.length ? divorceLines.slice(0, 4) : divorcedRec ? ['💔 Divorce record also on file'] : []),
        // Note the same-surname relative for the AI to weigh (spouse vs sibling), but
        // don't declare it a partner in the deterministic status.
        !hardMarried && sameSurnamePartner && `Note: ${sameSurnamePartner} is on file as a relative sharing their last name.`,
        !hardMarried && 'No public marriage record came up — records lag and vary by state, so this doesn’t fully rule it out.',
      ]
        .filter(Boolean)
        .join('\n'),
      retrievedAt: ctx.now,
      confidence: marriageLines.length ? 0.7 : 0.55,
      extra: { status: divorcedRec && !hardMarried ? 'divorced' : hardMarried ? 'married' : 'single' },
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
          title: `👨‍👩‍👧 Their family (${list.length})`,
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
        title: `👯‍♀️ People in their circle (${associates.length})`,
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
        title: `📱 Their phone numbers (${phones.length})`,
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
        title: `📧 Their emails (${emails.length})`,
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
        title: `🏠 Places they've lived (${addrList.length})`,
        detail: addrList.slice(0, 6).join('\n'),
        retrievedAt: ctx.now,
        confidence: 0.55,
      });
    }

    // Criminal + court records are SAFETY signals — surface them so the report
    // routes them into "Is he safe?". Parse the actual RECORD array (offense, date,
    // state) when present, not just the yes/no indicator.
    const crimeRecs = arr(get(p, 'CriminalRecords', 'criminalRecords', 'Criminal', 'criminal', 'Criminals', 'criminals'));
    const crimeLines = crimeRecs
      .map((c) => {
        const off = str(get(c, 'Offense', 'offense', 'OffenseDescription', 'offenseDescription', 'Charge', 'charge', 'Category', 'category', 'CrimeType', 'crimeType'));
        const date = str(get(c, 'OffenseDate', 'offenseDate', 'ArrestDate', 'arrestDate', 'Date', 'date', 'DispositionDate'));
        const st = str(get(c, 'OffenseState', 'offenseState', 'State', 'state'));
        const city = str(get(c, 'OffenseCity', 'offenseCity', 'City', 'city'));
        const where = [city, st].filter(Boolean).join(', ');
        return [off ?? 'Offense', date && `(${date})`, where].filter(Boolean).join(' ');
      })
      .filter(Boolean);

    const criminal: string[] = [];
    if (crimeRecs.length || indHas('criminal', 'criminalRecords')) criminal.push(crimeRecs.length ? `⚠️ ${crimeRecs.length} criminal record(s) on file` : '⚠️ Criminal record on file');
    if (indHas('judgments', 'judgment')) criminal.push('Civil judgment(s) against them');
    if (indHas('sexualOffenses', 'sexOffender', 'sexOffenses')) criminal.push('🔴 Sex-offense record indicator');
    if (criminal.length) {
      findings.push({
        source: 'enformion',
        label: 'Criminal record',
        title: `🔴 ${criminal[0]!.replace(/^[🔴⚠️]\s*/, '')}`,
        detail: [
          ...crimeLines.slice(0, 6),
          ...criminal.slice(1),
          'Public-records data — pull the actual case to confirm (some are sealed). Verify it’s the right person.',
        ]
          .filter(Boolean)
          .join('\n'),
        retrievedAt: ctx.now,
        confidence: crimeLines.length ? 0.7 : 0.55,
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
}

/**
 * Shared Enformion POST. Tries candidate endpoint paths (their REST paths aren't
 * fully published) and returns the person records, however the response nests
 * them. A 404 just falls through to the next candidate path.
 */
async function enformionSearch(paths: string[], searchType: string, body: Obj): Promise<Obj[]> {
  for (const path of paths) {
    let res: Response;
    try {
      res = await fetch(`https://devapi.enformion.com${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'galaxy-ap-name': config.enformionName!,
          'galaxy-ap-password': config.enformionPassword!,
          'galaxy-search-type': searchType,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      continue; // network/timeout on this path — try the next
    }
    if (res.status === 404) continue;
    if (res.status === 401 || res.status === 403) throw new Error('Enformion rejected the credentials (check AP name/password)');
    if (!res.ok) throw new Error(`Enformion HTTP ${res.status}`);
    const data = (await res.json()) as Obj;
    const people = arr(get(data, 'persons', 'Persons', 'records', 'Records', 'results', 'Results'));
    if (people.length) return people;
    const single = get(data, 'person', 'Person'); // some endpoints return a single top match
    if (single && !Array.isArray(single) && typeof single === 'object') return [single];
    return Array.isArray(data) ? data : [];
  }
  return [];
}

/**
 * Reverse Phone → the full deep-background profile. Makes a PHONE search return
 * the same marriage/criminal/relatives data a name search does.
 */
export const enformionPhoneSource: Source = {
  id: 'enformion-phone',
  label: 'Deep background (phone)',
  accepts: ['phone'],
  async run(subject, ctx) {
    if (!config.enformionName || !config.enformionPassword) return null;
    const digits = subject.value.replace(/\D/g, '');
    if (digits.length < 10) return null;
    if (!(await tryCharge('enformion'))) return null;
    const people = await enformionSearch(['/ReversePhoneSearch', '/PhoneSearch', '/Phone/Search'], 'ReversePhone', { Phone: digits.slice(-10) });
    if (people.length === 0) return [];
    return parseEnformionPerson(people[0]!, ctx, { subjectRaw: subject.raw, peopleCount: people.length });
  },
};

/**
 * Email → the full deep-background profile via Contact Enrichment, so an EMAIL
 * search also returns identity, marriage, criminal, relatives, phones.
 */
export const enformionEmailSource: Source = {
  id: 'enformion-email',
  label: 'Deep background (email)',
  accepts: ['email'],
  async run(subject, ctx) {
    if (!config.enformionName || !config.enformionPassword) return null;
    const email = subject.value.trim().toLowerCase();
    if (!email.includes('@')) return null;
    if (!(await tryCharge('enformion'))) return null;
    const people = await enformionSearch(['/Contact/Enrich', '/ContactEnrichment', '/Email/Enrich'], 'DevAPIContactEnrich', { Email: email });
    if (people.length === 0) return [];
    return parseEnformionPerson(people[0]!, ctx, { subjectRaw: subject.raw, peopleCount: people.length });
  },
};
