import type { DirectedGraph } from 'graphology';
import {
  isTestOrMockPath,
  type ArchitectureRule,
  type FlaggedCandidate,
  type RuleContext,
  type TargetedAnalysisContext,
  type TargetedAnalysisReportInput
} from '../types.js';
import { searchSymbols } from '../../storage/sync.js';
import { formatTargetedPrompts, getFileSymbols, readSnippet } from './targeted-helpers.js';

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

  async buildTargetedAnalysis(ctx: TargetedAnalysisContext): Promise<TargetedAnalysisReportInput> {
    const { item, symbolGraph, db, workspaceRoot } = ctx;
    const symbols = getFileSymbols(symbolGraph, item.path);
    const deadSymbols = item.evidence?.symbolName
      ? symbols.filter((s) => s.name === item.evidence?.symbolName)
      : symbols.filter((s) => s.inDegree === 0 && s.summary.includes('[exported]'));

    const primary = deadSymbols[0] || symbols[0];
    const targetName = item.evidence?.symbolName || primary?.name || 'unknown';
    const outgoingDeps: string[] = [];

    if (primary && symbolGraph.hasNode(primary.id)) {
      for (const outId of symbolGraph.outNeighbors(primary.id).slice(0, 10)) {
        const attrs: any = symbolGraph.hasNode(outId) ? symbolGraph.getNodeAttributes(outId) : null;
        outgoingDeps.push(`${attrs?.name || outId} (${attrs?.filePath || ''})`);
      }
    }

    let indirectHits: string[] = [];
    if (targetName && targetName !== 'unknown') {
      try {
        const matches = await searchSymbols(db, targetName, 6);
        indirectHits = matches
          .filter((m) => m.file_path !== item.path)
          .map((m) => `${m.name} in ${m.file_path}:${m.start_line}`);
      } catch {
        indirectHits = [];
      }
    }

    const snippet = readSnippet(workspaceRoot, item.path, primary?.startLine, primary?.endLine, 100);

    const promptInput = formatTargetedPrompts(
      'Dead Code & API Surface Hygiene Specialist',
      [
        'Confirm whether the symbol is truly dead code, an unused export that should become module-private, or an entry point invoked dynamically (DI, reflection, CLI, route).',
        'Cite outgoing dependencies that would also become dead if removed.'
      ],
      `Target File: ${item.path}
Dead Export(s): ${deadSymbols.map((s) => `${s.name} (${s.kind}, L${s.startLine}-L${s.endLine})`).join(', ') || targetName}
Graph In-Degree: 0 callers/references

Outgoing Dependencies Held Alive by This Symbol:
${outgoingDeps.join('\n') || '- None'}

FTS5 Indirect Name Matches Elsewhere in Codebase:
${indirectHits.join('\n') || '- None found'}

${snippet ? `Symbol Source:\n\`\`\`typescript\n${snippet}\n\`\`\`` : ''}`
    );

    return {
      ...promptInput,
      targetedEvidence: {
        deadSymbolCount: deadSymbols.length,
        outgoingDepCount: outgoingDeps.length,
        indirectHits
      }
    };
  }
}
