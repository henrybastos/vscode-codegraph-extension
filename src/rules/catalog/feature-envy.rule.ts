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
  getFileSymbols,
  normalizeRelPath,
  readSnippet
} from './targeted-helpers.js';

export class FeatureEnvyRule implements ArchitectureRule {
  public readonly id = 'feature-envy';
  public readonly name = 'Feature Envy';

  detect(_graph: DirectedGraph, ctx: RuleContext): FlaggedCandidate[] {
    const candidates: FlaggedCandidate[] = [];
    const symbolGraph = ctx.symbolGraph;

    symbolGraph.forEachNode((fnNodeId, attrs: any) => {
      if (attrs?.kind !== 'function') return;

      const fnFilePath: string = (attrs.filePath || '').replace(/\\/g, '/');
      if (!fnFilePath) return;

      const fnName: string = attrs.name || '';

      // Group outgoing calls by target file
      const externalCallsByFile = new Map<string, number>();
      let localCalls = 0;

      symbolGraph.forEachOutEdge(fnNodeId, (edge, edgeAttrs: any, source, target) => {
        const weight = edgeAttrs?.weight || 1;
        if (edgeAttrs?.relation === 'CALLS_LOCAL') {
          localCalls += weight;
          return;
        }

        if (edgeAttrs?.relation === 'CALLS') {
          const tgtAttrs: any = symbolGraph.hasNode(target) ? symbolGraph.getNodeAttributes(target) : null;
          const tgtFile = (tgtAttrs?.filePath || target.split('::')[0]).replace(/\\/g, '/');

          if (tgtFile && tgtFile !== fnFilePath) {
            const normFnDir = path.posix.dirname(fnFilePath).toLowerCase();
            const normTgtDir = path.posix.dirname(tgtFile).toLowerCase();

            // 2. If target is in a child handlers/ or usecases/ directory, it is modular handler delegation, not envy
            if (normTgtDir.startsWith(normFnDir + '/handlers') || normTgtDir.startsWith(normFnDir + '/usecases')) {
              return;
            }

            // 3. If target is a barrel file (index.ts/index.js), calls to multiple distinct handlers must not be lumped together
            if (path.posix.basename(tgtFile).startsWith('index.')) {
              return;
            }

            const count = (externalCallsByFile.get(tgtFile) || 0) + weight;
            externalCallsByFile.set(tgtFile, count);
          } else {
            localCalls += weight;
          }
        }
      });

      // Find if any single external file is called >= 4 times and outnumbers local calls
      for (const [targetFile, callCount] of externalCallsByFile.entries()) {
        if (callCount >= 4 && callCount > localCalls) {
          const start = attrs.startLine || 1;
          const end = attrs.endLine || start;
          const fnLoc = end - start + 1;
          const fanIn = symbolGraph.inDegree(fnNodeId);
          const fanOut = symbolGraph.outDegree(fnNodeId);

          candidates.push({
            id: `feature-envy-${fnNodeId.replace(/[^a-zA-Z0-9]/g, '_')}`,
            ruleId: this.id,
            type: 'file',
            path: fnFilePath,
            category: 'Feature Envy',
            severity: 'medium',
            title: `Feature Envy: ${attrs.name}()`,
            description: `Function '${attrs.name}' makes ${callCount} calls to external module '${path.basename(targetFile)}' compared to ${localCalls} local calls, suggesting misplaced responsibility.`,
            metrics: {
              loc: fnLoc,
              fanIn,
              fanOut
            },
            evidence: {
              functionName: attrs.name,
              startLine: start,
              endLine: end,
              targetFile,
              callCount,
              localCalls
            }
          });
        }
      }
    });

    return candidates;
  }

  async shouldIgnore(
    candidate: FlaggedCandidate,
    _graph: DirectedGraph,
    ctx: RuleContext
  ): Promise<boolean> {
    const rawFnName = candidate.evidence?.functionName || candidate.evidence?.symbolName || '';
    const normalizedPath = candidate.path.replace(/\\/g, '/');

    // 1. Fast deterministic filter (0ms): Ignore test and mock files before running ONNX
    if (isTestOrMockPath(normalizedPath)) {
      return true;
    }

    // 2. Semantic ONNX Role Classification (~2-4ms):
    // Replaces hardcoded checks for mappers, factories/builders, and event routers/webhooks
    if (ctx.roleClassifier && ctx.roleClassifier.isInitialized()) {
      const classification = await ctx.roleClassifier.classify(rawFnName, normalizedPath);

      // Attach inferred role and confidence to candidate evidence
      if (candidate.evidence) {
        candidate.evidence.inferredRole = classification.role;
        candidate.evidence.roleConfidence = classification.score;
      }

      return classification.shouldIgnore;
    }

    return false;
  }

