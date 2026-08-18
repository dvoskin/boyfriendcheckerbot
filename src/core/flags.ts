import { join } from 'node:path';
import { config } from './config.js';
import { readJson, writeJson } from './store.js';
import { stateFromHint } from './names.js';
import type { Subject } from './types.js';

/**
 * Community flags — the "are we dating the same person" network. Users flag a
 * person with a STRUCTURED category (never free-text shown as fact), keyed to
 * reliable identifiers (phone/email/username, or name+state). Future searches for
 * any of those identifiers see the aggregated counts. This is the piece that:
 *  - works even when public records are thin,
 *  - gets more valuable with every user (a real moat),
 *  - and is legal because each person shares only their OWN experience, and only
 *    category counts are surfaced — not defamatory free text.
 */
export type FlagCategory = 'ghosted' | 'taken' | 'lied' | 'cheated' | 'unsafe' | 'money' | 'good';

export const FLAG_LABELS: Record<FlagCategory, string> = {
  taken: '💍 Was married / taken',
  cheated: '💔 Cheated',
  unsafe: '🚩 Made me feel unsafe',
  money: '💸 Asked for money',
  lied: '🤥 Lied about who they are',
  ghosted: '👻 Ghosted me',
  good: '✅ Good experience',
};

/** Order for display — worst first, positive last. */
const CATEGORY_ORDER: FlagCategory[] = ['unsafe', 'money', 'cheated', 'taken', 'lied', 'ghosted', 'good'];

interface Flag {
  by: number;
  at: string;
  keys: string[];
  category: FlagCategory;
  /** Optional: how this user knows the person (the legal "GetContact" label). */
  label?: string;
}

const FILE = () => join(config.dataDir, 'flags.json');
let flags: Flag[] = [];
let loaded = false;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  flags = await readJson<Flag[]>(FILE(), []);
  loaded = true;
}

async function persist(): Promise<void> {
  await writeJson(FILE(), flags);
}

function normName(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ');
}

/**
 * Reliable identity keys for a subject, plus any identifiers discovered during
 * the search. A flag stored under all of these lets a later search by ANY of
 * them (his phone, his email, his handle) surface it.
 */
export function subjectKeys(
  seed: Subject,
  extras?: { phones?: string[]; emails?: string[]; usernames?: string[] },
): string[] {
  const keys = new Set<string>();
  const add = (k: string) => keys.add(k);

  // Phones always keyed to the last 10 digits so a search WITH a country code
  // matches a discovered number stored WITHOUT one (and vice-versa).
  const phoneKey = (raw: string): string | null => {
    const d = raw.replace(/\D/g, '');
    return d.length >= 10 ? `phone:${d.slice(-10)}` : null;
  };
  if (seed.kind === 'phone') {
    const k = phoneKey(seed.value);
    if (k) add(k);
  } else if (seed.kind === 'email') add(`email:${seed.value.toLowerCase()}`);
  else if (seed.kind === 'username') add(`user:${seed.value.toLowerCase().replace(/^@/, '')}`);
  else if (seed.kind === 'person') {
    const st = seed.hints ? (stateFromHint(seed.hints) ?? '') : '';
    const n = normName(seed.value);
    // Store under BOTH name+state and bare name, so a flag added with a city is
    // still found by someone who searches the name without one.
    add(`name:${n}|${st.toLowerCase()}`);
    add(`name:${n}|`);
  }

  for (const p of extras?.phones ?? []) {
    const k = phoneKey(p);
    if (k) add(k);
  }
  for (const e of extras?.emails ?? []) add(`email:${e.toLowerCase()}`);
  for (const u of extras?.usernames ?? []) add(`user:${u.toLowerCase().replace(/^@/, '')}`);

  return [...keys];
}

export interface WallItem {
  category: FlagCategory;
  at: string;
  state?: string; // rough locality only — never a name
}

/**
 * The anonymized "Wall of Red Flags" feed — recent community flags with NO names,
 * just the category and (if known) a US state. Opinion-framed and identity-free,
 * so it's a daily-open doomscroll without the defamation of naming anyone.
 */
export async function recentFlags(limit = 20): Promise<WallItem[]> {
  await ensureLoaded();
  return flags
    .filter((f) => !f.label) // real flags only, not "known as" labels
    .slice(-limit * 2)
    .reverse()
    .map((f) => {
      const nameKey = f.keys.find((k) => k.startsWith('name:'));
      const st = nameKey?.split('|')[1]?.toUpperCase();
      return { category: f.category, at: f.at, state: st && st.length === 2 ? st : undefined };
    })
    .slice(0, limit);
}

export async function addFlag(by: number, keys: string[], category: FlagCategory): Promise<void> {
  if (keys.length === 0) return;
  await ensureLoaded();
  // One vote per user per category per identity — re-flagging just updates time.
  flags = flags.filter((f) => !(f.by === by && f.category === category && f.keys.some((k) => keys.includes(k))));
  flags.push({ by, at: new Date().toISOString(), keys, category });
  await persist();
}

/**
 * Add how the user personally knows this person — the LEGAL "how is this number
 * known" feature. Consented, one person at a time, contributed only by someone
 * who knows them (never a bulk address-book upload).
 */
export async function addLabel(by: number, keys: string[], label: string): Promise<void> {
  const clean = label.trim().slice(0, 60);
  if (keys.length === 0 || clean.length < 2) return;
  await ensureLoaded();
  flags = flags.filter((f) => !(f.by === by && f.label && f.keys.some((k) => keys.includes(k))));
  flags.push({ by, at: new Date().toISOString(), keys, category: 'good', label: clean });
  await persist();
}

export interface FlagSummary {
  total: number;
  byCategory: { category: FlagCategory; count: number }[];
  labels: { label: string; count: number }[];
}

/** Aggregate flags matching any of these keys, counting DISTINCT users. */
export async function lookupFlags(keys: string[]): Promise<FlagSummary> {
  await ensureLoaded();
  if (keys.length === 0) return { total: 0, byCategory: [], labels: [] };
  const keySet = new Set(keys);
  const matched = flags.filter((f) => f.keys.some((k) => keySet.has(k)));

  const perCat = new Map<FlagCategory, Set<number>>();
  const perLabel = new Map<string, Set<number>>();
  for (const f of matched) {
    if (f.label) {
      const key = f.label.toLowerCase();
      if (!perLabel.has(key)) perLabel.set(key, new Set());
      perLabel.get(key)!.add(f.by);
    } else {
      if (!perCat.has(f.category)) perCat.set(f.category, new Set());
      perCat.get(f.category)!.add(f.by);
    }
  }
  const byCategory = CATEGORY_ORDER.filter((c) => perCat.has(c)).map((c) => ({ category: c, count: perCat.get(c)!.size }));
  const labels = [...perLabel.entries()].map(([label, users]) => ({ label, count: users.size })).sort((a, b) => b.count - a.count);
  const total = new Set(matched.map((f) => f.by)).size;
  return { total, byCategory, labels };
}
