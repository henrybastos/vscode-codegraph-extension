import type { DirectedGraph } from 'graphology';
import { isTestOrMockPath, type ArchitectureRule, type FlaggedCandidate, type RuleContext } from '../types.js';
import * as path from 'node:path';

export class ApiDecompositionRule implements ArchitectureRule {
  public readonly id = 'api-decomposition';
  public readonly name = 'API & Granularity Decomposition';

  detect(graph: DirectedGraph, ctx: RuleContext): FlaggedCandidate[] {
    const candidates: FlaggedCandidate[] = [];
    const symbolGraph = ctx.symbolGraph;

    // 1. Group symbols by file path
    const fileMethods = new Map<
      string,
      Array<{
        id: string;
        name: string;
        loc: number;
        externalCalls: number;
        summary: string;
        isRouteHandler: boolean;
        callees: string[];
      }>
    >();

    symbolGraph.forEachNode((nodeId, attrs: any) => {
      const fp: string = (attrs.filePath || '').replace(/\\/g, '/');
      if (!fp) return;

      if (attrs.kind === 'function' || attrs.kind === 'method') {
        if (!fileMethods.has(fp)) fileMethods.set(fp, []);
        const start = attrs.startLine || 1;
        const end = attrs.endLine || start;
        const loc = end - start + 1;
        const summary: string = attrs.summary || '';
        const isRouteHandler = /@(Get|Post|Put|Delete|Patch|Options|Head)/i.test(summary);

        const callees: string[] = [];
        symbolGraph.forEachOutEdge(nodeId, (_edge, _edgeAttrs, _src, target) => {
          callees.push(target);
        });

        fileMethods.get(fp)!.push({
          id: nodeId,
          name: attrs.name,
          loc,
          externalCalls: callees.length,
          summary,
          isRouteHandler,
          callees
        });
      }
    });

    // 2. Evaluate Controllers and Use Cases / Services
    for (const [filePath, methods] of fileMethods.entries()) {
      const p = filePath.toLowerCase();
      const isController = p.endsWith('.controller.ts');
      const isUseCaseOrService = p.endsWith('.usecase.ts') || p.endsWith('.service.ts');
      const fileMetric = ctx.fileMetrics.get(filePath);
      const fileLoc = fileMetric?.loc || methods.reduce((acc, m) => acc + m.loc, 0);

      // Pattern A: Fat Controller -> Extract *.usecase.ts
      if (isController) {
        const heavyRoutes = methods.filter((m) => m.loc >= 25 || m.externalCalls >= 4);
        const totalExternalCalls = methods.reduce((acc, m) => acc + m.externalCalls, 0);

        if (heavyRoutes.length >= 3 || (fileLoc > 180 && totalExternalCalls > 10)) {
          // Check sibling files for existing usecases directory
          const dir = path.posix.dirname(filePath);
          const hasSiblingUsecaseDir = Array.from(graph.nodes()).some((f) =>
            f.replace(/\\/g, '/').startsWith(`${dir}/usecases/`)
          );

          const baseName = path.posix.basename(filePath);
          const suggestedSubdir = hasSiblingUsecaseDir ? 'usecases' : 'usecases';
          const defaultExtractions = heavyRoutes.map((m) => {
            const cleanName = m.name.replace(/^.*[.#]/, '');
            const kebab = cleanName
              .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
              .toLowerCase()
              .replace(/[^a-z0-9-]/g, '');
            return `${suggestedSubdir}/${kebab}.usecase.ts`;
          });

          candidates.push({
            id: `api-decomp-ctrl-${filePath.replace(/[^a-zA-Z0-9]/g, '_')}`,
            ruleId: this.id,
            type: 'file',
            path: filePath,
            category: 'API Decomposition',
            severity: heavyRoutes.length >= 4 ? 'high' : 'medium',
            title: `Fat Controller: ${baseName}`,
            description: `Controller contains ${heavyRoutes.length} heavy route handlers (${methods.length} total methods, ${fileLoc} LOC). Extract individual workflows into dedicated use case files.`,
            metrics: {
              loc: fileLoc,
              methodCount: methods.length,
              fanOut: totalExternalCalls
            },
            evidence: {
              pattern: 'EXTRACT_USECASES',
              methods: methods.map((m) => ({ name: m.name, loc: m.loc, externalCalls: m.externalCalls })),
              suggestedFiles: defaultExtractions.slice(0, 5),
              hasSiblingUsecaseDir
            },
            suggestedFiles: defaultExtractions.slice(0, 5)
          });
        }
      }

      // Pattern B: Bloated Use Case / Service -> Split into *.handler.ts
      if (isUseCaseOrService) {
        if (fileLoc > 250 && methods.length > 5) {
          // Check if methods access disjoint sets of callees (multi-command dumping ground)
          const distinctCalleeSets = methods.filter((m) => m.externalCalls > 0);
          const isMultiResponsibility = distinctCalleeSets.length >= 4;

          if (isMultiResponsibility) {
            const baseName = path.posix.basename(filePath);
            const defaultHandlers = methods
              .filter((m) => !m.name.includes('validate') && !m.name.includes('map') && !m.name.includes('helper'))
              .slice(0, 4)
              .map((m) => {
                const cleanName = m.name.replace(/^.*[.#]/, '');
                const kebab = cleanName
                  .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
                  .toLowerCase()
                  .replace(/[^a-z0-9-]/g, '');
                return `handlers/${kebab}.handler.ts`;
              });

            candidates.push({
              id: `api-decomp-usecase-${filePath.replace(/[^a-zA-Z0-9]/g, '_')}`,
              ruleId: this.id,
              type: 'file',
              path: filePath,
              category: 'API Decomposition',
              severity: 'medium',
              title: `Bloated Use Case: ${baseName}`,
              description: `Multi-responsibility use case/service (${methods.length} methods, ${fileLoc} LOC) spanning multiple command workflows. Split into granular command handlers.`,
              metrics: {
                loc: fileLoc,
                methodCount: methods.length
              },
              evidence: {
                pattern: 'SPLIT_HANDLERS',
                methods: methods.map((m) => ({ name: m.name, loc: m.loc })),
                suggestedFiles: defaultHandlers
              },
              suggestedFiles: defaultHandlers
            });
          }
        }
      }
    }

    return candidates;
  }

  shouldIgnore(candidate: FlaggedCandidate, _graph: DirectedGraph, _ctx: RuleContext): boolean {
    // 1. Ignore test and mock files
    if (isTestOrMockPath(candidate.path)) {
      return true;
    }

    const pattern = candidate.evidence?.pattern;
    const methods: Array<{ name: string; loc: number; externalCalls?: number }> =
      candidate.evidence?.methods || [];

    // 2. Controller filter: Whitelist thin CRUD/proxy controllers
    // where every method is < 15 LOC and delegates directly
    if (pattern === 'EXTRACT_USECASES') {
      const allThin = methods.length > 0 && methods.every((m) => m.loc < 15 && (m.externalCalls ?? 0) <= 2);
      if (allThin) {
        return true;
      }
    }

    // 3. Use Case filter: Whitelist single-purpose use cases
    // that have only 1 main execute() method with small private helpers
    if (pattern === 'SPLIT_HANDLERS') {
      const publicMethods = methods.filter((m) => !m.name.includes('#') && !m.name.startsWith('_'));
      const executeMethods = publicMethods.filter((m) =>
        /execute|handle|perform|run/i.test(m.name.replace(/^.*[.#]/, ''))
      );
      if (executeMethods.length === 1 && publicMethods.length <= 2) {
        return true;
      }
    }

    return false;
  }

  buildSlmValidationPrompt(candidate: FlaggedCandidate, _ctx: RuleContext): string {
    const pattern = candidate.evidence?.pattern;
    const methods: Array<{ name: string; loc: number }> = candidate.evidence?.methods || [];
    const methodSummary = methods
      .slice(0, 10)
      .map((m) => `${m.name} (${m.loc} lines)`)
      .join(', ');

    const actionText =
      pattern === 'EXTRACT_USECASES'
        ? 'extracting heavy route methods into dedicated *.usecase.ts files'
        : 'splitting multiple public methods into dedicated *.handler.ts files';

    return `File: ${candidate.path}
Pattern: ${pattern}
Methods: ${methodSummary || 'None listed'}
Total LOC: ${candidate.metrics?.loc || 'N/A'}

Task: Determine if this file genuinely mixes multiple workflows and would benefit from ${actionText}.
Suggest 2-4 clean kebab-case target file paths (e.g. "usecases/create-invoice.usecase.ts" or "handlers/cancel-subscription.handler.ts").
Respond strictly in JSON: {"isViolation": boolean, "reason": string, "suggestedFiles": string[]}`;
  }
}
