import { httpGet } from '../core/http.js';
import type { Finding, Source } from '../core/types.js';

/**
 * OFAC's own SDN files are US government works — public domain, free, no key, no
 * licence. That matters: OpenSanctions aggregates far more (EU/UN/UK lists plus
 * PEPs) but publishes under CC-BY-NC, so a commercial product needs a paid
 * licence from them. Raw OFAC keeps V1 free and unambiguously clear to ship.
 *
 * Whole list is ~17k entries, so we load it once and match in memory rather than
 * making a network call per lookup.
 */
const SDN_URL = 'https://www.treasury.gov/ofac/downloads/sdn.csv';
const ALT_URL = 'https://www.treasury.gov/ofac/downloads/alt.csv';

interface SdnEntry {
  entNum: string;
  name: string;
  type: string;
  program: string;
  title?: string;
  remarks?: string;
  /** True when this row came from the alternate-names file. */
  isAlias?: boolean;
  tokens: Set<string>;
}

let index: SdnEntry[] | null = null;
let loadedAt = 0;
let loading: Promise<SdnEntry[]> | null = null;

const RELOAD_AFTER_MS = 12 * 60 * 60 * 1000;

/** OFAC uses "-0-" as its null marker. */
function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  return !t || t === '-0-' ? undefined : t;
}

/** Minimal RFC4180-ish row parser — OFAC quotes fields and embeds commas. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function tokenize(name: string): Set<string> {
  return new Set(
    name
      .toUpperCase()
      .replace(/[^A-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1),
  );
}

async function load(): Promise<SdnEntry[]> {
  const entries: SdnEntry[] = [];

  const { body: sdn } = await httpGet(SDN_URL, { timeoutMs: 25_000, cacheTtl: 0, retries: 2 });
  const byEnt = new Map<string, SdnEntry>();

  for (const line of sdn.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    const name = clean(f[1]);
    const entNum = clean(f[0]);
    if (!name || !entNum) continue;
    const entry: SdnEntry = {
      entNum,
      name,
      type: clean(f[2]) ?? 'unknown',
      program: clean(f[3]) ?? 'unknown',
      title: clean(f[4]),
      remarks: clean(f[11]),
      tokens: tokenize(name),
    };
    entries.push(entry);
    byEnt.set(entNum, entry);
  }

  // Aliases matter a lot in practice — sanctioned individuals are usually listed
  // under several transliterations, and the primary name may not be the one you
  // have. Failing to check them is the classic false-negative in screening.
  try {
    const { body: alt } = await httpGet(ALT_URL, { timeoutMs: 25_000, cacheTtl: 0, retries: 1 });
    for (const line of alt.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const f = parseCsvLine(line);
      const entNum = clean(f[0]);
      const aliasName = clean(f[3]);
      if (!entNum || !aliasName) continue;
      const parent = byEnt.get(entNum);
      entries.push({
        entNum,
        name: aliasName,
        type: parent?.type ?? 'unknown',
        program: parent?.program ?? 'unknown',
        title: parent ? `alias of ${parent.name}` : undefined,
        isAlias: true,
        tokens: tokenize(aliasName),
      });
    }
  } catch {
    // Primary list alone is still a usable screen.
  }

  return entries;
}

async function getIndex(): Promise<SdnEntry[]> {
  if (index && Date.now() - loadedAt < RELOAD_AFTER_MS) return index;
  loading ??= load().then((res) => {
    index = res;
    loadedAt = Date.now();
    loading = null;
    return res;
  });
  return loading;
}

/**
 * Download and index the SDN list ahead of the first lookup. Without this the
 * first OFAC query pays the full ~10s CSV download inside the request deadline
 * and times out; call this once at process start so matching is in-memory and
 * instant from the very first search.
 */
export async function warmOfac(): Promise<void> {
  try {
    await getIndex();
  } catch {
    // A failed warm is non-fatal — the source will retry lazily and, if still
    // down, report itself as a gap rather than breaking the lookup.
  }
}

export const ofacSource: Source = {
  id: 'ofac',
  label: 'OFAC sanctions',
  accepts: ['person', 'company'],

  async run(subject, ctx) {
    const query = tokenize(subject.value);
    if (query.size === 0) return [];

    const entries = await getIndex();
    const scored: { entry: SdnEntry; score: number }[] = [];

    for (const entry of entries) {
      let hits = 0;
      for (const token of query) if (entry.tokens.has(token)) hits++;
      if (hits === 0) continue;
      // Require every query token to appear, so "John Smith" does not match
      // every Smith on the list. Screening tolerates false negatives from a
      // free-text bot far better than it tolerates naming an innocent person.
      if (hits < query.size) continue;
      const score = hits / Math.max(entry.tokens.size, query.size);
      scored.push({ entry, score });
    }

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, 5).map(({ entry, score }): Finding => ({
      source: 'ofac',
      label: 'OFAC SDN',
      title: `⚠️ Possible sanctions match: ${entry.name}`,
      detail: [
        `Type: ${entry.type}`,
        `Program: ${entry.program}`,
        entry.title && `Note: ${entry.title}`,
        entry.isAlias && 'Matched on an alternate spelling',
        entry.remarks && `Remarks: ${entry.remarks.slice(0, 200)}`,
        'Name match only — confirm identity against DOB/address before acting.',
      ]
        .filter(Boolean)
        .join('\n'),
      url: `https://sanctionssearch.ofac.treas.gov/Details.aspx?id=${entry.entNum}`,
      retrievedAt: ctx.now,
      confidence: Math.min(0.65, score),
    }));
  },
};
