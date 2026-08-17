/**
 * CLI harness for exercising sources without Telegram.
 *
 *   npx tsx src/scripts/probe.ts username torvalds
 *   npx tsx src/scripts/probe.ts domain goalsplasticsurgery.com
 *   npx tsx src/scripts/probe.ts person "John Smith" "FL"
 */
import { runSources } from '../core/runner.js';
import type { SubjectKind } from '../core/types.js';
import { ALL_SOURCES } from '../sources/index.js';

const [, , kindArg, value, hints] = process.argv;

if (!kindArg || !value) {
  console.error('usage: probe.ts <username|domain|person|company|email> <value> [hints]');
  process.exit(1);
}

const kind = kindArg as SubjectKind;
const started = Date.now();

const results = await runSources(
  ALL_SOURCES,
  { raw: value, kind, value: value.replace(/^@/, ''), hints },
  { now: new Date().toISOString(), hints },
  {
    onResult: (r) => {
      const state = !r.ok ? `FAIL ${r.error}` : r.skipped ? 'skipped' : `${r.findings.length} findings`;
      console.log(`[${String(r.ms).padStart(6)}ms] ${r.label.padEnd(28)} ${state}`);
    },
  },
);

console.log(`\n--- total ${Date.now() - started}ms ---\n`);

for (const r of results) {
  if (!r.ok || r.findings.length === 0) continue;
  console.log(`## ${r.label}`);
  for (const f of r.findings) {
    console.log(`  • ${f.title}  [conf ${f.confidence.toFixed(2)}]`);
    if (f.url) console.log(`    ${f.url}`);
    if (f.detail) {
      for (const line of f.detail.split('\n')) console.log(`      ${line}`);
    }
  }
  console.log();
}
