import { join } from 'node:path';
import { config } from './config.js';
import { readJson, writeJson } from './store.js';

/**
 * "Claim & Clear" profiles — the second paying audience. The person being checked
 * claims their OWN identity and self-attests (e.g. "I'm single"). When someone
 * checks them, they see the claim. A paid badge upgrades it to "✅ Verified by
 * Checkmate", and the subject can be alerted when they're checked/flagged.
 *
 * This is the lowest-legal-risk feature in the product: it's consent-based, the
 * subject controls their own claim, and we store NO ID selfies / biometrics
 * (the exact thing that sank Tea under BIPA).
 */
interface Profile {
  user: number;
  name: string;
  keys: string[]; // identity keys this claim matches
  single: boolean;
  claimedAt: string;
  paidUntil?: string; // ISO date the paid ✅ badge is active until
}

const FILE = () => join(config.dataDir, 'profiles.json');
let profiles: Profile[] = [];
let loaded = false;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  profiles = await readJson<Profile[]>(FILE(), []);
  loaded = true;
}
async function persist(): Promise<void> {
  await writeJson(FILE(), profiles);
}

/** Create or update this user's own claimed profile. One profile per user. */
export async function claimProfile(user: number, name: string, keys: string[], single: boolean): Promise<void> {
  await ensureLoaded();
  const existing = profiles.find((p) => p.user === user);
  if (existing) {
    existing.name = name;
    existing.keys = keys;
    existing.single = single;
  } else {
    profiles.push({ user, name, keys, single, claimedAt: new Date().toISOString() });
  }
  await persist();
}

/** Mark this user's badge paid for `days` more (extends from now or current expiry). */
export async function setBadgePaid(user: number, days: number): Promise<void> {
  await ensureLoaded();
  const p = profiles.find((x) => x.user === user);
  if (!p) return;
  const base = p.paidUntil && Date.parse(p.paidUntil) > Date.now() ? Date.parse(p.paidUntil) : Date.now();
  p.paidUntil = new Date(base + days * 24 * 60 * 60 * 1000).toISOString();
  await persist();
}

export interface Badge {
  name: string;
  single: boolean;
  verified: boolean; // paid ✅, vs a free self-claim
  since: string;
}

/** The badge to show for a person matched by these identity keys, if any. */
export async function badgeFor(keys: string[]): Promise<Badge | null> {
  if (keys.length === 0) return null;
  await ensureLoaded();
  const set = new Set(keys);
  const p = profiles.find((x) => x.keys.some((k) => set.has(k)));
  if (!p) return null;
  return {
    name: p.name,
    single: p.single,
    verified: Boolean(p.paidUntil && Date.parse(p.paidUntil) > Date.now()),
    since: (p.paidUntil ?? p.claimedAt).slice(0, 10),
  };
}

/** Permanently delete this user's claimed profile. */
export async function deleteProfile(user: number): Promise<void> {
  await ensureLoaded();
  const before = profiles.length;
  profiles = profiles.filter((p) => p.user !== user);
  if (profiles.length !== before) await persist();
}

/** This user's own profile, if they've claimed one. */
export async function myProfile(user: number): Promise<Profile | null> {
  await ensureLoaded();
  return profiles.find((p) => p.user === user) ?? null;
}

/** The Telegram id of whoever claimed a profile matching these keys (for "you were checked" alerts). Verified badges only. */
export async function verifiedOwnerFor(keys: string[]): Promise<number | null> {
  if (keys.length === 0) return null;
  await ensureLoaded();
  const set = new Set(keys);
  const p = profiles.find((x) => x.keys.some((k) => set.has(k)) && x.paidUntil && Date.parse(x.paidUntil) > Date.now());
  return p?.user ?? null;
}
