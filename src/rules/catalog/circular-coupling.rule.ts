import type { DirectedGraph } from 'graphology';
import type {
  ArchitectureRule,
  FlaggedCandidate,
  RuleContext,
  TargetedAnalysisContext,
  TargetedAnalysisReportInput
} from '../types.js';
import * as path from 'node:path';
// @ts-ignore
import dag from 'graphology-dag';
import { detectCyclesInSubgraph } from '../../graph/metrics.js';
import {
  formatTargetedPrompts,
  getCrossFileSymbolRelations,
  readSnippet,
  resolveFileGraphNode
} from './targeted-helpers.js';

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

  buildTargetedAnalysis(ctx: TargetedAnalysisContext): TargetedAnalysisReportInput {
    const { item, fileGraph, symbolGraph, workspaceRoot } = ctx;
    const resolvedLead = resolveFileGraphNode(fileGraph, item.path) || item.path;

    let cycle: string[] = Array.isArray(item.evidence?.cycle) ? [...item.evidence.cycle] : [];
    if (cycle.length === 0 && fileGraph.hasNode(resolvedLead)) {
      const cycles = detectCyclesInSubgraph(fileGraph, fileGraph.nodes());
      cycle = cycles.find((c) => c.includes(resolvedLead)) || [];
    }

    const hopDetails: string[] = [];
    let weakestHop = '';
    let minWeight = Infinity;

    for (let i = 0; i < cycle.length; i++) {
      const src = cycle[i];
      const tgt = cycle[(i + 1) % cycle.length];
      const weight = fileGraph.hasEdge(src, tgt)
        ? Number(fileGraph.getEdgeAttribute(src, tgt, 'weight') || 1)
        : 1;
      const symbolRels = getCrossFileSymbolRelations(symbolGraph, src, tgt, 6);
      if (weight < minWeight) {
        minWeight = weight;
        weakestHop = `${path.basename(src)} -> ${path.basename(tgt)} (weight: ${weight})`;
      }
      hopDetails.push(
        `- ${src} -> ${tgt} (edge weight: ${weight})${symbolRels.length ? `\n  Symbols: ${symbolRels.join('; ')}` : ''}`
      );
    }

    const snippet = readSnippet(workspaceRoot, item.path, undefined, undefined, 120);
    const chainStr = cycle.length > 0 ? [...cycle, cycle[0]].join(' -> ') : item.description;

    const promptInput = formatTargetedPrompts(
      'Dependency Graph & Cycle-Breaking Architect',
      [
        'Focus on breaking the circular dependency at the weakest coupling edge (Dependency Inversion, extracting shared interfaces/types, or merging artificially split modules).',
        'Cite the exact files and symbol-level import/call hops from the graph data.'
      ],
      `Target Hotspot: ${item.path} (${item.category})
Cycle Chain: ${chainStr}
Weakest Link to Break: ${weakestHop || 'Determine from lowest symbol coupling below'}

Hop-by-Hop Graph & Symbol Coupling:
${hopDetails.length > 0 ? hopDetails.join('\n') : 'No cycle hops resolved in fileGraph.'}

${snippet ? `Source Preview (${item.path}):\n\`\`\`typescript\n${snippet}\n\`\`\`` : ''}`
    );

    return {
      ...promptInput,
      targetedEvidence: { cycle, weakestHop, hopCount: cycle.length }
    };
  }
}
