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
import { classifyLayer } from '../../graph/assertions.js';
import { formatTargetedPrompts, getFileSymbols, normalizeRelPath } from './targeted-helpers.js';

export class MixedConcernsRule implements ArchitectureRule {
  public readonly id = 'mixed-concerns';
  public readonly name = 'Mixed Concerns in Folder';

  detect(graph: DirectedGraph, ctx: RuleContext): FlaggedCandidate[] {
    const candidates: FlaggedCandidate[] = [];

    // Group files by folder
    const folderGroups = new Map<string, string[]>();
    for (const file of graph.nodes()) {
      const dir = path.posix.dirname(file.replace(/\\/g, '/'));
      if (dir === '.' || dir === '') continue;
      if (!folderGroups.has(dir)) folderGroups.set(dir, []);
      folderGroups.get(dir)!.push(file);
    }

    for (const [folderPath, files] of folderGroups.entries()) {
      if (files.length < 3) continue;

      // Check layers present in this directory
      const layers = new Set<string>();
      const communities = new Set<number>();

      for (const file of files) {
        const attrs: any = graph.getNodeAttributes(file);
        if (attrs?.layer && attrs.layer !== 'shared') {
          layers.add(attrs.layer);
        }
        const comm = ctx.communities[file];
        if (comm !== undefined) {
          communities.add(comm);
        }
      }

      // If directory contains opposing layers: presentation + infrastructure
      const hasPolarLayers = layers.has('presentation') && layers.has('infrastructure');
      // If directory mixes at least 2 distinct architectural layers AND has multiple communities
      const hasMixedLayers = layers.size >= 2 && communities.size > 2 && files.length >= 4;

      if (hasPolarLayers || hasMixedLayers) {
        const description = hasPolarLayers
          ? `Folder contains ${files.length} files mixing conflicting layers (${Array.from(layers).join(', ')}).`
          : `Folder contains ${files.length} files mixing ${layers.size} distinct layers (${Array.from(layers).join(', ')}) across ${communities.size} dependency clusters.`;

        candidates.push({
          id: `mixed-concerns-${folderPath.replace(/[^a-zA-Z0-9]/g, '_')}`,
          ruleId: this.id,
          type: 'folder',
          path: folderPath,
          category: 'Mixed Concerns',
          severity: hasPolarLayers ? 'high' : 'medium',
          title: `Mixed Concerns in Directory: /${folderPath}`,
          description,
          metrics: {
            loc: files.length,
            community: communities.size
          },
          evidence: {
            folderPath,
            files: files.map((f) => path.basename(f)),
            layers: Array.from(layers)
          }
        });
      }
    }

    return candidates;
  }

  async shouldIgnore(
    candidate: FlaggedCandidate,
    _graph: DirectedGraph,
    ctx: RuleContext
  ): Promise<boolean> {
    const normalizedPath = candidate.path.replace(/\\/g, '/');
    const files: string[] = candidate.evidence?.files || [];
    const layers: string[] = candidate.evidence?.layers || [];
    const hasPolar = layers.includes('presentation') && layers.includes('infrastructure');

    // 1. Fast deterministic filter (0ms): Ignore test or mock directories
    if (isTestOrMockPath(normalizedPath)) {
      return true;
    }

    // 2. If only 0 or 1 layer is present and no polar conflict exists, it is a single-concern folder
    if (layers.length <= 1 && !hasPolar) {
      return true;
    }

    // 3. Semantic ONNX Folder Concern Classification (~2-4ms):
    // Replaces hardcoded single-concern folder sets and vertical slice filename lists
    if (ctx.roleClassifier && ctx.roleClassifier.isInitialized()) {
      const classification = await ctx.roleClassifier.classifyFolderConcern(normalizedPath, files);

      if (candidate.evidence) {
        candidate.evidence.inferredRole = classification.role;
        candidate.evidence.roleConfidence = classification.score;
      }

      if (classification.role === 'vertical_feature_slice') {
        return true;
      }
      if (classification.role === 'single_concern_folder' && !hasPolar) {
        return true;
      }
    }

    return false;
  }

  buildSlmValidationPrompt(candidate: FlaggedCandidate, _ctx: RuleContext): string {
    const fileList: string[] = candidate.evidence?.files || [];
    const layers: string[] = candidate.evidence?.layers || [];

    return `Directory: ${candidate.path}
Files inside: ${fileList.join(', ')}
Layers detected: ${layers.join(', ')}

Question: Is this folder a well-structured Vertical Feature Slice / Cohesive Module (valid), or does it randomly mix unrelated concerns and architecture layers that should be separated (violation)?`;
  }

  buildTargetedAnalysis(ctx: TargetedAnalysisContext): TargetedAnalysisReportInput {
    const { item, fileGraph, symbolGraph } = ctx;
    const normFolder = normalizeRelPath(item.path).toLowerCase();

    const folderFiles = fileGraph
      .nodes()
      .filter((f) => normalizeRelPath(path.dirname(f)).toLowerCase() === normFolder);

    const byLayer = new Map<string, string[]>();
    const intraCrossLayerEdges: string[] = [];
    const folderSet = new Set(folderFiles);

    for (const file of folderFiles) {
      const layer = String(fileGraph.getNodeAttribute(file, 'layer') || classifyLayer(file));
      const list = byLayer.get(layer) || [];
      const syms = getFileSymbols(symbolGraph, file).slice(0, 4).map((s) => s.name);
      list.push(`${path.basename(file)}${syms.length ? ` [${syms.join(', ')}]` : ''}`);
      byLayer.set(layer, list);

      fileGraph.forEachOutEdge(file, (_e, _attrs, _s, tgt) => {
        if (folderSet.has(tgt)) {
          const tgtLayer = String(fileGraph.getNodeAttribute(tgt, 'layer') || classifyLayer(tgt));
          if (tgtLayer !== layer) {
            intraCrossLayerEdges.push(`${path.basename(file)} (${layer}) -> ${path.basename(tgt)} (${tgtLayer})`);
          }
        }
      });
    }

    const layerBreakdown = Array.from(byLayer.entries())
      .map(([layer, files]) => `- ${layer}: ${files.join(', ')}`)
      .join('\n');

    const promptInput = formatTargetedPrompts(
      'Package & Folder Cohesion Architect',
      [
        'Evaluate whether this directory mixes unrelated architectural layers or is an intentional vertical feature slice.',
        'Provide a concrete target folder structure (either layer subfolders or a clean feature-slice layout).'
      ],
      `Target Folder: ${item.path}
Description: ${item.description}
Files in Folder (${folderFiles.length}):

Layer-by-Layer File & Symbol Breakdown:
${layerBreakdown || '- No files resolved in fileGraph'}

Intra-Folder Cross-Layer Edges:
${intraCrossLayerEdges.slice(0, 12).join('\n') || 'None detected'}`
    );

    return {
      ...promptInput,
      targetedEvidence: { fileCount: folderFiles.length, layers: Array.from(byLayer.keys()) }
    };
  }
}
