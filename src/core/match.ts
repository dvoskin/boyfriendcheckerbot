import { join } from 'node:path';
import { config } from './config.js';
import { readJson, writeJson } from './store.js';

/**
 * The "are we dating the same person?" network — done the ONLY way that survives
 * legally (the way Lulu and Peeple did NOT): opt-in, anonymous, and never an
 * automatic reveal. A user opts in on a specific person; if someone else has
 * ALSO opted in on that same person (matched on shared identity keys), each side
 * is offered a chance to swap notes — and even then messages are relayed
 * anonymously, so no identity is ever exposed without both people choosing to.
 */
interface OptIn {
  user: number;
  at: string;
}

const FILE = () => join(config.dataDir, 'match.json');
let store: Record<string, OptIn[]> = {};
let loaded = false;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  store = await readJson<Record<string, OptIn[]>>(FILE(), {});
  loaded = true;
}
async function persist(): Promise<void> {
  await writeJson(FILE(), store);
}

/**
 * Opt this user into the match network for a person (described by identity keys).
 * Returns the DISTINCT other users who already opted in on the same person —
 * i.e. everyone this user could compare notes with.
 */
export async function optIn(user: number, keys: string[]): Promise<number[]> {
  if (keys.length === 0) return [];
  await ensureLoaded();
  const now = new Date().toISOString();
  const others = new Set<number>();
  for (const k of keys) {
    if (!store[k]) store[k] = [];
    for (const o of store[k]!) if (o.user !== user) others.add(o.user);
    if (!store[k]!.some((o) => o.user === user)) store[k]!.push({ user, at: now });
  }
  await persist();
  return [...others];
}

/** Remove a user from the whole match network (their own-data deletion). */
export async function removeFromMatch(user: number): Promise<void> {
  await ensureLoaded();
  let changed = false;
  for (const k of Object.keys(store)) {
    const next = store[k]!.filter((o) => o.user !== user);
    if (next.length !== store[k]!.length) {
      changed = true;
      if (next.length) store[k] = next;
      else delete store[k];
    }
  }
  if (changed) await persist();
}

/** Has this user already opted into the network for this person? */
export async function hasOptedIn(user: number, keys: string[]): Promise<boolean> {
  await ensureLoaded();
  return keys.some((k) => (store[k] ?? []).some((o) => o.user === user));
}
