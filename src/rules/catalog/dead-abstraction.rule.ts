import type { DirectedGraph } from 'graphology';
import { isTestOrMockPath, type ArchitectureRule, type FlaggedCandidate, type RuleContext } from '../types.js';
import * as path from 'node:path';

export class DeadAbstractionRule implements ArchitectureRule {
  public readonly id = 'dead-abstraction';
  public readonly name = 'Dead / Zombie Abstraction';

  detect(_graph: DirectedGraph, ctx: RuleContext): FlaggedCandidate[] {
    const candidates: FlaggedCandidate[] = [];
    const symbolGraph = ctx.symbolGraph;

    symbolGraph.forEachNode((nodeId, attrs: any) => {
      // Must be a function, class, or interface
      if (!['function', 'class', 'interface'].includes(attrs?.kind)) return;

      const summary: string = attrs.summary || '';
      const isExported = summary.includes('[exported]');
      if (!isExported) return;

      const inDegree = symbolGraph.inDegree(nodeId);
      if (inDegree === 0) {
        const filePath: string = attrs.filePath || '';
        candidates.push({
          id: `dead-${nodeId.replace(/[^a-zA-Z0-9]/g, '_')}`,
          ruleId: this.id,
          type: 'file',
          path: filePath,
          category: 'Dead Abstraction',
          severity: 'info',
          title: `Dead Export: ${attrs.name}`,
          description: `Exported ${attrs.kind} '${attrs.name}' has 0 callers or references across the workspace graph.`,
          evidence: {
            symbolId: nodeId,
            symbolName: attrs.name,
            kind: attrs.kind,
            summary
          }
        });
      }
    });

    return candidates;
  }

  async shouldIgnore(
    candidate: FlaggedCandidate,
    _graph: DirectedGraph,
    ctx: RuleContext
  ): Promise<boolean> {
    const normalizedPath = candidate.path.replace(/\\/g, '/');
    const summary: string = candidate.evidence?.summary || '';
    const rawName: string = candidate.evidence?.symbolName || '';
    const kind: string = candidate.evidence?.kind || 'symbol';

    // 1. Fast deterministic filter (0ms): Ignore test and mock files
    if (isTestOrMockPath(normalizedPath)) {
      return true;
    }

    // 2. Fast deterministic AST filter (0ms): Ignore decorated classes/methods (NestJS, Fastify, CLI)
    if (
      summary.includes('@Cron') ||
      summary.includes('@Processor') ||
      summary.includes('@Controller') ||
      summary.includes('@Injectable') ||
      summary.includes('@Command')
    ) {
      return true;
    }

    // 3. Semantic ONNX Abstraction Classification (~2-4ms):
    // Replaces hardcoded checks for DTOs, VOs, Schemas, Entities, Models, and framework entrypoints
    if (ctx.roleClassifier && ctx.roleClassifier.isInitialized()) {
      const classification = await ctx.roleClassifier.classifyAbstraction(rawName, kind, normalizedPath);

      if (candidate.evidence) {
        candidate.evidence.inferredRole = classification.role;
        candidate.evidence.roleConfidence = classification.score;
      }

      return classification.shouldIgnore;
    }

    return false;
  }
}
