import { DirectedGraph } from 'graphology';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../storage/types.js';
import type { ParsedSymbol, ParsedEdge } from '../storage/sync.js';
import { detectCyclesInSubgraph, computeNodeCoupling } from './metrics.js';

export interface GraphNodeAttrs {
  id: string;
  filePath: string;
  name: string;
  kind: string;
  signature?: string | null;
  summary?: string | null;
  startLine: number;
  endLine: number;
}

export interface SubgraphResult {
  nodes: Array<GraphNodeAttrs & { degree: number; isFocal: boolean }>;
  edges: Array<{ source: string; target: string; relation: string }>;
  metrics: {
    fanIn: number;
    fanOut: number;
    instability: number;
    cycles: string[][];
  };
}

export class CodeGraphCache {
  public graph = new DirectedGraph();

  /**
   * Hydrate in-memory graph from SQLite tables
   */
  async hydrate(db: Kysely<DatabaseSchema>): Promise<void> {
    this.graph.clear();

    const nodes = await db
      .selectFrom('nodes')
      .select([
        'id',
        'file_path',
        'name',
        'kind',
        'signature',
        'summary',
        'start_line',
        'end_line'
      ])
      .execute();

    for (const node of nodes) {
      this.graph.addNode(node.id, {
        id: node.id,
        filePath: node.file_path,
        name: node.name,
        kind: node.kind,
        signature: node.signature,
        summary: node.summary,
        startLine: node.start_line,
        endLine: node.end_line
      });
    }

    const edges = await db
      .selectFrom('edges')
      .select(['source_id', 'target_id', 'relation'])
      .execute();

    for (const edge of edges) {
      const src = this.resolveActualNodeId(edge.source_id);
      const tgt = this.resolveActualNodeId(edge.target_id);
      if (src && tgt) {
        this.graph.mergeEdge(src, tgt, {
          relation: edge.relation
        });
      }
    }
  }

  public resolveActualNodeId(id: string): string | null {
    if (!id) return null;
    const norm = id.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    if (this.graph.hasNode(norm)) return norm;
    if (this.graph.hasNode(id)) return id;

    if (norm.includes('::')) {
      const candidates = [
        norm.replace('::', '.ts::'),
        norm.replace('::', '.tsx::'),
        norm.replace('::', '.js::'),
        norm.replace('::', '.jsx::'),
        norm.replace('::', '.dto.ts::'),
        norm.replace('::', '.service.ts::'),
        norm.replace('::', '.entity.ts::'),
        norm.replace('::', '.usecase.ts::'),
        norm.replace('::', '/index.ts::'),
        norm.replace('::', '/index.tsx::'),
        norm.replace('::', '/index.js::')
      ];
      for (const c of candidates) {
        if (this.graph.hasNode(c)) return c;
      }
    } else {
      const candidates = [
        norm + '.ts',
        norm + '.tsx',
        norm + '.js',
        norm + '.jsx',
        norm + '.dto.ts',
        norm + '.service.ts',
        norm + '.entity.ts',
        norm + '.usecase.ts',
        norm + '/index.ts',
        norm + '/index.tsx',
        norm + '/index.js'
      ];
      for (const c of candidates) {
        if (this.graph.hasNode(c)) return c;
      }
    }

    // Case-insensitive fallback
    const lowerNorm = norm.toLowerCase();
    for (const nodeId of this.graph.nodes()) {
      if (nodeId.toLowerCase() === lowerNorm) return nodeId;
    }

    return null;
  }

  removeFileNodes(filePath: string): void {
    const targetNorm = filePath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    const toDrop: string[] = [];
    this.graph.forEachNode((nodeId, attrs) => {
      const nodePath = (attrs as GraphNodeAttrs).filePath?.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
      if (nodePath === targetNorm) {
        toDrop.push(nodeId);
      }
    });
    for (const id of toDrop) {
      this.graph.dropNode(id);
    }
  }

