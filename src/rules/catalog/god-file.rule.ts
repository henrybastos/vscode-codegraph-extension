import { DirectedGraph } from 'graphology';
// @ts-ignore
import louvain from 'graphology-communities-louvain';
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
  getFileSymbols,
  normalizeRelPath,
  readSnippet,
  resolveFileGraphNode
} from './targeted-helpers.js';

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

  buildTargetedAnalysis(ctx: TargetedAnalysisContext): TargetedAnalysisReportInput {
    const { item, fileGraph, symbolGraph, workspaceRoot } = ctx;
    const resolvedFile = resolveFileGraphNode(fileGraph, item.path) || item.path;
    const symbols = getFileSymbols(symbolGraph, item.path);

    // Build internal symbol + shared-external-target graph for Louvain responsibility clustering
    const clusterGraph = new DirectedGraph();
    const symbolIds = new Set(symbols.map((s) => s.id));
    for (const sym of symbols) {
      clusterGraph.addNode(sym.id, { name: sym.name, kind: sym.kind });
    }

    const externalTargetOwners = new Map<string, string[]>();
    for (const sym of symbols) {
      if (!symbolGraph.hasNode(sym.id)) continue;
      symbolGraph.forEachOutEdge(sym.id, (_e, _attrs, _s, tgt) => {
        if (symbolIds.has(tgt) && sym.id !== tgt) {
          clusterGraph.mergeEdge(sym.id, tgt);
        } else {
          const tgtAttrs: any = symbolGraph.hasNode(tgt) ? symbolGraph.getNodeAttributes(tgt) : null;
          const tgtFile = normalizeRelPath(tgtAttrs?.filePath || tgt.split('::')[0]);
          if (tgtFile) {
            const owners = externalTargetOwners.get(tgtFile) || [];
            owners.push(sym.id);
            externalTargetOwners.set(tgtFile, owners);
          }
        }
      });
    }

    for (const owners of externalTargetOwners.values()) {
      for (let i = 1; i < owners.length; i++) {
        if (owners[0] !== owners[i]) {
          clusterGraph.mergeEdge(owners[0], owners[i]);
        }
      }
    }

    let communities: Record<string, number> = {};
    try {
      communities = clusterGraph.order > 1 && clusterGraph.size > 0 ? louvain(clusterGraph) : {};
    } catch {
      communities = {};
    }

    const clusters = new Map<number, string[]>();
    for (const sym of symbols) {
      const cid = communities[sym.id] ?? 0;
      const list = clusters.get(cid) || [];
      list.push(`${sym.name} (${sym.kind}, ${sym.loc} LOC)`);
      clusters.set(cid, list);
    }

    const clusterSummary = Array.from(clusters.entries())
      .map(([cid, list]) => `- Cluster ${cid + 1}: ${list.slice(0, 10).join(', ')}${list.length > 10 ? ` (+${list.length - 10} more)` : ''}`)
      .join('\n');

    const callers = fileGraph.hasNode(resolvedFile) ? fileGraph.inNeighbors(resolvedFile).slice(0, 8) : [];
    const callees = fileGraph.hasNode(resolvedFile) ? fileGraph.outNeighbors(resolvedFile).slice(0, 8) : [];
    const snippet = readSnippet(workspaceRoot, item.path, undefined, undefined, 130);

    const promptInput = formatTargetedPrompts(
      'Modular Decomposition & Cohesion Specialist',
      [
        'Use the Louvain responsibility clusters to propose cohesive file splits without breaking existing callers.',
        'If the file is a single cohesive facade/class, state how to extract only its auxiliary helpers.'
      ],
      `Target File: ${item.path}
Metrics: LOC=${item.metrics?.loc ?? 'N/A'}, Symbols=${symbols.length}, Fan-In=${item.metrics?.fanIn ?? callers.length}, Fan-Out=${item.metrics?.fanOut ?? callees.length}, Instability=${item.metrics?.instability ?? 'N/A'}

Louvain Responsibility Clusters (${clusters.size} detected):
${clusterSummary || '- No internal symbols indexed'}

Top File Callers (Dependents): ${callers.join(', ') || 'None'}
Top File Callees (Dependencies): ${callees.join(', ') || 'None'}

${snippet ? `Source Preview (${item.path}):\n\`\`\`typescript\n${snippet}\n\`\`\`` : ''}`
    );

    return {
      ...promptInput,
      targetedEvidence: { clusterCount: clusters.size, symbolCount: symbols.length }
    };
  }
}
