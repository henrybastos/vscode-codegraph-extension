import type { DirectedGraph } from 'graphology';
import type { Kysely } from 'kysely';
import type { SymbolRoleClassifier } from '../ai/symbol-classifier.js';
import type { DatabaseSchema } from '../storage/types.js';
import type { HotspotItem } from '../graph/assertions.js';

const TEST_OR_MOCK_PATH_RE =
  /(?:^|\/)(?:__tests__|__mocks__|tests?|mocks?|fixtures?|e2e)(?:\/|$)|\.(?:spec|test|mock|e2e)\.[jt]sx?$/i;

/**
 * Fast deterministic check for test, spec, mock, fixture, or e2e paths.
 */
export function isTestOrMockPath(filePath: string): boolean {
  if (!filePath) return false;
  return TEST_OR_MOCK_PATH_RE.test(filePath.replace(/\\/g, '/'));
}

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

export interface TargetedAnalysisContext {
  item: HotspotItem;
  fileGraph: DirectedGraph;
  symbolGraph: DirectedGraph;
  db: Kysely<DatabaseSchema>;
  workspaceRoot?: string;
}

export interface TargetedAnalysisReportInput {
  systemPrompt: string;
  userPrompt: string;
  targetedEvidence?: Record<string, any>;
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

  // Step 4: On-demand targeted deep analysis when user clicks Analyse
  buildTargetedAnalysis?(
    ctx: TargetedAnalysisContext
  ): Promise<TargetedAnalysisReportInput> | TargetedAnalysisReportInput;
}
