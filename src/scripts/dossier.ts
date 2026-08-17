/**
 * End-to-end dossier: graph + deterministic signals + (optional) AI narrative.
 *
 *   npx tsx src/scripts/dossier.ts username torvalds
 */
import { writeDossier } from '../core/dossier.js';
import { buildGraph } from '../core/graph.js';
import type { SubjectKind } from '../core/types.js';
import { ALL_SOURCES } from '../sources/index.js';
import { warmOfac } from '../sources/ofac.js';

const [, , kindArg, value, hints] = process.argv;
if (!kindArg || !value) {
  console.error('usage: dossier.ts <username|domain|person|company|email> <value> [hints]');
  process.exit(1);
}

await warmOfac();
const started = Date.now();

const graph = await buildGraph(
  ALL_SOURCES,
  { raw: value, kind: kindArg as SubjectKind, value: value.replace(/^@/, ''), hints },
  { maxDepth: 2, maxNodes: 18 },
);

const dossier = await writeDossier(graph);

console.log(`\n=== dossier in ${Date.now() - started}ms (${graph.nodes.length} nodes) ===\n`);
console.log('SIGNALS:');
for (const s of dossier.signals) console.log(`  [${s.level.toUpperCase()}] ${s.text}`);
console.log(`\nidentityCount: ${dossier.identityCount}`);
console.log(`names seen: ${dossier.names.join(' | ') || '(none)'}`);
console.log('\nNARRATIVE:');
console.log(dossier.narrative ?? '(none — set ANTHROPIC_API_KEY for the AI narrative)');
