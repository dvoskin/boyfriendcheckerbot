import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from './config.js';

/**
 * Durable JSON persistence for anything holding money or state. Two guarantees
 * the naive writeFile pattern did NOT have, and which cost real user balances:
 *  1. ATOMIC writes — write to a temp file then rename() (atomic on POSIX), so a
 *     crash mid-write can never leave a half-written / truncated file.
 *  2. NEVER silently zero — if the file is unreadable we throw (and stash the
 *     corrupt copy) instead of returning empty, so we don't wipe everyone's data.
 */

let dirReady = false;
async function ensureDir(path: string): Promise<void> {
  if (!dirReady) {
    await mkdir(config.dataDir, { recursive: true });
    dirReady = true;
  }
  await mkdir(dirname(path), { recursive: true }).catch(() => {});
}

/** Read JSON, returning `fallback` ONLY when the file legitimately doesn't exist. */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback; // first run
    throw err; // permission/IO error — surface it, don't wipe
  }
  if (raw.trim() === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    // Corrupt (e.g. a pre-atomic half-write). Stash it so we can recover, and
    // fail loudly rather than silently zeroing the data.
    await writeFile(`${path}.corrupt-${Date.now()}`, raw, 'utf8').catch(() => {});
    throw new Error(`Corrupt JSON at ${path}: ${(err as Error).message}`);
  }
}

/** Atomically write JSON (temp file + rename). */
export async function writeJson(path: string, data: unknown): Promise<void> {
  await ensureDir(path);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data), 'utf8');
  await rename(tmp, path);
}