  updateFileNodes(filePath: string, newSymbols: ParsedSymbol[], newEdges: ParsedEdge[]): void {
    this.removeFileNodes(filePath);

    for (const s of newSymbols) {
      this.graph.addNode(s.id, {
        id: s.id,
        filePath,
        name: s.name,
        kind: s.kind,
        signature: s.signature || null,
        summary: s.summary || null,
        startLine: s.startLine,
        endLine: s.endLine
      });
    }

    for (const e of newEdges) {
      const src = this.resolveActualNodeId(e.sourceId);
      const tgt = this.resolveActualNodeId(e.targetId);
      if (src && tgt) {
        this.graph.mergeEdge(src, tgt, { relation: e.relation });
      }
    }
  }

  /**
   * BFS neighborhood extraction (k-hop)
   */
  getSubgraph(focalNodeId: string, depth: number = 2): SubgraphResult {
    if (!this.graph.hasNode(focalNodeId)) {
      return {
        nodes: [],
        edges: [],
        metrics: { fanIn: 0, fanOut: 0, instability: 0, cycles: [] }
      };
    }

    const visited = new Set<string>();
    const queue: Array<{ id: string; d: number }> = [{ id: focalNodeId, d: 0 }];

    while (queue.length > 0) {
      const { id, d } = queue.shift()!;
      if (visited.has(id) || d > depth) continue;
      visited.add(id);

      const neighbors = [...this.graph.inNeighbors(id), ...this.graph.outNeighbors(id)];
      for (const n of neighbors) {
        if (!visited.has(n)) {
          queue.push({ id: n, d: d + 1 });
        }
      }
    }

    const resultNodes: SubgraphResult['nodes'] = [];
    for (const id of visited) {
      const attrs = this.graph.getNodeAttributes(id) as GraphNodeAttrs;
      resultNodes.push({
        ...attrs,
        degree: this.graph.degree(id),
        isFocal: id === focalNodeId
      });
    }

    const resultEdges: SubgraphResult['edges'] = [];
    for (const id of visited) {
      this.graph.forEachOutEdge(id, (edge, edgeAttrs, source, target) => {
        if (visited.has(target)) {
          resultEdges.push({
            source,
            target,
            relation: (edgeAttrs as any).relation || 'DEPENDS_ON'
          });
        }
      });
    }

    const metrics = computeNodeCoupling(this.graph, focalNodeId);
    const cycles = detectCyclesInSubgraph(this.graph, Array.from(visited));

    return {
      nodes: resultNodes,
      edges: resultEdges,
      metrics: {
        ...metrics,
        cycles
      }
    };
  }

  /**
   * Pruned text context representation for LLM prompts
   */
  extractSubgraphContext(focalNodeId: string, depth: number = 2): string {
    const subgraph = this.getSubgraph(focalNodeId, depth);
    if (subgraph.nodes.length === 0) return 'No graph context found for symbol.';

    const focalAttrs = this.graph.getNodeAttributes(focalNodeId) as GraphNodeAttrs;
    const callers = this.graph.inNeighbors(focalNodeId);
    const callees = this.graph.outNeighbors(focalNodeId);

    const lines: string[] = [
      `### Target Focal Symbol: ${focalAttrs.name} (${focalAttrs.kind})`,
      `- File: ${focalAttrs.filePath}`,
      `- Signature: ${focalAttrs.signature || 'N/A'}`,
      `- Fan-In (Callers): ${callers.length} [${callers.join(', ')}]`,
      `- Fan-Out (Callees): ${callees.length} [${callees.join(', ')}]`,
      `- Instability Index: ${subgraph.metrics.instability.toFixed(2)}`,
      `- Detected Cycles: ${subgraph.metrics.cycles.length > 0 ? JSON.stringify(subgraph.metrics.cycles) : 'None'}`,
      '',
      `### Neighborhood Topology (${subgraph.nodes.length} nodes, ${subgraph.edges.length} edges):`
    ];

    for (const node of subgraph.nodes) {
      const nodeCallees = this.graph.outNeighbors(node.id);
      lines.push(
        `Node: ${node.name} [${node.kind}] (${node.filePath})\n` +
        `  Signature: ${node.signature || 'N/A'}\n` +
        `  Dependencies: [${nodeCallees.join(', ')}]`
      );
    }

    return lines.join('\n');
  }
}
