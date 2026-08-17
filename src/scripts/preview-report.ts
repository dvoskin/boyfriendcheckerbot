import { writeDossier } from '../core/dossier.js';
import { buildGraph } from '../core/graph.js';
import type { SubjectKind } from '../core/types.js';
import { renderReport } from '../report.js';
import { ALL_SOURCES } from '../sources/index.js';
import { warmOfac } from '../sources/ofac.js';

const [, , kindArg = 'username', value = 'torvalds', hints] = process.argv;
await warmOfac();
const seed = { raw: value, kind: kindArg as SubjectKind, value: value.replace(/^@/, ''), hints };
const graph = await buildGraph(ALL_SOURCES, seed, { maxDepth: 2, maxNodes: 18 });
const dossier = await writeDossier(graph);
const msgs = renderReport(seed, graph, dossier);
msgs.forEach((m, i) => {
  console.log(`\n═══════ MESSAGE ${i + 1} ═══════`);
  console.log(m.replace(/<[^>]+>/g, ''));
});