  buildSlmValidationPrompt(candidate: FlaggedCandidate, _ctx: RuleContext): string {
    const fnName = candidate.evidence?.functionName || 'function';
    const target = candidate.evidence?.targetFile ? path.basename(candidate.evidence.targetFile) : 'external module';
    const calls = candidate.evidence?.callCount || 4;
    const local = candidate.evidence?.localCalls || 0;

    return `Function: ${fnName} in ${candidate.path}
External Target: ${target} (${calls} calls)
Local Scope Calls: ${local}

Question: Is this function a legitimate data mapper, transformer, or orchestrator (valid), or does it exhibit Feature Envy with business logic that should be moved closer to ${target} (violation)?`;
  }

  buildTargetedAnalysis(ctx: TargetedAnalysisContext): TargetedAnalysisReportInput {
    const { item, symbolGraph, workspaceRoot } = ctx;
    const fnName = item.evidence?.functionName || '';
    const symbols = getFileSymbols(symbolGraph, item.path);
    const focalSymbol =
      symbols.find((s) => s.name === fnName) ||
      symbols.find((s) => s.kind === 'function');

    const startLine = item.evidence?.startLine || focalSymbol?.startLine;
    const endLine = item.evidence?.endLine || focalSymbol?.endLine;

    const externalCalls = new Map<string, string[]>();
    const localCalls: string[] = [];

    if (focalSymbol && symbolGraph.hasNode(focalSymbol.id)) {
      const normFocalFile = normalizeRelPath(item.path).toLowerCase();
      symbolGraph.forEachOutEdge(focalSymbol.id, (_e, edgeAttrs: any, _s, tgt) => {
        const tgtAttrs: any = symbolGraph.hasNode(tgt) ? symbolGraph.getNodeAttributes(tgt) : null;
        const tgtFile = normalizeRelPath(tgtAttrs?.filePath || tgt.split('::')[0]);
        const tgtName = tgtAttrs?.name || tgt;

        if (edgeAttrs?.relation === 'CALLS_LOCAL' || tgtFile.toLowerCase() === normFocalFile) {
          localCalls.push(tgtName);
        } else if (tgtFile) {
          const list = externalCalls.get(tgtFile) || [];
          list.push(tgtName);
          externalCalls.set(tgtFile, list);
        }
      });
    }

    const externalBreakdown = Array.from(externalCalls.entries())
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 6)
      .map(([file, calls]) => `- ${file} (${calls.length} calls): ${Array.from(new Set(calls)).slice(0, 8).join(', ')}`)
      .join('\n');

    const snippet = readSnippet(workspaceRoot, item.path, startLine, endLine, 120);

    const promptInput = formatTargetedPrompts(
      'Object-Oriented Design & Coupling Refactoring Specialist',
      [
        'Domain Realism: Webhook/event dispatchers or service orchestrators calling multiple domain handlers/SDKs are valid orchestrators—if this is one, state so clearly instead of forcing artificial moves.',
        'Otherwise, recommend Move Method or Extract Collaborator toward the heavily envied target module.'
      ],
      `Target Function: ${fnName || focalSymbol?.name || 'unknown'} in ${item.path} (L${startLine ?? '?'}-L${endLine ?? '?'})
Envied Target: ${item.evidence?.targetFile || 'See external calls below'}
Call Ratio: ${item.evidence?.callCount ?? 'N/A'} calls to target vs ${item.evidence?.localCalls ?? localCalls.length} local calls

External Calls by Target Module:
${externalBreakdown || '- None resolved in symbolGraph'}

Local Calls: ${Array.from(new Set(localCalls)).slice(0, 10).join(', ') || 'None'}

${snippet ? `Focal Function Source:\n\`\`\`typescript\n${snippet}\n\`\`\`` : ''}`
    );

    return {
      ...promptInput,
      targetedEvidence: {
        functionName: fnName || focalSymbol?.name,
        externalTargets: Array.from(externalCalls.keys()),
        localCallCount: localCalls.length
      }
    };
  }
}

