<script lang="ts">
  interface NodeItem {
    id: string;
    name: string;
    kind: string;
    filePath: string;
    signature?: string | null;
    startLine: number;
    endLine: number;
    isFocal: boolean;
  }

  interface EdgeItem {
    source: string;
    target: string;
    relation: string;
  }

  interface Props {
    subgraph: {
      nodes: NodeItem[];
      edges: EdgeItem[];
      metrics?: {
        fanIn: number;
        fanOut: number;
        instability: number;
        cycles: string[][];
      };
    } | null;
    focalNodeId: string | null;
    onSelectNode: (id: string) => void;
    onOpenLocation: (filePath: string, line: number) => void;
  }

  let { subgraph, focalNodeId, onSelectNode, onOpenLocation }: Props = $props();

  // Layout calculations: focal node in center, callers on left, callees on right
  let focalNode = $derived(subgraph?.nodes.find((n) => n.id === focalNodeId) || null);
  let callers = $derived(
    subgraph
      ? subgraph.edges
          .filter((e) => e.target === focalNodeId)
          .map((e) => ({
            edge: e,
            node: subgraph.nodes.find((n) => n.id === e.source)
          }))
          .filter((item) => item.node !== undefined)
      : []
  );
  let callees = $derived(
    subgraph
      ? subgraph.edges
          .filter((e) => e.source === focalNodeId)
          .map((e) => ({
            edge: e,
            node: subgraph.nodes.find((n) => n.id === e.target)
          }))
          .filter((item) => item.node !== undefined)
      : []
  );

  function getKindBadgeClass(kind: string): string {
    switch (kind) {
      case 'class':
        return 'bg-purple-900/40 text-purple-300 border-purple-700/50';
      case 'interface':
        return 'bg-cyan-900/40 text-cyan-300 border-cyan-700/50';
      case 'function':
        return 'bg-blue-900/40 text-blue-300 border-blue-700/50';
      case 'endpoint':
        return 'bg-amber-900/40 text-amber-300 border-amber-700/50';
      default:
        return 'bg-zinc-800 text-zinc-300 border-zinc-700';
    }
  }
</script>

