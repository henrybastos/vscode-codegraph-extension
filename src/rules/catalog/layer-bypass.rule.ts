import type { DirectedGraph } from 'graphology';
import type { ArchitectureRule, FlaggedCandidate, RuleContext } from '../types.js';
import * as path from 'node:path';

export class LayerBypassRule implements ArchitectureRule {
  public readonly id = 'layer-bypass';
  public readonly name = 'Layer Bypass (Leaky Abstraction)';

  detect(graph: DirectedGraph, _ctx: RuleContext): FlaggedCandidate[] {
    const candidates: FlaggedCandidate[] = [];

    graph.forEachEdge((edge, edgeAttrs, source, target) => {
      const srcAttrs: any = graph.getNodeAttributes(source);
      const tgtAttrs: any = graph.getNodeAttributes(target);

      const srcLayer = srcAttrs?.layer;
      const tgtLayer = tgtAttrs?.layer;

      // Direct edge from presentation/UI to infrastructure/DB
      if (srcLayer === 'presentation' && tgtLayer === 'infrastructure') {
        candidates.push({
          id: `bypass-${source.replace(/[^a-zA-Z0-9]/g, '_')}->${target.replace(/[^a-zA-Z0-9]/g, '_')}`,
          ruleId: this.id,
          type: 'file',
          path: source,
          category: 'Layer Bypass',
          severity: 'high',
          title: 'Architectural Layer Bypass',
          description: `Presentation component '${path.basename(source)}' directly couples to persistence layer '${path.basename(target)}' bypassing domain/service abstractions.`,
          evidence: {
            source,
            target,
            sourceLayer: srcLayer,
            targetLayer: tgtLayer
          }
        });
      }
    });

    return candidates;
  }

  shouldIgnore(candidate: FlaggedCandidate, _graph: DirectedGraph, _ctx: RuleContext): boolean {
    const p = candidate.path.toLowerCase().replace(/\\/g, '/');

    // 1. Ignore test and spec files
    if (p.endsWith('.spec.ts') || p.endsWith('.test.ts') || p.includes('/test/') || p.includes('/__tests__/')) {
      return true;
    }

    // 2. Ignore seed scripts, migrations, and CLI setup
    if (p.includes('seed') || p.includes('migration') || p.includes('/scripts/') || p.includes('/tools/')) {
      return true;
    }

    // 3. Ignore composition roots and module binders
    if (p.endsWith('main.ts') || p.endsWith('extension.ts') || p.endsWith('.module.ts') || p.endsWith('index.ts')) {
      return true;
    }

    return false;
  }

  buildSlmValidationPrompt(candidate: FlaggedCandidate, _ctx: RuleContext): string {
    const targetFile = candidate.evidence?.target ? path.basename(candidate.evidence.target) : 'persistence layer';
    return `Source File: ${candidate.path}
Target Dependency: ${targetFile}
Issue: Presentation/UI component references infrastructure/database module directly.

Question: Is this file an intentional self-contained script or simple standalone webhook/handler (valid), or does it violate clean architectural layering by bypassing the service/domain layer (violation)?`;
  }
}
