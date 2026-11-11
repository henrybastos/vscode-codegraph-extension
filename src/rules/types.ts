import type { DirectedGraph } from 'graphology';

export type HotspotCategory =
  | 'God File'
  | 'Circular Dependency'
  | 'Layer Bypass'
  | 'Mixed Concerns'
  | 'Unstable Foundation'
  | 'Bottleneck Hub'
  | 'Domain Tangling'
  | 'Feature Envy'
  | 'Dead Abstraction'
  | 'Architecture Tip';

export interface RuleMetrics {
  loc?: number;
  methodCount?: number;
  fanIn?: number;
  fanOut?: number;
  instability?: number;
  pagerank?: number;
  betweenness?: number;
  community?: number;
}

export interface RuleContext {
  fileGraph: DirectedGraph;
  symbolGraph: DirectedGraph;
  communities: Record<string, number>;
  fileMetrics: Map<string, {
    loc: number;
    symbolCount: number;
    fanIn: number;
    fanOut: number;
    instability: number;
    pagerank: number;
    betweenness: number;
    community: number;
    inCycle: boolean;
  }>;
}

export interface FlaggedCandidate {
  id: string;
  ruleId: string;
  type: 'file' | 'folder';
  path: string;
  category: HotspotCategory;
  severity: 'critical' | 'high' | 'medium' | 'info';
  title: string;
  description: string;
  metrics?: RuleMetrics;
  evidence?: Record<string, any>;
}

export interface ArchitectureRule {
  id: string;
  name: string;

  // Step 1: Fast deterministic check (Graphology + AST attrs)
  detect(graph: DirectedGraph, ctx: RuleContext): FlaggedCandidate[];

  // Step 2: Fast deterministic whitelist (0ms cost, filters obvious false positives)
  shouldIgnore(candidate: FlaggedCandidate, graph: DirectedGraph, ctx: RuleContext): boolean;

  // Step 3: Short prompt for Qwen 0.5B to do the final sanity check (optional)
  buildSlmValidationPrompt?(candidate: FlaggedCandidate, ctx: RuleContext): string;
}
