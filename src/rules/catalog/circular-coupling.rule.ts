import type { DirectedGraph } from 'graphology';
import type { ArchitectureRule, FlaggedCandidate, RuleContext } from '../types.js';
import * as path from 'node:path';
// @ts-ignore
import dag from 'graphology-dag';
import { detectCyclesInSubgraph } from '../../graph/metrics.js';

export class CircularCouplingRule implements ArchitectureRule {
  public readonly id = 'circular-coupling';
  public readonly name = 'Circular Coupling';

  detect(graph: DirectedGraph, _ctx: RuleContext): FlaggedCandidate[] {
    const candidates: FlaggedCandidate[] = [];
    const fileNodes = graph.nodes();

    // Create a runtime-only projection (excluding pure type-only imports)
    const runtimeGraph = graph.copy();
    runtimeGraph.forEachEdge((edge, attrs: any) => {
      if (attrs?.isTypeOnly === true) {
        runtimeGraph.dropEdge(edge);
      }
    });

    let detectedCycles: string[][] = [];
    try {
      if (dag.hasCycle(runtimeGraph)) {
        detectedCycles = detectCyclesInSubgraph(runtimeGraph, fileNodes);
      }
    } catch {
      // dag check fallback
    }

    const seenCycleSignatures = new Set<string>();
    for (const cycle of detectedCycles) {
      if (cycle.length < 2) continue;
      const sortedSig = [...cycle].sort().join('|');
      if (seenCycleSignatures.has(sortedSig)) continue;
      seenCycleSignatures.add(sortedSig);

      const leadFile = cycle[0];
      const chainDisplay = cycle.map((f) => path.basename(f)).join(' ➔ ');

      candidates.push({
        id: `circular-${leadFile.replace(/[^a-zA-Z0-9]/g, '_')}-${sortedSig.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 16)}`,
        ruleId: this.id,
        type: 'file',
        path: leadFile,
        category: 'Circular Dependency',
        severity: 'critical',
        title: 'Circular Dependency Cycle',
        description: `Circular dependency cycle: ${chainDisplay} (causes tight coupling and fragile initialization).`,
        evidence: { cycle, chainDisplay }
      });
    }

    return candidates;
  }

  shouldIgnore(candidate: FlaggedCandidate, graph: DirectedGraph, _ctx: RuleContext): boolean {
    const cycle: string[] = candidate.evidence?.cycle || [];
    if (cycle.length === 0) return false;

    // Deterministic Filter 1: Check if any step in the cycle is a pure barrel index.ts re-export
    for (let i = 0; i < cycle.length; i++) {
      const src = cycle[i];
      const tgt = cycle[(i + 1) % cycle.length];
      if (graph.hasEdge(src, tgt)) {
        const isReExport = graph.getEdgeAttribute(src, tgt, 'isReExport');
        const isBarrel = path.basename(src).startsWith('index.') || path.basename(tgt).startsWith('index.');
        if (isReExport || isBarrel) {
          return true; // Ignore barrel re-export loop
        }
      }
    }

    return false;
  }
}
