import type { DirectedGraph } from 'graphology';

export interface NodeCouplingMetrics {
  fanIn: number;
  fanOut: number;
  instability: number; // I = Ce / (Ca + Ce)
}

/**
 * Computes Martin's instability metric:
 * Ca (Afferent coupling) = Fan-In = incoming edges
 * Ce (Efferent coupling) = Fan-Out = outgoing edges
 * Instability I = Ce / (Ca + Ce)
 * 0 = completely stable (many depend on it, it depends on nothing)
 * 1 = completely unstable (depends on many, none depend on it)
 */
export function computeNodeCoupling(graph: DirectedGraph, nodeId: string): NodeCouplingMetrics {
  if (!graph.hasNode(nodeId)) {
    return { fanIn: 0, fanOut: 0, instability: 0 };
  }

  const fanIn = graph.inDegree(nodeId);
  const fanOut = graph.outDegree(nodeId);
  const total = fanIn + fanOut;
  const instability = total === 0 ? 0 : fanOut / total;

  return {
    fanIn,
    fanOut,
    instability: Math.round(instability * 100) / 100
  };
}

/**
 * Finds elementary cycles in a subgraph using DFS
 */
export function detectCyclesInSubgraph(graph: DirectedGraph, nodeIds: string[]): string[][] {
  const allowed = new Set(nodeIds);
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const pathStack: string[] = [];
  const cycles: string[][] = [];

  function dfs(curr: string) {
    visited.add(curr);
    inStack.add(curr);
    pathStack.push(curr);

    const outNeighbors = graph.outNeighbors(curr);
    for (const neighbor of outNeighbors) {
      if (!allowed.has(neighbor)) continue;

      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else if (inStack.has(neighbor)) {
        // Found a cycle!
        const cycleStartIndex = pathStack.indexOf(neighbor);
        if (cycleStartIndex !== -1) {
          const cycle = pathStack.slice(cycleStartIndex).concat(neighbor);
          cycles.push(cycle);
        }
      }
    }

    pathStack.pop();
    inStack.delete(curr);
  }

  for (const id of nodeIds) {
    if (!visited.has(id)) {
      dfs(id);
    }
  }

  return cycles;
}
