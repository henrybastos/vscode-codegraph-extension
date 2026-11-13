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

export class UnstableFoundationRule implements ArchitectureRule {
  public readonly id = 'unstable-foundation';
  public readonly name = 'Unstable Foundation (SDP)';

  detect(graph: DirectedGraph, ctx: RuleContext): FlaggedCandidate[] {
    const candidates: FlaggedCandidate[] = [];

    for (const file of graph.nodes()) {
      const fanIn = graph.inDegree(file);
      const fanOut = graph.outDegree(file);
      const total = fanIn + fanOut;
      const instability = total === 0 ? 0 : fanOut / total;

      // Unstable Foundation: heavily relied upon (fanIn >= 4) but also heavily dependent on other modules (I > 0.6)
      if (fanIn >= 4 && instability > 0.6) {
        candidates.push({
          id: `unstable-${file.replace(/[^a-zA-Z0-9]/g, '_')}`,
          ruleId: this.id,
          type: 'file',
          path: file,
          category: 'Unstable Foundation',
          severity: fanIn > 8 ? 'critical' : 'high',
          title: `Unstable Core: ${path.basename(file)}`,
          description: `Core file is heavily depended on (fan-in: ${fanIn}) but has high instability (I = ${instability.toFixed(2)}, fan-out: ${fanOut}), violating the Stable Dependencies Principle (SDP).`,
          metrics: {
            fanIn,
            fanOut,
            instability: Math.round(instability * 100) / 100
          },
          evidence: { fanIn, fanOut, instability }
        });
      }
    }

    return candidates;
  }

  async shouldIgnore(
    candidate: FlaggedCandidate,
    _graph: DirectedGraph,
    ctx: RuleContext
  ): Promise<boolean> {
    const normalizedPath = candidate.path.replace(/\\/g, '/');

    // 1. Fast deterministic filter (0ms): Ignore test/mock files
    if (isTestOrMockPath(normalizedPath)) {
      return true;
    }

    // 2. Semantic ONNX Module Classification (~2-4ms):
    // Replaces hardcoded checks for framework wiring files, DI containers, composition roots
    if (ctx.roleClassifier && ctx.roleClassifier.isInitialized()) {
      const classification = await ctx.roleClassifier.classifyModuleRole(normalizedPath);

      if (candidate.evidence) {
        candidate.evidence.inferredRole = classification.role;
        candidate.evidence.roleConfidence = classification.score;
      }

      return classification.role === 'composition_root_wiring';
    }

    return false;
  }

  buildTargetedAnalysis(ctx: TargetedAnalysisContext): TargetedAnalysisReportInput {
    const { item, fileGraph, symbolGraph, workspaceRoot } = ctx;
    const resolvedFile = resolveFileGraphNode(fileGraph, item.path) || item.path;

    const dependents = fileGraph.hasNode(resolvedFile) ? fileGraph.inNeighbors(resolvedFile) : [];
    const dependencies = fileGraph.hasNode(resolvedFile) ? fileGraph.outNeighbors(resolvedFile) : [];
    const fanIn = item.metrics?.fanIn ?? dependents.length;
    const fanOut = item.metrics?.fanOut ?? dependencies.length;
    const instability = fanIn + fanOut > 0 ? fanOut / (fanIn + fanOut) : 0;

    const depDetails = dependencies.slice(0, 10).map((dep) => {
      const syms = getCrossFileSymbolRelations(symbolGraph, resolvedFile, dep, 4);
      return `- ${dep}${syms.length ? ` (${syms.join('; ')})` : ''}`;
    });

    const callerDetails = dependents.slice(0, 10).map((caller) => {
      const syms = getCrossFileSymbolRelations(symbolGraph, caller, resolvedFile, 3);
      return `- ${caller}${syms.length ? ` (${syms.join('; ')})` : ''}`;
    });

    const snippet = readSnippet(workspaceRoot, item.path, undefined, undefined, 120);

    const promptInput = formatTargetedPrompts(
      'Stable Dependencies Principle (SDP) & Interface Architect',
      [
        'Explain the blast radius (high fan-in) combined with outbound volatility (high fan-out / instability).',
        'Propose stabilizing this module via Stable Abstractions (extracting interfaces/ports or inverting dependencies on volatile callees).'
      ],
      `Target File: ${item.path}
Metrics: Fan-In=${fanIn}, Fan-Out=${fanOut}, Instability I=${instability.toFixed(2)} (threshold > 0.60)

Dependents (Blast Radius — ${dependents.length} files depend on this):
${callerDetails.join('\n') || '- None'}

Outbound Dependencies (Volatility Drivers — depends on ${dependencies.length} files):
${depDetails.join('\n') || '- None'}

${snippet ? `Source Preview (${item.path}):\n\`\`\`typescript\n${snippet}\n\`\`\`` : ''}`
    );

    return {
      ...promptInput,
      targetedEvidence: { fanIn, fanOut, instability, dependentCount: dependents.length, dependencyCount: dependencies.length }
    };
  }
}
