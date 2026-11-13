import type { DirectedGraph } from 'graphology';
import {
  isTestOrMockPath,
  type ArchitectureRule,
  type FlaggedCandidate,
  type RuleContext,
  type TargetedAnalysisContext,
  type TargetedAnalysisReportInput
} from '../types.js';
import * as path from 'node:path';
import {
  formatTargetedPrompts,
  getCrossFileSymbolRelations,
  readSnippet,
  resolveFileGraphNode
} from './targeted-helpers.js';

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

  async shouldIgnore(
    candidate: FlaggedCandidate,
    _graph: DirectedGraph,
    ctx: RuleContext
  ): Promise<boolean> {
    const normalizedPath = candidate.path.replace(/\\/g, '/');

    // 1. Fast deterministic filter (0ms): Ignore test and spec files
    if (isTestOrMockPath(normalizedPath)) {
      return true;
    }

    // 2. Semantic ONNX Module Classification (~2-4ms):
    // Replaces hardcoded checks for seed/migration/CLI scripts and composition roots/module binders
    if (ctx.roleClassifier && ctx.roleClassifier.isInitialized()) {
      const classification = await ctx.roleClassifier.classifyModuleRole(normalizedPath);

      if (candidate.evidence) {
        candidate.evidence.inferredRole = classification.role;
        candidate.evidence.roleConfidence = classification.score;
      }

      return (
        classification.role === 'composition_root_wiring' ||
        classification.role === 'cli_seed_migration'
      );
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

  buildTargetedAnalysis(ctx: TargetedAnalysisContext): TargetedAnalysisReportInput {
    const { item, fileGraph, symbolGraph, workspaceRoot } = ctx;
    const resolvedSrc = resolveFileGraphNode(fileGraph, item.path) || item.path;

    const bypassedTargets: Array<{ target: string; symbols: string[] }> = [];
    if (fileGraph.hasNode(resolvedSrc)) {
      fileGraph.forEachOutEdge(resolvedSrc, (_edge, _attrs, _s, target) => {
        const tgtLayer = fileGraph.getNodeAttribute(target, 'layer');
        if (tgtLayer === 'infrastructure' || target === item.evidence?.target) {
          bypassedTargets.push({
            target,
            symbols: getCrossFileSymbolRelations(symbolGraph, resolvedSrc, target, 8)
          });
        }
      });
    } else if (item.evidence?.target) {
      bypassedTargets.push({
        target: item.evidence.target,
        symbols: getCrossFileSymbolRelations(symbolGraph, resolvedSrc, item.evidence.target, 8)
      });
    }

    const appFacades = fileGraph
      .nodes()
      .filter((n) => fileGraph.getNodeAttribute(n, 'layer') === 'application')
      .slice(0, 10);

    const bypassSummary = bypassedTargets
      .map((b) => `- ${b.target}${b.symbols.length ? `\n  Offending calls/imports: ${b.symbols.join('; ')}` : ''}`)
      .join('\n');

    const snippet = readSnippet(workspaceRoot, item.path, undefined, undefined, 130);

    const promptInput = formatTargetedPrompts(
      'Clean Architecture & Layering Specialist',
      [
        'Explain why direct presentation-to-infrastructure coupling harms testability and domain invariants.',
        'Recommend routing through an existing application-layer usecase/service if listed, or creating a dedicated port/usecase.'
      ],
      `Target File: ${item.path} (Layer: ${item.evidence?.sourceLayer || 'presentation'})
Description: ${item.description}

Bypassed Infrastructure Targets & Symbol Calls:
${bypassSummary || '- None resolved in graph'}

Existing Application Layer Modules in Workspace:
${appFacades.length > 0 ? appFacades.join(', ') : 'None detected'}

${snippet ? `Source Preview (${item.path}):\n\`\`\`typescript\n${snippet}\n\`\`\`` : ''}`
    );

    return {
      ...promptInput,
      targetedEvidence: { bypassedTargets: bypassedTargets.map((b) => b.target), appFacades }
    };
  }
}
