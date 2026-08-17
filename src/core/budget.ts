import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

/**
 * Daily spend guard. Each paid source charges its estimated per-call cost against
 * a daily budget; once the cap is hit, paid sources pause until tomorrow while the
 * free sources keep working. This is the seatbelt that stops a viral day (or a
 * bug) from running up a surprise bill on Enformion/Bright Data/Twilio/SerpAPI.
 *
 * Estimates are intentionally conservative (charge on call, not only on a
 * successful match) so the cap is a hard ceiling, never an under-count.
 */
const COST_USD: Record<string, number> = {
  enformion: 0.35, // per person lookup
  brightdata: 0.003, // ~2 profile fetches
  phone: 0.01, // Twilio CNAM
  reverse: 0.015, // SerpAPI google_lens
};

interface Spend {
  day: string;
  usd: number;
}

const FILE = () => join(config.dataDir, 'spend.json');
let state: Spend | null = null;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function ensureLoaded(): Promise<void> {
  if (state) return;
  await mkdir(config.dataDir, { recursive: true });
  try {
    state = JSON.parse(await readFile(FILE(), 'utf8')) as Spend;
  } catch {
    state = { day: today(), usd: 0 };
  }
}

async function persist(): Promise<void> {
  await writeFile(FILE(), JSON.stringify(state), 'utf8');
}

/**
 * Reserve budget for one paid call. Returns false (and charges nothing) if the
 * call would exceed today's cap — the source should then skip. Free sources
 * (cost 0 / unknown id) always pass.
 */
export async function tryCharge(sourceId: string): Promise<boolean> {
  const cost = COST_USD[sourceId] ?? 0;
  if (cost === 0) return true;
  await ensureLoaded();
  if (state!.day !== today()) state = { day: today(), usd: 0 };
  if (state!.usd + cost > config.dailySpendCapUsd) return false;
  state!.usd += cost;
  await persist();
  return true;
}

export async function spentToday(): Promise<number> {
  await ensureLoaded();
  if (state!.day !== today()) return 0;
  return state!.usd;
}
