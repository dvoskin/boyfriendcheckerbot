import { extractPivots, type Pivot } from './extract.js';
import { runSources } from './runner.js';
import type { Finding, Source, Subject, SubjectKind } from './types.js';

export interface GraphNode {
  id: string;
  kind: SubjectKind;
  value: string;
  depth: number;
  /** How sure we are this node belongs to the target entity (0–1). */
  confidence: number;
  /** The pivot that introduced this node, absent for the seed. */
  via?: { fromId: string; reason: string };
  findings: Finding[];
}

export interface GraphResult {
  nodes: GraphNode[];
  seedId: string;
  truncated: boolean;
}

export interface GraphOptions {
  maxDepth?: number;
  maxNodes?: number;
  /** Do not pivot on a discovered selector below this confidence. */
  minPivotConfidence?: number;
  onNode?: (node: GraphNode, isNew: boolean) => void;
  onProgress?: (msg: string) => void;
}

function nodeId(kind: SubjectKind, value: string): string {
  return `${kind}:${value.toLowerCase()}`;
}

/**
 * Auto-pivoting identity graph. Seed with one selector; the engine looks it up,
 * reads the findings for new selectors (emails, handles, personal domains),
 * enqueues those, and recurses — building the web of linked identity that a flat
 * one-shot lookup cannot show.
 *
 * Three safeties keep it from exploding across the open internet:
 *  - a depth ceiling (how many pivots from the seed),
 *  - a hard node cap (total selectors investigated),
 *  - confidence decay per hop, so a third-hop guess never reads as fact and weak
 *    links are not pivoted on at all.
 */
export async function buildGraph(
  sources: Source[],
  seed: Subject,
  options: GraphOptions = {},
): Promise<GraphResult> {
  const maxDepth = options.maxDepth ?? 2;
  const maxNodes = options.maxNodes ?? 25;
  const minPivot = options.minPivotConfidence ?? 0.6;

  const nodes = new Map<string, GraphNode>();
  const seedId = nodeId(seed.kind, seed.value);
  nodes.set(seedId, {
    id: seedId,
    kind: seed.kind,
    value: seed.value,
    depth: 0,
    confidence: 1,
    findings: [],
  });

  // Breadth-first in waves: every node at the current depth is expanded
  // concurrently, so wall-clock is the slowest node per depth rather than the
  // sum of all nodes. Shallow, high-confidence leads are still processed before
  // deeper ones, so the node cap drops the weakest links first.
  let frontier: string[] = [seedId];
  let truncated = false;

  /** Expand one node: look it up, attach findings, return its candidate pivots. */
  const expand = async (id: string): Promise<Map<string, { pivot: Pivot; confidence: number }>> => {
    const node = nodes.get(id)!;
    const subject: Subject = { raw: node.value, kind: node.kind, value: node.value, hints: seed.hints };
    options.onProgress?.(`Expanding ${node.kind} "${node.value}" (depth ${node.depth})`);

    const results = await runSources(sources, subject, { now: new Date().toISOString(), hints: seed.hints });
    node.findings = results.flatMap((r) => r.findings);
    options.onNode?.(node, false);

    const pivots = new Map<string, { pivot: Pivot; confidence: number }>();
    if (node.depth >= maxDepth) return pivots;

    for (const finding of node.findings) {
      if (finding.confidence < minPivot) continue;
      for (const pivot of extractPivots(finding, subject)) {
        const childId = nodeId(pivot.kind, pivot.value);
        if (nodes.has(childId)) continue;
        // A child is at most as trustworthy as the finding that produced it and
        // the parent it hangs from; multiply so confidence decays with distance.
        const conf = Math.min(finding.confidence, node.confidence) * 0.85;
        const existing = pivots.get(childId);
        if (!existing || conf > existing.confidence) pivots.set(childId, { pivot, confidence: conf });
      }
    }
    return pivots;
  };

  // Bound how many nodes hit the network at once: each node already fans out to
  // every source, so a wide frontier could otherwise open hundreds of sockets.
  const NODE_CONCURRENCY = 4;

  for (let depth = 0; depth <= maxDepth && frontier.length > 0 && !truncated; depth++) {
    const next: string[] = [];

    for (let i = 0; i < frontier.length; i += NODE_CONCURRENCY) {
      const batch = frontier.slice(i, i + NODE_CONCURRENCY);
      const expansions = await Promise.all(batch.map((id) => expand(id).then((p) => ({ id, p }))));

      for (const { id, p } of expansions) {
        for (const [childId, { pivot, confidence }] of p) {
          if (nodes.has(childId)) continue;
          if (nodes.size >= maxNodes) {
            truncated = true;
            continue;
          }
          const child: GraphNode = {
            id: childId,
            kind: pivot.kind,
            value: pivot.value,
            depth: depth + 1,
            confidence,
            via: { fromId: id, reason: pivot.reason },
            findings: [],
          };
          nodes.set(childId, child);
          next.push(childId);
          options.onNode?.(child, true);
        }
      }
    }

    frontier = next;
  }

  return { nodes: [...nodes.values()], seedId, truncated };
}
