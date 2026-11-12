import { DirectedGraph } from 'graphology';
import * as path from 'node:path';
// @ts-ignore
import dag from 'graphology-dag';
// @ts-ignore
import pagerank from 'graphology-metrics/centrality/pagerank.js';
// @ts-ignore
import betweenness from 'graphology-metrics/centrality/betweenness.js';
// @ts-ignore
import louvain from 'graphology-communities-louvain';
import { detectCyclesInSubgraph } from './metrics.js';
import { isIgnoredPath } from '../parser/watcher.js';

export interface HotspotItem {
  id: string;
  type: 'file' | 'folder';
  path: string;
  category:
    | 'God File'
    | 'Circular Dependency'
    | 'Layer Bypass'
    | 'Mixed Concerns'
    | 'Unstable Foundation'
    | 'Bottleneck Hub'
    | 'Domain Tangling'
    | 'Feature Envy'
    | 'Dead Abstraction'
    | 'API Decomposition'
    | 'Architecture Tip';
  severity: 'critical' | 'high' | 'medium' | 'info';
  title: string;
  description: string;
  suggestedFiles?: string[];
  metrics?: {
    loc?: number;
    fanIn?: number;
    fanOut?: number;
    instability?: number;
    pagerank?: number;
    betweenness?: number;
  };
}

export type ArchitectureLayer = 'presentation' | 'application' | 'domain' | 'infrastructure' | 'shared';

export function classifyLayer(filePath: string): ArchitectureLayer {
  const p = filePath.toLowerCase().replace(/\\/g, '/');
  if (
    p.includes('/components/') ||
    p.includes('/views/') ||
    p.includes('/webview/') ||
    p.includes('/ui/') ||
    p.includes('/pages/')
  ) {
    return 'presentation';
  }
  if (
    p.includes('/storage/') ||
    p.includes('/db/') ||
    p.includes('/repository/') ||
    p.includes('/infra/') ||
    p.includes('/sql/')
  ) {
    return 'infrastructure';
  }
  if (p.includes('/domain/') || p.includes('/models/') || p.includes('/entities/')) {
    return 'domain';
  }
  if (
    p.includes('/services/') ||
    p.includes('/usecases/') ||
    p.includes('/api/') ||
    p.includes('/handlers/')
  ) {
    return 'application';
  }
  return 'shared';
}

function layerToId(layer: ArchitectureLayer): number {
  switch (layer) {
    case 'presentation': return 0.0;
    case 'application': return 0.33;
    case 'domain': return 0.66;
    case 'infrastructure': return 1.0;
    default: return 0.5;
  }
}

export interface FileNodeAttrs {
  filePath: string;
  loc: number;
  symbolCount: number;
  directory: string;
  layer: ArchitectureLayer;
}

/**
 * Projects a symbol-level graph into a clean file-level DirectedGraph
 */
