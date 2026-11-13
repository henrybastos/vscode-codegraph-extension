import type { DirectedGraph } from 'graphology';
import { isTestOrMockPath, type ArchitectureRule, type FlaggedCandidate, type RuleContext } from '../types.js';
import * as path from 'node:path';

export class GodFileRule implements ArchitectureRule {
  public readonly id = 'god-file';
  public readonly name = 'God File / Monolith Module';

  detect(graph: DirectedGraph, ctx: RuleContext): FlaggedCandidate[] {
    const candidates: FlaggedCandidate[] = [];

    for (const filePath of graph.nodes()) {
      const attrs: any = graph.getNodeAttributes(filePath);
      const metrics = ctx.fileMetrics.get(filePath);

      const loc = attrs.loc || metrics?.loc || 0;
      const fanIn = graph.inDegree(filePath);
      const fanOut = graph.outDegree(filePath);
      const symbolCount = attrs.symbolCount || metrics?.symbolCount || 0;

      // Detection condition: lineCount > 400 or symbolCount > 15, or high fan-in and fan-out
      const isExtremeSize = loc > 400 || symbolCount > 15;
      const isHighCoupling = (fanIn > 10 && fanOut > 8) || (fanIn >= 3 && fanOut >= 4 && loc > 250);

      if (isExtremeSize || isHighCoupling) {
        candidates.push({
          id: `god-file-${filePath.replace(/[^a-zA-Z0-9]/g, '_')}`,
          ruleId: this.id,
          type: 'file',
          path: filePath,
          category: 'God File',
          severity: loc > 600 || (fanIn > 12 && fanOut > 10) ? 'critical' : 'high',
          title: `Monolith Module: ${path.basename(filePath)}`,
          description: `File exhibits high complexity with ${loc} LOC, ${symbolCount} symbols, and coupling (fan-in: ${fanIn}, fan-out: ${fanOut}).`,
          metrics: {
            loc,
            fanIn,
            fanOut,
            methodCount: symbolCount,
            instability: metrics?.instability
          },
          evidence: { loc, symbolCount, fanIn, fanOut }
        });
      }
    }

    return candidates;
  }

  async shouldIgnore(candidate: FlaggedCandidate, graph: DirectedGraph, ctx: RuleContext): Promise<boolean> {
    // 1. Ignore test and mock files
    if (isTestOrMockPath(candidate.path)) {
      return true;
    }

    // 2. Deterministic whitelist: Pure declarations/DTOs/interfaces with outDegree === 0
    const outDegree = graph.outDegree(candidate.path);
    if (outDegree === 0) {
      return true;
    }

    // 3. Semantic MiniLM check for schema definitions, generated contracts, or pure type files
    if (outDegree <= 1 && ctx.roleClassifier?.isInitialized()) {
      const normalizedPath = candidate.path.replace(/\\/g, '/');
      const classification = await ctx.roleClassifier.classifyModuleRole(normalizedPath);
      if (classification.role === 'schema_type_contract') {
        return true;
      }
    }

    return false;
  }

  buildSlmValidationPrompt(candidate: FlaggedCandidate, ctx: RuleContext): string {
    const symbols: string[] = [];
    const normTarget = candidate.path.replace(/\\/g, '/').toLowerCase();

    ctx.symbolGraph.forEachNode((_, attrs: any) => {
      const p = (attrs.filePath || '').replace(/\\/g, '/').toLowerCase();
      if (p === normTarget) {
        symbols.push(`${attrs.name} (${attrs.kind})`);
      }
    });

    return `File: ${candidate.path}
LOC: ${candidate.metrics?.loc}, Fan-In: ${candidate.metrics?.fanIn}, Fan-Out: ${candidate.metrics?.fanOut}
Symbols: ${symbols.slice(0, 15).join(', ')}

Question: Does this file represent a single cohesive class/facade (valid), or does it bundle multiple mixed, unrelated domain responsibilities (violation)?`;
  }
}
