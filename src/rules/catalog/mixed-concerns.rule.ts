import type { DirectedGraph } from 'graphology';
import type { ArchitectureRule, FlaggedCandidate, RuleContext } from '../types.js';
import * as path from 'node:path';

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

  shouldIgnore(candidate: FlaggedCandidate, _graph: DirectedGraph, _ctx: RuleContext): boolean {
    const p = candidate.path.toLowerCase().replace(/\\/g, '/');
    const files: string[] = candidate.evidence?.files || [];
    const layers: string[] = candidate.evidence?.layers || [];
    const hasPolar = layers.includes('presentation') && layers.includes('infrastructure');

    // 1. If only 0 or 1 layer is present and no polar conflict exists, it is a single-concern folder
    if (layers.length <= 1 && !hasPolar) {
      return true;
    }

    // 2. Whitelist standard single-concern architectural layer folders (unless polar conflict)
    const folderBase = path.posix.basename(p);
    const standardSingleConcernFolders = new Set([
      'usecases',
      'use-cases',
      'controllers',
      'services',
      'repositories',
      'entities',
      'models',
      'dtos',
      'routes',
      'handlers',
      'ports',
      'adapters',
      'domain',
      'components',
      'hooks',
      'utils',
      'helpers'
    ]);
    if (standardSingleConcernFolders.has(folderBase) && !hasPolar) {
      return true;
    }

    // 3. Whitelist known Vertical Slice / Feature folders:
    // Files containing *.module.ts, *.processor.ts, queue worker, or routes
    const isVerticalSlice = files.some(
      (f) =>
        f.endsWith('.module.ts') ||
        f.endsWith('.processor.ts') ||
        f.includes('worker') ||
        f.includes('queue') ||
        f.startsWith('+') ||
        f === 'route.ts' ||
        f === 'page.tsx' ||
        f === 'page.svelte'
    );
    if (isVerticalSlice) {
      return true;
    }

    // 4. Ignore tests or mock directories
    if (p.includes('/test') || p.includes('/__tests__') || p.includes('/mock')) {
      return true;
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
}