export function buildFileGraph(symbolGraph: DirectedGraph): DirectedGraph {
  const fileGraph = new DirectedGraph();

  // 1. Collect file nodes and aggregate LOC & symbol count
  symbolGraph.forEachNode((nodeId, attrs: any) => {
    const rawPath = attrs.filePath || (attrs.kind === 'file' ? nodeId : null);
    if (!rawPath) return;

    const normalizedPath = rawPath.replace(/\\/g, '/');
    if (isIgnoredPath(normalizedPath)) return;

    if (!fileGraph.hasNode(normalizedPath)) {
      fileGraph.addNode(normalizedPath, {
        filePath: normalizedPath,
        loc: attrs.endLine || 1,
        symbolCount: attrs.kind === 'file' ? 0 : 1,
        directory: path.posix.dirname(normalizedPath),
        layer: classifyLayer(normalizedPath)
      } as FileNodeAttrs);
    } else {
      const existing = fileGraph.getNodeAttributes(normalizedPath) as FileNodeAttrs;
      const updatedLoc = Math.max(existing.loc, attrs.endLine || 1);
      const updatedSymbols = existing.symbolCount + (attrs.kind === 'file' ? 0 : 1);
      fileGraph.mergeNodeAttributes(normalizedPath, {
        loc: updatedLoc,
        symbolCount: updatedSymbols
      });
    }
  });

  // 2. Aggregate edges to file level
  symbolGraph.forEachEdge((edgeId, edgeAttrs: any, source, target) => {
    const srcAttrs: any = symbolGraph.getNodeAttributes(source);
    const tgtAttrs: any = symbolGraph.hasNode(target)
      ? symbolGraph.getNodeAttributes(target)
      : null;

    let srcFile = srcAttrs?.filePath || (srcAttrs?.kind === 'file' ? source : null);
    let tgtFile = tgtAttrs?.filePath || (tgtAttrs?.kind === 'file' ? target : null);

    // If target was an unresolved import path, try resolving to an existing file node
    if (!tgtFile) {
      const cleanTarget = target.split('::')[0].replace(/\\/g, '/');
      const candidates = [
        cleanTarget,
        cleanTarget + '.ts',
        cleanTarget + '.tsx',
        cleanTarget + '.js',
        cleanTarget + '.jsx',
        cleanTarget + '/index.ts',
        cleanTarget + '/index.tsx',
        cleanTarget + '/index.js'
      ];
      for (const cand of candidates) {
        if (fileGraph.hasNode(cand)) {
          tgtFile = cand;
          break;
        }
      }
    }

    if (srcFile && tgtFile) {
      srcFile = srcFile.replace(/\\/g, '/');
      tgtFile = tgtFile.replace(/\\/g, '/');
      if (isIgnoredPath(srcFile) || isIgnoredPath(tgtFile)) return;
      if (srcFile !== tgtFile && fileGraph.hasNode(srcFile) && fileGraph.hasNode(tgtFile)) {
        const isType = edgeAttrs?.relation === 'IMPORTS_TYPE';
        const isReExport = edgeAttrs?.relation === 'RE_EXPORTS';
        if (!fileGraph.hasEdge(srcFile, tgtFile)) {
          fileGraph.addEdge(srcFile, tgtFile, {
            weight: 1,
            isTypeOnly: isType,
            isReExport: isReExport
          });
        } else {
          const w = (fileGraph.getEdgeAttribute(srcFile, tgtFile, 'weight') || 1) + 1;
          const prevType = fileGraph.getEdgeAttribute(srcFile, tgtFile, 'isTypeOnly') ?? true;
          fileGraph.setEdgeAttribute(srcFile, tgtFile, 'weight', w);
          fileGraph.setEdgeAttribute(srcFile, tgtFile, 'isTypeOnly', prevType && isType);
          if (isReExport) {
            fileGraph.setEdgeAttribute(srcFile, tgtFile, 'isReExport', true);
          }
        }
      }
    }
  });

  return fileGraph;
}

export interface Tier0Results {
  deterministicHotspots: HotspotItem[];
  fileMetrics: Map<
    string,
    {
      loc: number;
      symbolCount: number;
      fanIn: number;
      fanOut: number;
      instability: number;
      pagerank: number;
      betweenness: number;
      community: number;
      inCycle: boolean;
    }
  >;
  fileFeatureVectors: Map<string, Float32Array>; // 10D
  folderFeatureVectors: Map<string, { vector: Float32Array; files: string[] }>; // 8D
}

/**
 * Runs Tier 0 Graphology Assertions, Centrality Metrics, and Extracts ML Feature Vectors
 */
