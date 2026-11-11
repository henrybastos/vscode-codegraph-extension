<script lang="ts">
  import SearchBar from './components/SearchBar.svelte';
  import AdvicePanel from './components/AdvicePanel.svelte';

  const vscode = acquireVsCodeApi();

  let query = $state('');
  let isAnalyzing = $state(false);
  let aiAdvice = $state('');
  let auditMode = $state<'structure' | 'symbol' | null>(null);
  let analysisStats = $state<{ directories: number; files: number } | null>(null);

  function handleSearch(q: string) {
    vscode.postMessage({ command: 'search', query: q });
  }

  function handleAnalyzeProjectStructure() {
    isAnalyzing = true;
    aiAdvice = '';
    auditMode = 'structure';
    vscode.postMessage({ command: 'analyze_project_structure' });
  }

  function handleAbortAnalysis() {
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
    if (type === 'ai_start') {
      isAnalyzing = true;
      aiAdvice = '';
      auditMode = payload?.mode || 'structure';
      analysisStats = payload?.stats || null;
    } else if (type === 'ai_chunk') {
      aiAdvice += payload;
    } else if (type === 'ai_complete') {
      isAnalyzing = false;
    } else if (type === 'ai_error') {
      isAnalyzing = false;
      aiAdvice += `\n\n> ⚠️ **Error:** ${payload}`;
    }
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
    <!-- Action Bar -->
    <div class="p-2 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] flex items-center justify-between gap-2">
      <button
        onclick={handleAnalyzeProjectStructure}
        disabled={isAnalyzing}
        class="flex-1 px-3 py-1.5 text-xs font-semibold rounded bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-1.5 transition-all shadow-sm"
        title="Scan project directory structure and run AI architectural review"
      >
        <span>📁</span>
        <span>{isAnalyzing ? 'Analyzing project...' : 'Analyse Project Structure'}</span>
      </button>
    </div>

    <!-- AI Architecture Output (Comark Markdown) -->
    <AdvicePanel
      {isAnalyzing}
      {aiAdvice}
      mode={auditMode}
      focalName={null}
      stats={analysisStats}
      onRunAnalysis={handleAnalyzeProjectStructure}
      onAbortAnalysis={handleAbortAnalysis}
    />
  </div>
</main>
