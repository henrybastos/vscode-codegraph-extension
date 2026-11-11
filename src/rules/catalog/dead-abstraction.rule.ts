import type { DirectedGraph } from 'graphology';
import type { ArchitectureRule, FlaggedCandidate, RuleContext } from '../types.js';
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

  shouldIgnore(candidate: FlaggedCandidate, _graph: DirectedGraph, _ctx: RuleContext): boolean {
    const p = candidate.path.toLowerCase().replace(/\\/g, '/');
    const summary: string = candidate.evidence?.summary || '';
    const name: string = candidate.evidence?.symbolName || '';

    // 1. Framework entry points and public API roots
    if (
      p.endsWith('main.ts') ||
      p.endsWith('extension.ts') ||
      p.endsWith('index.ts') ||
      p.endsWith('route.ts') ||
      p.includes('/pages/') ||
      p.includes('/app/') ||
      name === 'activate' ||
      name === 'deactivate'
    ) {
      return true;
    }

    // 2. Ignore test files
    if (p.endsWith('.spec.ts') || p.endsWith('.test.ts') || p.includes('/test/')) {
      return true;
    }

    // 3. Ignore decorated classes/methods (e.g., NestJS, Fastify, Svelte, CLI)
    if (
      summary.includes('@Cron') ||
      summary.includes('@Processor') ||
      summary.includes('@Controller') ||
      summary.includes('@Injectable') ||
      summary.includes('@Command')
    ) {
      return true;
    }

    return false;
  }
}