<div class="flex-1 flex flex-col min-h-0 bg-[var(--vscode-editor-background)] border-b border-[var(--vscode-panel-border)] p-2">
  <div class="flex items-center justify-between pb-1 mb-1 border-b border-[var(--vscode-widget-border)]">
    <h3 class="text-[11px] font-bold uppercase tracking-wider text-[var(--vscode-descriptionForeground)]">
      Subgraph Topology
    </h3>
    {#if subgraph && subgraph.metrics}
      <div class="flex items-center gap-2 text-[10px] font-mono">
        <span title="Fan-In / Callers">In: <b class="text-emerald-400">{subgraph.metrics.fanIn}</b></span>
        <span title="Fan-Out / Callees">Out: <b class="text-blue-400">{subgraph.metrics.fanOut}</b></span>
        <span title="Martin Instability Index (0=Stable, 1=Unstable)">I: <b class="text-amber-400">{subgraph.metrics.instability}</b></span>
      </div>
    {/if}
  </div>

  {#if !subgraph || !focalNode}
    <div class="flex-1 flex items-center justify-center text-xs text-[var(--vscode-descriptionForeground)] italic p-4 text-center">
      Select a symbol from search results to inspect its neighborhood graph
    </div>
  {:else}
    <div class="flex-1 overflow-y-auto space-y-3 pr-1">
      <!-- Callers Column / Section -->
      <div>
        <div class="text-[10px] font-semibold text-[var(--vscode-descriptionForeground)] uppercase mb-1 flex items-center gap-1">
          <span>Inbound Callers / Dependents</span>
          <span class="text-[9px] px-1 py-0.2 rounded bg-[var(--vscode-badge-background)] text-[var(--vscode-badge-foreground)]">
            {callers.length}
          </span>
        </div>
        {#if callers.length === 0}
          <div class="text-[11px] text-[var(--vscode-descriptionForeground)] italic pl-2">No callers in graph</div>
        {:else}
          <div class="flex flex-col gap-1 pl-1">
            {#each callers as { edge, node }}
              {#if node}
                <div class="flex items-center justify-between p-1.5 rounded border border-[var(--vscode-widget-border)] bg-[var(--vscode-sideBar-background)] hover:bg-[var(--vscode-list-hoverBackground)] text-xs">
                  <div class="flex items-center gap-1.5 overflow-hidden">
                    <span class="text-[9px] px-1 py-0.5 rounded border {getKindBadgeClass(node.kind)}">
                      {node.kind}
                    </span>
                    <button
                      onclick={() => onSelectNode(node.id)}
                      class="font-mono text-xs font-semibold text-[var(--vscode-symbolIcon-functionForeground)] hover:underline truncate cursor-pointer text-left"
                      title={node.id}
                    >
                      {node.name}
                    </button>
                  </div>
                  <div class="flex items-center gap-1">
                    <span class="text-[9px] font-mono text-[var(--vscode-descriptionForeground)]">
                      {edge.relation}
                    </span>
                    <button
                      onclick={() => onOpenLocation(node.filePath, node.startLine)}
                      class="text-[10px] hover:text-[var(--vscode-textLink-foreground)] px-1 cursor-pointer"
                      title="Jump to code in editor"
                    >
                      ↗
                    </button>
                  </div>
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      </div>

      <!-- Focal Node Card -->
      <div class="p-2.5 rounded-lg border-2 border-[var(--vscode-focusBorder)] bg-[var(--vscode-editor-selectionBackground)] shadow-sm">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-1.5">
            <span class="text-[10px] font-bold px-1.5 py-0.5 rounded border {getKindBadgeClass(focalNode.kind)}">
              {focalNode.kind.toUpperCase()}
            </span>
            <span class="font-mono text-xs font-bold text-[var(--vscode-foreground)]">
              {focalNode.name}
            </span>
          </div>
          <button
            onclick={() => onOpenLocation(focalNode.filePath, focalNode.startLine)}
            class="text-[11px] font-medium underline text-[var(--vscode-textLink-foreground)] hover:text-[var(--vscode-textLink-activeForeground)] cursor-pointer"
            title="Open symbol file in editor"
          >
            Jump to line {focalNode.startLine}
          </button>
        </div>

        {#if focalNode.signature}
          <div class="mt-1.5 p-1 rounded bg-[var(--vscode-editor-background)] text-[11px] font-mono text-[var(--vscode-textPreformat-foreground)] truncate">
            {focalNode.signature}
          </div>
        {/if}

        <div class="mt-1 text-[10px] text-[var(--vscode-descriptionForeground)] truncate font-mono">
          {focalNode.filePath}
        </div>
      </div>

      <!-- Outbound Callees / Dependencies -->
      <div>
        <div class="text-[10px] font-semibold text-[var(--vscode-descriptionForeground)] uppercase mb-1 flex items-center gap-1">
          <span>Outbound Callees / Dependencies</span>
          <span class="text-[9px] px-1 py-0.2 rounded bg-[var(--vscode-badge-background)] text-[var(--vscode-badge-foreground)]">
            {callees.length}
          </span>
        </div>
        {#if callees.length === 0}
          <div class="text-[11px] text-[var(--vscode-descriptionForeground)] italic pl-2">No outgoing calls in graph</div>
        {:else}
          <div class="flex flex-col gap-1 pl-1">
            {#each callees as { edge, node }}
              {#if node}
                <div class="flex items-center justify-between p-1.5 rounded border border-[var(--vscode-widget-border)] bg-[var(--vscode-sideBar-background)] hover:bg-[var(--vscode-list-hoverBackground)] text-xs">
                  <div class="flex items-center gap-1.5 overflow-hidden">
                    <span class="text-[9px] px-1 py-0.5 rounded border {getKindBadgeClass(node.kind)}">
                      {node.kind}
                    </span>
                    <button
                      onclick={() => onSelectNode(node.id)}
                      class="font-mono text-xs font-semibold text-[var(--vscode-symbolIcon-functionForeground)] hover:underline truncate cursor-pointer text-left"
                      title={node.id}
                    >
                      {node.name}
                    </button>
                  </div>
                  <div class="flex items-center gap-1">
                    <span class="text-[9px] font-mono text-[var(--vscode-descriptionForeground)]">
                      {edge.relation}
                    </span>
                    <button
                      onclick={() => onOpenLocation(node.filePath, node.startLine)}
                      class="text-[10px] hover:text-[var(--vscode-textLink-foreground)] px-1 cursor-pointer"
                      title="Jump to code in editor"
                    >
                      ↗
                    </button>
                  </div>
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
