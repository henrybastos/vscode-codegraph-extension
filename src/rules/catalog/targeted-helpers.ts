import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DirectedGraph } from 'graphology';
import type { TargetedAnalysisReportInput } from '../types.js';

export interface FileSymbolInfo {
  id: string;
  filePath: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  loc: number;
  summary: string;
  inDegree: number;
  outDegree: number;
}

export function normalizeRelPath(p: string): string {
  return (p || '').replace(/\\/g, '/').replace(/^[/\\]+/, '');
}

/**
 * Resolves a node key in fileGraph matching targetPath (case-insensitive fallback).
 */
export function resolveFileGraphNode(fileGraph: DirectedGraph, targetPath: string): string | null {
  if (fileGraph.hasNode(targetPath)) return targetPath;
  const norm = normalizeRelPath(targetPath).toLowerCase();
  for (const node of fileGraph.nodes()) {
    if (normalizeRelPath(node).toLowerCase() === norm) {
      return node;
    }
  }
  return null;
}

/**
 * Collects all AST symbols belonging to a file (or folder prefix) from symbolGraph.
 */
export function getFileSymbols(
  symbolGraph: DirectedGraph,
  targetPath: string,
  isFolder = false
): FileSymbolInfo[] {
  const normTarget = normalizeRelPath(targetPath).toLowerCase();
  const symbols: FileSymbolInfo[] = [];

  symbolGraph.forEachNode((nodeId, attrs: any) => {
    const nodePath = normalizeRelPath(attrs?.filePath || '').toLowerCase();
    const matches = isFolder
      ? nodePath === normTarget || nodePath.startsWith(`${normTarget}/`)
      : nodePath === normTarget;

    if (!matches) return;

    const startLine = Number(attrs?.startLine) || 1;
    const endLine = Number(attrs?.endLine) || startLine;
    symbols.push({
      id: nodeId,
      filePath: normalizeRelPath(attrs?.filePath || ''),
      name: attrs?.name || nodeId,
      kind: attrs?.kind || 'symbol',
      startLine,
      endLine,
      loc: Math.max(1, endLine - startLine + 1),
      summary: attrs?.summary || '',
      inDegree: symbolGraph.inDegree(nodeId),
      outDegree: symbolGraph.outDegree(nodeId)
    });
  });

  return symbols;
}

/**
 * Returns symbol-level edges between two files (e.g. `fnA() --[CALLS]--> repoMethod()`).
 */
export function getCrossFileSymbolRelations(
  symbolGraph: DirectedGraph,
  sourcePath: string,
  targetPath: string,
  limit = 12
): string[] {
  const normSrc = normalizeRelPath(sourcePath).toLowerCase();
  const normTgt = normalizeRelPath(targetPath).toLowerCase();
  const relations = new Set<string>();

  symbolGraph.forEachEdge((_edge, edgeAttrs: any, srcId, tgtId) => {
    if (relations.size >= limit) return;
    const srcAttrs: any = symbolGraph.hasNode(srcId) ? symbolGraph.getNodeAttributes(srcId) : null;
    const tgtAttrs: any = symbolGraph.hasNode(tgtId) ? symbolGraph.getNodeAttributes(tgtId) : null;

    const srcFile = normalizeRelPath(srcAttrs?.filePath || srcId.split('::')[0]).toLowerCase();
    const tgtFile = normalizeRelPath(tgtAttrs?.filePath || tgtId.split('::')[0]).toLowerCase();

    if (srcFile === normSrc && tgtFile === normTgt) {
      const rel = edgeAttrs?.relation || 'LINKS';
      const srcLabel = `${srcAttrs?.name || srcId} (L${srcAttrs?.startLine || '?'})`;
      const tgtLabel = tgtAttrs?.name || tgtId;
      relations.add(`${srcLabel} --[${rel}]--> ${tgtLabel}`);
    }
  });

  return Array.from(relations);
}

/**
 * Reads a bounded snippet of a workspace file (either a specific line range or top lines).
 */
export function readSnippet(
  workspaceRoot: string | undefined,
  relPath: string,
  startLine?: number,
  endLine?: number,
  maxLines = 150
): string {
  if (!workspaceRoot) return '';
  try {
    const cleanRel = normalizeRelPath(relPath);
    const fullPath = path.resolve(workspaceRoot, cleanRel);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return '';

    const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
    if (startLine && endLine && startLine <= endLine && startLine <= lines.length) {
      const sliceStart = Math.max(0, startLine - 1);
      const sliceEnd = Math.min(lines.length, Math.min(endLine, sliceStart + maxLines));
      return lines.slice(sliceStart, sliceEnd).join('\n');
    }

    const preview = lines.slice(0, maxLines).join('\n');
    return lines.length > maxLines
      ? `${preview}\n// ... [${lines.length - maxLines} more lines omitted]`
      : preview;
  } catch {
    return '';
  }
}

/**
 * Formats a rule-specific system + user prompt pair requesting a structured report on
 * current symptoms, graph relations, and concrete solutions.
 */
export function formatTargetedPrompts(
  specialistRole: string,
  domainRules: string[],
  userBody: string
): TargetedAnalysisReportInput {
  const rulesText = domainRules.map((r) => `- ${r}`).join('\n');
  const systemPrompt = `You are a ${specialistRole} specializing in TypeScript/JavaScript architecture.
CRITICAL RULES:
- Base your report strictly on the real files, symbols, metrics, and graph relations provided. Never invent classes or metrics.
- Static graph terms (fan-in, fan-out, instability, communities) are measurements, NOT domain classes to create.
${rulesText}

Format your report in concise Markdown with exactly these 3 sections:
1. 🔍 **Current Symptoms** (What is happening right now and why it matters)
2. 🔗 **Graph & Symbol Relations** (Key callers, callees, cycles, or clusters involved)
3. 🛠️ **How to Solve It** (Concrete, step-by-step refactoring actions)`;

  return {
    systemPrompt,
    userPrompt: userBody.trim()
  };
}
