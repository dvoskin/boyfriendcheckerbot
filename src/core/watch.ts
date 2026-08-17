import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import type { SubjectKind } from './types.js';

/**
 * A standing watch on a person. We store the set of linked selectors (graph node
 * ids) discovered at baseline; the scheduler re-runs the graph later and diffs
 * against this to detect new accounts, new domains, or disappearances.
 */
export interface Watch {
  id: string;
  userId: number;
  kind: SubjectKind;
  value: string;
  raw: string;
  baselineNodeIds: string[];
  addedAt: string;
  lastChecked: string;
}

const FILE = () => join(config.dataDir, 'watches.json');
let watches: Watch[] = [];
let loaded = false;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  await mkdir(config.dataDir, { recursive: true });
  try {
    watches = JSON.parse(await readFile(FILE(), 'utf8')) as Watch[];
  } catch {
    watches = [];
  }
  loaded = true;
}

async function persist(): Promise<void> {
  await writeFile(FILE(), JSON.stringify(watches, null, 2), 'utf8');
}

function watchId(userId: number, kind: SubjectKind, value: string): string {
  return `${userId}:${kind}:${value.toLowerCase()}`;
}

export async function addWatch(
  userId: number,
  kind: SubjectKind,
  value: string,
  raw: string,
  baselineNodeIds: string[],
): Promise<Watch> {
  await ensureLoaded();
  const id = watchId(userId, kind, value);
  const now = new Date().toISOString();
  const existing = watches.find((w) => w.id === id);
  if (existing) {
    // Re-watching refreshes the baseline rather than duplicating.
    existing.baselineNodeIds = baselineNodeIds;
    existing.lastChecked = now;
    await persist();
    return existing;
  }
  const watch: Watch = { id, userId, kind, value, raw, baselineNodeIds, addedAt: now, lastChecked: now };
  watches.push(watch);
  await persist();
  return watch;
}

export async function removeWatch(userId: number, value: string): Promise<boolean> {
  await ensureLoaded();
  const before = watches.length;
  watches = watches.filter(
    (w) => !(w.userId === userId && w.value.toLowerCase() === value.toLowerCase().replace(/^@/, '')),
  );
  if (watches.length === before) return false;
  await persist();
  return true;
}

export async function listWatches(userId: number): Promise<Watch[]> {
  await ensureLoaded();
  return watches.filter((w) => w.userId === userId);
}

export async function allWatches(): Promise<Watch[]> {
  await ensureLoaded();
  return [...watches];
}

export async function updateBaseline(id: string, nodeIds: string[]): Promise<void> {
  await ensureLoaded();
  const w = watches.find((x) => x.id === id);
  if (!w) return;
  w.baselineNodeIds = nodeIds;
  w.lastChecked = new Date().toISOString();
  await persist();
}
