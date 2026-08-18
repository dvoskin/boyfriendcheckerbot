import { join } from 'node:path';
import { config } from './config.js';
import { readJson, writeJson } from './store.js';

/**
 * Who searched whom — the ledger behind pull-back alerts. When someone flags a
 * person, everyone who previously checked that same person (matched on shared
 * identity keys) gets a heads-up. This is a genuine event (a real user really
 * flagged them), never a fabricated "someone is looking at them" nudge.
 *
 * Stored as key -> list of {user, at}. Keys are the same identity keys the flag
 * network uses (phone:/email:/user:/name:|state), so a flag on any identifier
 * reaches anyone who searched any of them.
 */
interface SearchRecord {
  user: number;
  at: string;
}

const FILE = () => join(config.dataDir, 'searchers.json');
let index: Record<string, SearchRecord[]> = {};
let loaded = false;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  index = await readJson<Record<string, SearchRecord[]>>(FILE(), {});
  loaded = true;
}
async function persist(): Promise<void> {
  await writeJson(FILE(), index);
}

/** Remember that this user searched a person described by these identity keys. */
export async function recordSearch(user: number, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await ensureLoaded();
  const now = new Date().toISOString();
  for (const k of keys) {
    if (!index[k]) index[k] = [];
    const existing = index[k]!.find((r) => r.user === user);
    if (existing) existing.at = now;
    else index[k]!.push({ user, at: now });
  }
  await persist();
}

/** Distinct users who searched any of these keys, minus the excluded user. */
export async function searchersOf(keys: string[], exclude?: number): Promise<number[]> {
  await ensureLoaded();
  const users = new Set<number>();
  for (const k of keys) for (const r of index[k] ?? []) if (r.user !== exclude) users.add(r.user);
  return [...users];
}

/** How many distinct people have checked this person, and how many in ~30 days. */
export async function checkStats(keys: string[], exclude?: number): Promise<{ total: number; recent: number }> {
  await ensureLoaded();
  const all = new Set<number>();
  const recent = new Set<number>();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const k of keys) {
    for (const r of index[k] ?? []) {
      if (r.user === exclude) continue;
      all.add(r.user);
      if (Date.parse(r.at) >= cutoff) recent.add(r.user);
    }
  }
  return { total: all.size, recent: recent.size };
}
