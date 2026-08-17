/**
 * Exercise the auto-pivot identity graph from the CLI.
 *
 *   npx tsx src/scripts/graph.ts username torvalds
 *   npx tsx src/scripts/graph.ts email someone@example.com
 *   npx tsx src/scripts/graph.ts domain example.com
 */
import { buildGraph } from '../core/graph.js';
import type { SubjectKind } from '../core/types.js';
import { ALL_SOURCES } from '../sources/index.js';
import { warmOfac } from '../sources/ofac.js';

const [, , kindArg, value, hints] = process.argv;
if (!kindArg || !value) {
  console.error('usage: graph.ts <username|domain|person|company|email> <value> [hints]');
  process.exit(1);
}

// Warm sanctions data so the first node does not eat the download latency.
await warmOfac();

const started = Date.now();

const result = await buildGraph(
  ALL_SOURCES,
  { raw: value, kind: kindArg as SubjectKind, value: value.replace(/^@/, ''), hints },
  {
    maxDepth: 2,
    maxNodes: 20,
    onNode: (node, isNew) => {
      if (isNew) {
        console.log(
          `  + [d${node.depth}] ${node.kind}:${node.value}  (conf ${node.confidence.toFixed(2)}) ← ${node.via?.reason ?? ''}`,
        );
      }
    },
    onProgress: (m) => console.log(`· ${m}`),
  },
);

console.log(`\n=== graph: ${result.nodes.length} nodes in ${Date.now() - started}ms${result.truncated ? ' (truncated)' : ''} ===\n`);

// Group by depth so the seed and its direct links read top-down.
for (let depth = 0; ; depth++) {
  const layer = result.nodes.filter((n) => n.depth === depth);
  if (layer.length === 0 && depth > 0) break;
  if (layer.length === 0) continue;
  console.log(`── depth ${depth} ──`);
  for (const node of layer) {
    const hitCount = node.findings.length;
    console.log(`● ${node.kind}: ${node.value}  [conf ${node.confidence.toFixed(2)}, ${hitCount} findings]`);
    if (node.via) console.log(`    ← ${node.via.reason}`);
    for (const f of node.findings.filter((x) => x.confidence >= 0.7).slice(0, 4)) {
      console.log(`      • ${f.label}: ${f.title}`);
    }
  }
  console.log();
}
