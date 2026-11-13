import { DirectedGraph } from 'graphology';
import type { HotspotItem } from '../graph/assertions.js';
import type { ArchitectureRule, FlaggedCandidate, RuleContext } from './types.js';
import type { SymbolRoleClassifier } from '../ai/symbol-classifier.js';
import { isIgnoredPath } from '../parser/watcher.js';

export interface RuleEngineOptions {
  rules: ArchitectureRule[];
  roleClassifier?: SymbolRoleClassifier;
  validateWithSlm?: (
    candidatesWithPrompts: Array<{ candidate: FlaggedCandidate; prompt: string }>
  ) => Promise<Map<string, { isViolation: boolean; reason?: string; suggestedFiles?: string[] }>>;
  onStatus?: (message: string) => void;
}

export async function runRuleEngine(
  fileGraph: DirectedGraph,
  symbolGraph: DirectedGraph,
  communities: Record<string, number>,
  fileMetrics: Map<string, any>,
  options: RuleEngineOptions
): Promise<HotspotItem[]> {
  const { rules, validateWithSlm, onStatus } = options;

  const ctx: RuleContext = {
    fileGraph,
    symbolGraph,
    communities,
    fileMetrics,
    roleClassifier: options.roleClassifier
  };

  // Step 1: Fast in-memory detection (< 2ms)
  if (onStatus) onStatus(`Step 1/3: Running ${rules.length} architecture rules across graph...`);
  const rawCandidates: FlaggedCandidate[] = [];

  for (const rule of rules) {
    try {
      const found = rule.detect(fileGraph, ctx);
      rawCandidates.push(...found);
    } catch (err) {
      console.warn(`[RuleEngine] Rule '${rule.id}' detect failed:`, err);
    }
  }

  // Step 2: Deterministic Ignore Filter (< 1ms)
  if (onStatus) onStatus(`Step 2/3: Filtering false positives (${rawCandidates.length} raw candidates)...`);
  const ruleMap = new Map<string, ArchitectureRule>();
  for (const r of rules) ruleMap.set(r.id, r);

  const survivingCandidates: FlaggedCandidate[] = [];
  for (const cand of rawCandidates) {
    if (isIgnoredPath(cand.path)) continue;
    const rule = ruleMap.get(cand.ruleId);
    if (!rule) continue;

    try {
      const ignored = await rule.shouldIgnore(cand, fileGraph, ctx);
      if (!ignored) {
        survivingCandidates.push(cand);
      }
    } catch (err) {
      console.warn(`[RuleEngine] Rule '${rule.id}' shouldIgnore failed:`, err);
      survivingCandidates.push(cand);
    }
  }

  // Step 3: Optional SLM Sanity Check
  const slmCandidates: Array<{ candidate: FlaggedCandidate; prompt: string }> = [];
  const deterministicCandidates: FlaggedCandidate[] = [];

  for (const cand of survivingCandidates) {
    const rule = ruleMap.get(cand.ruleId);
    if (rule?.buildSlmValidationPrompt && validateWithSlm) {
      const prompt = rule.buildSlmValidationPrompt(cand, ctx);
      slmCandidates.push({ candidate: cand, prompt });
    } else {
      deterministicCandidates.push(cand);
    }
  }

  const finalHotspots: HotspotItem[] = [];

  // Add deterministic survivors directly
  for (const cand of deterministicCandidates) {
    finalHotspots.push(candidateToHotspot(cand));
  }

  // Run SLM validation on ambiguous candidates if validator is available
  if (slmCandidates.length > 0 && validateWithSlm) {
    if (onStatus) onStatus(`Step 3/3: Validating ${slmCandidates.length} candidates with Qwen 2.5 Coder 0.5B...`);
    try {
      const slmResults = await validateWithSlm(slmCandidates);
      for (const { candidate } of slmCandidates) {
        const res = slmResults.get(candidate.id);
        // If SLM confirms violation (or wasn't able to disprove), keep it
        if (!res || res.isViolation) {
          const item = candidateToHotspot(candidate);
          if (res?.reason) {
            item.description = `${item.description} (Qwen 0.5B: ${res.reason})`;
          }
          if (res?.suggestedFiles && res.suggestedFiles.length > 0) {
            item.suggestedFiles = res.suggestedFiles;
          }
          finalHotspots.push(item);
        }
      }
    } catch (err) {
      console.warn('[RuleEngine] SLM validation warning:', err);
      // Fallback: keep surviving candidates
      for (const { candidate } of slmCandidates) {
        finalHotspots.push(candidateToHotspot(candidate));
      }
    }
  } else {
    for (const { candidate } of slmCandidates) {
      finalHotspots.push(candidateToHotspot(candidate));
    }
  }

  // Deduplicate hotspots by path + category
  const seen = new Set<string>();
  const deduplicated: HotspotItem[] = [];
  for (const h of finalHotspots) {
    const key = `${h.path}::${h.category}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(h);
    }
  }

  return deduplicated;
}

function candidateToHotspot(c: FlaggedCandidate): HotspotItem {
  return {
    id: c.id,
    ruleId: c.ruleId,
    type: c.type,
    path: c.path,
    category: c.category as any,
    severity: c.severity,
    title: c.title,
    description: c.description,
    suggestedFiles: c.suggestedFiles || c.evidence?.suggestedFiles,
    evidence: c.evidence,
    metrics: c.metrics
      ? {
          loc: c.metrics.loc,
          fanIn: c.metrics.fanIn,
          fanOut: c.metrics.fanOut,
          instability: c.metrics.instability,
          pagerank: c.metrics.pagerank,
          betweenness: c.metrics.betweenness
        }
      : undefined
  };
}
