import type { DirectedGraph } from 'graphology';
import type { ArchitectureRule, FlaggedCandidate, RuleContext } from '../types.js';
import * as path from 'node:path';

export class FeatureEnvyRule implements ArchitectureRule {
  public readonly id = 'feature-envy';
  public readonly name = 'Feature Envy';

  detect(_graph: DirectedGraph, ctx: RuleContext): FlaggedCandidate[] {
    const candidates: FlaggedCandidate[] = [];
    const symbolGraph = ctx.symbolGraph;

    symbolGraph.forEachNode((fnNodeId, attrs: any) => {
      if (attrs?.kind !== 'function') return;

      const fnFilePath: string = attrs.filePath || '';
      if (!fnFilePath) return;

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
          const tgtFile = tgtAttrs?.filePath || target.split('::')[0];

          if (tgtFile && tgtFile !== fnFilePath) {
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
          candidates.push({
            id: `feature-envy-${fnNodeId.replace(/[^a-zA-Z0-9]/g, '_')}`,
            ruleId: this.id,
            type: 'file',
            path: fnFilePath,
            category: 'Feature Envy',
            severity: 'medium',
            title: `Feature Envy: ${attrs.name}()`,
            description: `Function '${attrs.name}' makes ${callCount} calls to external module '${path.basename(targetFile)}' compared to ${localCalls} local calls, suggesting misplaced responsibility.`,
            evidence: {
              functionName: attrs.name,
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

  shouldIgnore(candidate: FlaggedCandidate, _graph: DirectedGraph, _ctx: RuleContext): boolean {
    const fnName = (candidate.evidence?.functionName || '').toLowerCase();
    const filePath = candidate.path.toLowerCase();

    // 1. Ignore test and mock files
    if (filePath.endsWith('.spec.ts') || filePath.endsWith('.test.ts') || filePath.includes('/test/')) {
      return true;
    }

    // 2. Ignore mapper, serializer, transformer functions
    if (
      fnName.includes('todto') ||
      fnName.includes('fromentity') ||
      fnName.includes('map') ||
      fnName.includes('serialize') ||
      fnName.includes('deserialize') ||
      fnName.includes('convert')
    ) {
      return true;
    }

    // 3. Ignore builders and factory patterns
    if (fnName.startsWith('create') || fnName.startsWith('build') || fnName.startsWith('make')) {
      return true;
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
}
