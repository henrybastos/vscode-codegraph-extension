import type { DirectedGraph } from 'graphology';
import type { SymbolRoleClassifier } from '../ai/symbol-classifier.js';

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
  | 'API Decomposition'
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
  suggestedFiles?: string[];
}

export interface RuleContext {
  fileGraph: DirectedGraph;
  symbolGraph: DirectedGraph;
  communities: Record<string, number>;
  roleClassifier?: SymbolRoleClassifier;
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
  suggestedFiles?: string[];
}

export interface ArchitectureRule {
  id: string;
  name: string;

  // Step 1: Fast deterministic check (Graphology + AST attrs)
  detect(graph: DirectedGraph, ctx: RuleContext): FlaggedCandidate[];

  // Step 2: Fast deterministic or semantic whitelist (filters false positives)
  shouldIgnore(candidate: FlaggedCandidate, graph: DirectedGraph, ctx: RuleContext): boolean | Promise<boolean>;

  // Step 3: Short prompt for Qwen 0.5B to do the final sanity check (optional)
  buildSlmValidationPrompt?(candidate: FlaggedCandidate, ctx: RuleContext): string;
}
