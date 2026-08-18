import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { config } from './config.js';

/**
 * The real database — an embedded SQLite file on the existing Render disk. This is
 * the moat: every search result is cached (repeat lookups are instant AND free,
 * saving real API money), and a people-index + event log accumulate the data that
 * makes the product smarter and defensible over time.
 *
 * We deliberately store PUBLIC-RECORDS data and app events only — never ID selfies,
 * faces, or raw passwords (the exact hoard that got Tea breached and sued).
 *
 * Everything degrades gracefully: if SQLite can't load, the bot still runs (cache
 * misses, no logging) instead of crashing.
 */
let db: Database.Database | null = null;
try {
  mkdirSync(config.dataDir, { recursive: true });
  db = new Database(join(config.dataDir, 'checkmate.db'));
  db.pragma('journal_mode = WAL'); // safe concurrent reads/writes
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_cache (
      key TEXT PRIMARY KEY, graph TEXT NOT NULL, dossier TEXT NOT NULL, at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY, kind TEXT, value TEXT,
      first_seen INTEGER, last_seen INTEGER, hits INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER, type TEXT, detail TEXT, at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_events_uid ON events(uid);
    CREATE INDEX IF NOT EXISTS idx_people_value ON people(value);
  `);
} catch (err) {
  console.error('SQLite unavailable — running without the DB layer:', err);
  db = null;
}

export function dbReady(): boolean {
  return db !== null;
}

// ── Search cache ────────────────────────────────────────────────────────────
export interface CachedSearch {
  graph: unknown;
  dossier: unknown;
  ageMs: number;
}

/** Return a cached search if present and newer than maxAgeMs, else null. */
export function getCachedSearch(key: string, maxAgeMs: number): CachedSearch | null {
  if (!db) return null;
  try {
    const row = db.prepare('SELECT graph, dossier, at FROM search_cache WHERE key = ?').get(key) as
      | { graph: string; dossier: string; at: number }
      | undefined;
    if (!row) return null;
    const ageMs = Date.now() - row.at;
    if (ageMs > maxAgeMs) return null;
    return { graph: JSON.parse(row.graph), dossier: JSON.parse(row.dossier), ageMs };
  } catch {
    return null;
  }
}

/** Store a search result so repeat lookups are instant and free. */
export function saveSearch(key: string, graph: unknown, dossier: unknown): void {
  if (!db) return;
  try {
    db.prepare('INSERT OR REPLACE INTO search_cache (key, graph, dossier, at) VALUES (?, ?, ?, ?)').run(
      key,
      JSON.stringify(graph),
      JSON.stringify(dossier),
      Date.now(),
    );
  } catch (err) {
    console.error('saveSearch failed:', err);
  }
}

// ── People index (the accumulating moat) ─────────────────────────────────────
/** Record that a person (by identity key) was seen, bumping their hit count. */
export function upsertPeople(ids: { id: string; kind: string; value: string }[]): void {
  if (!db || ids.length === 0) return;
  try {
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO people (id, kind, value, first_seen, last_seen, hits) VALUES (@id, @kind, @value, @now, @now, 1)
      ON CONFLICT(id) DO UPDATE SET last_seen = @now, hits = hits + 1
    `);
    const tx = db.transaction((rows: typeof ids) => {
      for (const r of rows) stmt.run({ ...r, now });
    });
    tx(ids);
  } catch (err) {
    console.error('upsertPeople failed:', err);
  }
}

// ── Event log (user behaviour analytics) ─────────────────────────────────────
export function logEvent(uid: number, type: string, detail = ''): void {
  if (!db) return;
  try {
    db.prepare('INSERT INTO events (uid, type, detail, at) VALUES (?, ?, ?, ?)').run(uid, type, detail, Date.now());
  } catch {
    /* non-fatal */
  }
}

/** High-level counts for an owner /stats command. */
export function dbStats(): { people: number; cached: number; events: number; users: number } | null {
  if (!db) return null;
  try {
    const one = (sql: string) => (db!.prepare(sql).get() as { c: number }).c;
    return {
      people: one('SELECT COUNT(*) c FROM people'),
      cached: one('SELECT COUNT(*) c FROM search_cache'),
      events: one('SELECT COUNT(*) c FROM events'),
      users: one('SELECT COUNT(DISTINCT uid) c FROM events'),
    };
  } catch {
    return null;
  }
}
