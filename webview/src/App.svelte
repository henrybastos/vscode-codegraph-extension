<script lang="ts">
  import SearchBar from './components/SearchBar.svelte';
  import GraphCanvas from './components/GraphCanvas.svelte';
  import AdvicePanel from './components/AdvicePanel.svelte';

  const vscode = acquireVsCodeApi();

  let query = $state('');
  let searchResults = $state<any[]>([]);
  let selectedNodeId = $state<string | null>(null);
  let subgraphData = $state<any | null>(null);

  let isAnalyzing = $state(false);
  let aiAdvice = $state('');

  function handleSearch(q: string) {
    vscode.postMessage({ command: 'search', query: q });
  }

  function handleSelectNode(nodeId: string) {
    selectedNodeId = nodeId;
    vscode.postMessage({ command: 'select_node', nodeId });
  }

  function handleOpenLocation(filePath: string, startLine: number) {
    vscode.postMessage({ command: 'open_location', filePath, startLine });
  }

  function handleRunAudit() {
    if (!selectedNodeId) return;
    isAnalyzing = true;
    aiAdvice = '';
    vscode.postMessage({ command: 'analyze_architecture', nodeId: selectedNodeId });
  }

  function handleAbortAudit() {
    isAnalyzing = false;
    vscode.postMessage({ command: 'abort_ai' });
  }

  function handleReindex() {
    vscode.postMessage({ command: 'reindex_workspace' });
  }

  function handleSetApiKey() {
    vscode.postMessage({ command: 'set_api_key' });
  }

  window.addEventListener('message', (event) => {
    const { type, payload } = event.data;
    if (type === 'search_results') {
      searchResults = payload || [];
      if (!selectedNodeId && searchResults.length > 0) {
        handleSelectNode(searchResults[0].id);
      }
    } else if (type === 'subgraph_data') {
      subgraphData = payload;
    } else if (type === 'ai_start') {
      isAnalyzing = true;
      aiAdvice = '';
    } else if (type === 'ai_chunk') {
      aiAdvice += payload;
    } else if (type === 'ai_complete') {
      isAnalyzing = false;
    } else if (type === 'ai_error') {
      isAnalyzing = false;
      aiAdvice += `\n[Error: ${payload}]`;
    } else if (type === 'graph_updated') {
      handleSearch(query);
      if (selectedNodeId) {
        handleSelectNode(selectedNodeId);
      }
    }
  });

  // Initial search on mount
  $effect(() => {
    handleSearch('');
  });
</script>

<main class="flex flex-col h-screen w-screen overflow-hidden bg-[var(--vscode-editor-background)] text-[var(--vscode-editor-foreground)]">
  <!-- Search Bar Header -->
  <SearchBar
    bind:query
    onSearch={handleSearch}
    onReindex={handleReindex}
    onSetApiKey={handleSetApiKey}
  />

  <!-- Main Work Area -->
  <div class="flex-1 flex flex-col min-h-0">
    <!-- Results Quick Bar -->
    {#if searchResults.length > 0}
      <div class="max-h-40 overflow-y-auto border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-background)] p-1.5 flex flex-col gap-1">
        <div class="text-[10px] font-semibold text-[var(--vscode-descriptionForeground)] px-1 uppercase flex items-center justify-between">
          <span>{query ? `Search Matches (${searchResults.length})` : `All Discovered Symbols (${searchResults.length})`}</span>
          {#if !query}
            <span class="text-[9px] lowercase font-normal italic">type in search bar to filter</span>
          {/if}
        </div>
        {#each searchResults as item}
          <button
            onclick={() => handleSelectNode(item.id)}
            class="flex items-center justify-between p-1 rounded hover:bg-[var(--vscode-list-hoverBackground)] text-xs text-left cursor-pointer {selectedNodeId === item.id ? 'bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)]' : ''}"
          >
            <div class="flex items-center gap-1.5 overflow-hidden">
              <span class="text-[9px] px-1 py-0.2 rounded font-mono bg-zinc-800 text-zinc-300">
                {item.kind}
              </span>
              <span class="font-mono text-xs truncate font-medium">
                {item.name}
              </span>
            </div>
            <span class="text-[10px] text-[var(--vscode-descriptionForeground)] truncate max-w-[180px]">
              {item.file_path}
            </span>
          </button>
        {/each}
      </div>
    {:else}
      <div class="p-2 border-b border-[var(--vscode-panel-border)] text-xs text-[var(--vscode-descriptionForeground)] italic">
        No symbols found in workspace. Click "Re-index" or save a file.
      </div>
    {/if}

    <!-- Subgraph Visualizer -->
    <GraphCanvas
      subgraph={subgraphData}
      focalNodeId={selectedNodeId}
      onSelectNode={handleSelectNode}
      onOpenLocation={handleOpenLocation}
    />

    <!-- AI Architecture Audit Panel -->
    <AdvicePanel
      {isAnalyzing}
      {aiAdvice}
      focalSymbolName={selectedNodeId}
      cycles={subgraphData?.metrics?.cycles || []}
      onRunAudit={handleRunAudit}
      onAbortAudit={handleAbortAudit}
    />
  </div>
</main>