export function runTier0Assertions(fileGraph: DirectedGraph): Tier0Results {
  const hotspots: HotspotItem[] = [];
  const fileNodes = fileGraph.nodes();

  // 1. Graphology Centrality & Community Metrics
  let prValues: Record<string, number> = {};
  try {
    prValues = typeof pagerank === 'function' ? pagerank(fileGraph) : {};
  } catch {
    // Fallback if graph is empty or disconnected
    for (const f of fileNodes) prValues[f] = 1 / Math.max(1, fileNodes.length);
  }

  let bwValues: Record<string, number> = {};
  try {
    bwValues = typeof betweenness === 'function' ? betweenness(fileGraph) : {};
  } catch {
    for (const f of fileNodes) bwValues[f] = 0;
  }

  let communities: Record<string, number> = {};
  try {
    communities = typeof louvain === 'function' ? louvain(fileGraph) : {};
  } catch {
    for (const f of fileNodes) communities[f] = 0;
  }

  // 2. Cycle Detection (Tier 0 Deterministic Assertion)
  const cycleNodes = new Set<string>();
  const detectedCycles: string[][] = [];
  try {
    const hasCycles = dag.hasCycle(fileGraph);
    if (hasCycles) {
      const cycles = detectCyclesInSubgraph(fileGraph, fileNodes);
      for (const cycle of cycles) {
        detectedCycles.push(cycle);
        for (const node of cycle) cycleNodes.add(node);
      }
    }
  } catch (err) {
    console.warn('Cycle detection warning:', err);
  }

  // Deduplicate and register Circular Dependency hotspots
  const seenCycleSignatures = new Set<string>();
  for (const cycle of detectedCycles) {
    const sortedSig = [...cycle].sort().join('|');
    if (seenCycleSignatures.has(sortedSig)) continue;
    seenCycleSignatures.add(sortedSig);

    const leadFile = cycle[0];
    const chainDisplay = cycle.map((f) => path.basename(f)).join(' ➔ ');
    hotspots.push({
      id: `cycle-${leadFile}`,
      type: 'file',
      path: leadFile,
      category: 'Circular Dependency',
      severity: 'critical',
      title: 'Circular Dependency Cycle',
      description: `Circular dependency chain detected: ${chainDisplay}. Causes tight coupling and fragile initialization.`
    });
  }

  // 3. Compute Per-File Metrics & Layer Bypass / SDP Violations
  const fileMetrics = new Map<
    string,
    {
      loc: number;
      symbolCount: number;
      fanIn: number;
      fanOut: number;
      instability: number;
      pagerank: number;
      betweenness: number;
      community: number;
      inCycle: boolean;
    }
  >();

  for (const file of fileNodes) {
    const attrs = fileGraph.getNodeAttributes(file) as FileNodeAttrs;
    const fanIn = fileGraph.inDegree(file);
    const fanOut = fileGraph.outDegree(file);
    const total = fanIn + fanOut;
    const instability = total === 0 ? 0 : fanOut / total;
    const pr = prValues[file] || 0;
    const bw = bwValues[file] || 0;
    const comm = communities[file] || 0;
    const inCycle = cycleNodes.has(file);

    fileMetrics.set(file, {
      loc: attrs.loc,
      symbolCount: attrs.symbolCount,
      fanIn,
      fanOut,
      instability: Math.round(instability * 100) / 100,
      pagerank: Math.round(pr * 1000) / 1000,
      betweenness: Math.round(bw * 1000) / 1000,
      community: comm,
      inCycle
    });
  }

  // Check edges for Layer Bypass and Unstable Foundation (SDP)
  fileGraph.forEachEdge((edgeId, edgeAttrs, source, target) => {
    const srcAttrs = fileGraph.getNodeAttributes(source) as FileNodeAttrs;
    const tgtAttrs = fileGraph.getNodeAttributes(target) as FileNodeAttrs;
    const srcMetrics = fileMetrics.get(source)!;
    const tgtMetrics = fileMetrics.get(target)!;

    // Layer Bypass Check: presentation layer -> infrastructure layer
    if (srcAttrs.layer === 'presentation' && tgtAttrs.layer === 'infrastructure') {
      hotspots.push({
        id: `bypass-${source}->${target}`,
        type: 'file',
        path: source,
        category: 'Layer Bypass',
        severity: 'high',
        title: 'Architectural Layer Bypass',
        description: `Presentation component '${path.basename(source)}' directly couples to persistence layer '${path.basename(target)}' bypassing domain/service abstractions.`
      });
    }

    // Unstable Foundation Check (SDP): Highly stable component depending on highly unstable component
    if (srcMetrics.fanIn >= 3 && srcMetrics.instability < 0.35 && tgtMetrics.instability > 0.65 && tgtMetrics.fanOut >= 3) {
      hotspots.push({
        id: `sdp-${source}->${target}`,
        type: 'file',
        path: source,
        category: 'Unstable Foundation',
        severity: 'high',
        title: 'Stable Component Depends on Volatile Dependency',
        description: `Stable core file '${path.basename(source)}' (I=${srcMetrics.instability}) depends on volatile component '${path.basename(target)}' (I=${tgtMetrics.instability}), violating the Stable Dependencies Principle (SDP).`
      });
    }
  });

  // 4. Extract 10D Normalized File Feature Vectors
  const fileFeatureVectors = new Map<string, Float32Array>();
  for (const file of fileNodes) {
    const attrs = fileGraph.getNodeAttributes(file) as FileNodeAttrs;
    const m = fileMetrics.get(file)!;

    // Vector format:
    // [0: norm_loc, 1: norm_fan_in, 2: norm_fan_out, 3: instability, 4: pagerank, 5: betweenness, 6: symbol_count, 7: depth, 8: in_cycle, 9: layer_id]
    const vec = new Float32Array(10);
    vec[0] = Math.min(2.5, m.loc / 350);
    vec[1] = Math.min(2.5, m.fanIn / 8);
    vec[2] = Math.min(2.5, m.fanOut / 8);
    vec[3] = m.instability;
    vec[4] = Math.min(2.5, m.pagerank * 15);
    vec[5] = Math.min(2.5, m.betweenness * 10);
    vec[6] = Math.min(2.5, m.symbolCount / 12);
    vec[7] = Math.min(1.0, file.split('/').length / 6);
    vec[8] = m.inCycle ? 1.0 : 0.0;
    vec[9] = layerToId(attrs.layer);

    fileFeatureVectors.set(file, vec);
  }

  // 5. Extract 8D Normalized Folder Feature Vectors
  const folderGroups = new Map<string, string[]>();
  for (const file of fileNodes) {
    const dir = path.posix.dirname(file);
    if (!folderGroups.has(dir)) folderGroups.set(dir, []);
    folderGroups.get(dir)!.push(file);
  }

  const folderFeatureVectors = new Map<string, { vector: Float32Array; files: string[] }>();
  for (const [dir, files] of folderGroups.entries()) {
    if (files.length === 0 || dir === '.' || isIgnoredPath(dir)) continue;

    let sumLoc = 0;
    let maxLoc = 0;
    let sumFanIn = 0;
    let sumFanOut = 0;
    let sumInstability = 0;

    for (const f of files) {
      const m = fileMetrics.get(f)!;
      sumLoc += m.loc;
      if (m.loc > maxLoc) maxLoc = m.loc;
      sumFanIn += m.fanIn;
      sumFanOut += m.fanOut;
      sumInstability += m.instability;
    }

    const avgLoc = sumLoc / files.length;
    const avgInstability = sumInstability / files.length;

    // Count internal edges inside this folder
    let internalEdges = 0;
    for (const f of files) {
      for (const target of fileGraph.outNeighbors(f)) {
        if (path.posix.dirname(target) === dir) internalEdges++;
      }
    }
    const maxPossibleEdges = files.length > 1 ? files.length * (files.length - 1) : 1;
    const internalDensity = internalEdges / maxPossibleEdges;

    // Vector format:
    // [0: file_count, 1: avg_loc, 2: max_loc, 3: total_fan_in, 4: total_fan_out, 5: avg_instability, 6: internal_density, 7: depth]
    const vec = new Float32Array(8);
    vec[0] = Math.min(2.5, files.length / 8);
    vec[1] = Math.min(2.5, avgLoc / 250);
    vec[2] = Math.min(2.5, maxLoc / 600);
    vec[3] = Math.min(2.5, sumFanIn / 20);
    vec[4] = Math.min(2.5, sumFanOut / 20);
    vec[5] = avgInstability;
    vec[6] = Math.min(1.0, internalDensity);
    vec[7] = Math.min(1.0, dir.split('/').length / 5);

    folderFeatureVectors.set(dir, { vector: vec, files });
  }

  return {
    deterministicHotspots: hotspots.filter(h => !isIgnoredPath(h.path)),
    fileMetrics,
    fileFeatureVectors,
    folderFeatureVectors
  };
}
