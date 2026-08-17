import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

export interface AuditEntry {
  at: string;
  telegramUserId: number;
  username?: string;
  subjectKind: string;
  subjectValue: string;
  hints?: string;
  sourcesRun: string[];
  findingCount: number;
}

let ready = false;

/**
 * Append-only log of every lookup: who searched, what, when, against which
 * sources. Required in practice, not optional — data vendors ask for it in
 * their contracts, and it is the only way to answer an abuse complaint or a
 * subpoena about a specific search. Never expose a delete path for this file.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  if (!ready) {
    await mkdir(config.dataDir, { recursive: true });
    ready = true;
  }
  const line = JSON.stringify(entry) + '\n';
  await appendFile(join(config.dataDir, 'audit.jsonl'), line, 'utf8');
}
