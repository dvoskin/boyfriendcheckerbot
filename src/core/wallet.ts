import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

/**
 * Token wallet + retention loops. Every search costs tokens; users top up by
 * checking in daily (with streak bonuses), referring friends, or (later) buying.
 * The scarcity + streak + referral loops are the retention engine — they create
 * the daily habit and the "I want more tokens" pull that monetises.
 *
 * Free-token defaults are generous on purpose: during launch nobody should feel
 * hard-blocked, but the mechanics build the habit and set up paid top-ups.
 */
export const TOKENS = {
  starter: 40, // on first use
  dailyBase: 10, // per daily check-in
  streak3: 5, // +bonus at a 3-day streak
  streak7: 25, // +bonus at a 7-day streak
  referrer: 50, // you invited someone who joined
  referred: 20, // you joined via an invite
};

/**
 * Base cost of a search — this only buys the VERDICT + flag scoreboard (the free
 * hook). The juicy detail is unbundled into per-reveal unlocks below, so the base
 * is cheap and the curiosity gap does the selling.
 */
export const COST = {
  person: 6,
  username: 4,
  email: 4,
  phone: 4,
  domain: 3,
  company: 5,
  image: 6,
};

/**
 * Per-reveal unlock prices — the money engine. After the free verdict, each of
 * these unlocks one juicy section. Kept modest so daily + invite keeps casual
 * users unblocked, but every reveal is a fresh little "yes".
 */
export const REVEAL = {
  single: 6, // relationship status + likely partner + who they really are
  safety: 8, // criminal / court / registry / sanctions / scam
  social: 5, // socials, hidden accounts, breaches, old profiles
  tea: 6, // the full AI "honest read"
};
export type RevealKey = keyof typeof REVEAL;

/**
 * Token packs sold for Telegram Stars — the fast-money rail (no card processor
 * that can ban a "background check" product, live in-chat, first sale today).
 * `stars` is the price in Telegram Stars (⭐, ~$0.013–0.015 each); `tokens` is
 * what the user receives. A middle pack is badged "Most Popular" as the decoy.
 */
export interface TokenPack {
  id: string;
  label: string;
  stars: number;
  tokens: number;
  tag?: string;
}
export const TOKEN_PACKS: TokenPack[] = [
  { id: 'taste', label: 'Taste', stars: 99, tokens: 60 },
  { id: 'popular', label: 'Most Popular', stars: 299, tokens: 220, tag: '🔥' },
  { id: 'value', label: 'Best Value', stars: 599, tokens: 500, tag: '💎' },
  { id: 'guardian', label: 'Guardian', stars: 1299, tokens: 1200, tag: '👑' },
];

interface Wallet {
  balance: number;
  seenStarter: boolean;
  lastDaily?: string; // YYYY-MM-DD
  streak: number;
  referredBy?: number;
  invited: number[]; // user ids who joined via this user
}

const FILE = () => join(config.dataDir, 'wallets.json');
let wallets: Record<string, Wallet> = {};
let loaded = false;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  await mkdir(config.dataDir, { recursive: true });
  try {
    wallets = JSON.parse(await readFile(FILE(), 'utf8')) as Record<string, Wallet>;
  } catch {
    wallets = {};
  }
  loaded = true;
}
async function persist(): Promise<void> {
  await writeFile(FILE(), JSON.stringify(wallets), 'utf8');
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function yesterday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function getWallet(id: number): Promise<Wallet> {
  await ensureLoaded();
  const key = String(id);
  if (!wallets[key]) wallets[key] = { balance: 0, seenStarter: false, streak: 0, invited: [] };
  return wallets[key]!;
}

/** Grant starter tokens on first contact; returns the amount if newly granted. */
export async function grantStarter(id: number): Promise<number> {
  const w = await getWallet(id);
  if (w.seenStarter) return 0;
  w.seenStarter = true;
  w.balance += TOKENS.starter;
  await persist();
  return TOKENS.starter;
}

export async function balanceOf(id: number): Promise<number> {
  return (await getWallet(id)).balance;
}

/** True when this user never pays — metering off (testing) or an owner allowlist. */
export function isFree(id: number): boolean {
  return !config.tokenMetering || config.unlimitedUserIds.includes(id);
}

/** Try to spend; false if not enough (caller shows the "earn more" flow). */
export async function spend(id: number, amount: number): Promise<boolean> {
  if (isFree(id)) return true; // free while testing / owner allowlist — never deduct
  const w = await getWallet(id);
  if (w.balance < amount) return false;
  w.balance -= amount;
  await persist();
  return true;
}

export async function addTokens(id: number, amount: number): Promise<void> {
  const w = await getWallet(id);
  w.balance += amount;
  await persist();
}

export interface DailyResult {
  ok: boolean; // false if already claimed today
  gained: number;
  streak: number;
  balance: number;
}

/** Daily check-in with streak bonuses — the habit loop. */
export async function claimDaily(id: number): Promise<DailyResult> {
  const w = await getWallet(id);
  if (w.lastDaily === today()) return { ok: false, gained: 0, streak: w.streak, balance: w.balance };
  w.streak = w.lastDaily === yesterday() ? w.streak + 1 : 1;
  let gained = TOKENS.dailyBase;
  if (w.streak % 7 === 0) gained += TOKENS.streak7;
  else if (w.streak % 3 === 0) gained += TOKENS.streak3;
  w.balance += gained;
  w.lastDaily = today();
  await persist();
  return { ok: true, gained, streak: w.streak, balance: w.balance };
}

/** Record a referral once, rewarding both sides. Returns true if newly applied. */
export async function applyReferral(newUserId: number, referrerId: number): Promise<boolean> {
  if (newUserId === referrerId) return false;
  const nw = await getWallet(newUserId);
  if (nw.referredBy || nw.seenStarter) return false; // only brand-new users, once
  const rw = await getWallet(referrerId);
  nw.referredBy = referrerId;
  nw.balance += TOKENS.referred;
  rw.balance += TOKENS.referrer;
  if (!rw.invited.includes(newUserId)) rw.invited.push(newUserId);
  await persist();
  return true;
}

export async function inviteCount(id: number): Promise<number> {
  return (await getWallet(id)).invited.length;
}
