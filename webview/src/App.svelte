<script lang="ts">
  import { onMount } from 'svelte';
  import SearchBar from './components/SearchBar.svelte';
  import AdvicePanel from './components/AdvicePanel.svelte';
  import Hotspots, { type HotspotItem, type AnalysisStats, type FileAnalysisState } from './components/Hotspots.svelte';

  const vscode = acquireVsCodeApi();

  let query = $state('');
  let isAnalyzing = $state(false);
  let hotspots = $state<HotspotItem[]>([]);
  let stats = $state<AnalysisStats | null>(null);
  let statusMessage = $state('');
  let aiAdvice = $state('');
  let auditMode = $state<'structure' | 'symbol' | null>(null);
  let analysisStats = $state<{ directories: number; files: number } | null>(null);
  let fileAnalyses = $state<Record<string, FileAnalysisState>>({});

  let modelStatus = $state<{ isDownloaded: boolean; sizeMb: number }>({ isDownloaded: false, sizeMb: 0 });
  let downloadProgress = $state<{ pct: number; loadedMb: number; totalMb: number } | null>(null);
  let analysisError = $state<string>('');
  let isDownloadingModel = $state(false);

  onMount(() => {
    vscode.postMessage({ command: 'get_model_status' });
  });

  function handleSearch(q: string) {
    vscode.postMessage({ command: 'search', query: q });
  }

  function handleAnalyzeProjectLocal() {
    isAnalyzing = true;
    analysisError = '';
    statusMessage = 'Starting local analysis...';
    vscode.postMessage({ command: 'analyse_project_local' });
  }

  function handleDownloadModel() {
    isDownloadingModel = true;
    analysisError = '';
    vscode.postMessage({ command: 'download_model' });
  }

  function handleDeleteModel() {
    analysisError = '';
    vscode.postMessage({ command: 'delete_model' });
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

  function handleOpenFile(filePath: string) {
    vscode.postMessage({ command: 'open_location', filePath, startLine: 1 });
  }

  function handleAnalyseFile(item: HotspotItem) {
    fileAnalyses[item.id] = {
      isAnalyzing: true,
      content: '',
      expanded: true
    };
    const plainItem = JSON.parse(JSON.stringify($state.snapshot(item)));
    vscode.postMessage({ command: 'analyse_file_local', item: plainItem });
  }

  function handleToggleExpand(id: string) {
    if (fileAnalyses[id]) {
      fileAnalyses[id].expanded = !fileAnalyses[id].expanded;
    }
  }

  window.addEventListener('message', async (event) => {
    const { type, payload } = event.data;
    if (type === 'model_status') {
      modelStatus = payload || { isDownloaded: false, sizeMb: 0 };
      isDownloadingModel = false;
      downloadProgress = null;
    } else if (type === 'model_download_progress') {
      downloadProgress = payload;
      isDownloadingModel = true;
    } else if (type === 'model_download_error') {
      isDownloadingModel = false;
      downloadProgress = null;
      analysisError = `Download failed: ${payload}`;
    } else if (type === 'analysis_status') {
      statusMessage = payload?.message || 'Processing...';
    } else if (type === 'hotspots_result') {
      isAnalyzing = false;
      statusMessage = '';
      if (Array.isArray(payload)) {
        hotspots = payload;
      } else {
        hotspots = payload.hotspots || [];
        stats = payload.stats || null;
      }
    } else if (type === 'hotspots_error') {
      isAnalyzing = false;
      analysisError = payload || 'Local architecture analysis failed';
      statusMessage = '';
    } else if (type === 'index_complete') {
      if (payload) {
        stats = {
          fileCount: payload.indexedCount,
          folderCount: 0,
          symbolCount: payload.totalSymbols,
          durationMs: 0
        };
      }
    } else if (type === 'ai_start') {
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
    } else if (type === 'file_analysis_start') {
      const { id } = payload;
      fileAnalyses[id] = {
        isAnalyzing: true,
        content: '',
        expanded: true
      };
    } else if (type === 'file_analysis_chunk') {
      const { id, chunk } = payload;
      if (!fileAnalyses[id]) {
        fileAnalyses[id] = { isAnalyzing: true, content: '', expanded: true };
      }
      fileAnalyses[id].content += chunk;
    } else if (type === 'file_analysis_complete') {
      const { id } = payload;
      if (fileAnalyses[id]) {
        fileAnalyses[id].isAnalyzing = false;
      }
    } else if (type === 'file_analysis_error') {
      const { id, error } = payload;
      if (!fileAnalyses[id]) {
        fileAnalyses[id] = { isAnalyzing: false, content: '', expanded: true };
      }
      fileAnalyses[id].isAnalyzing = false;
      fileAnalyses[id].error = error;
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
        onclick={handleAnalyzeProjectLocal}
        disabled={isAnalyzing || isDownloadingModel}
        class="text-zinc-50 text-xs px-3 py-2 h-fit w-full mb-auto rounded bg-zinc-400/30 hover:bg-zinc-400/40 disabled:opacity-50 transition-colors leading-none cursor-pointer flex items-center justify-center gap-2"
        title="Analyse Project (WASM + Qwen 2.5 Coder)"
      >
        {#if isAnalyzing}
          <span class="inline-block animate-spin">⚙️</span>
          <span>Analysing Project (Qwen 2.5 Coder)...</span>
        {:else if isDownloadingModel}
          <span class="inline-block animate-spin">⬇️</span>
          <span>Downloading Model ({downloadProgress?.pct ?? 0}%)...</span>
        {:else}
          <span>Analyse Project</span>
        {/if}
      </button>
    </div>

    <Hotspots
      {hotspots}
      {isAnalyzing}
      {stats}
      {statusMessage}
      {modelStatus}
      {downloadProgress}
      {analysisError}
      {isDownloadingModel}
      {fileAnalyses}
      onDownloadModel={handleDownloadModel}
      onDeleteModel={handleDeleteModel}
      onRetry={handleAnalyzeProjectLocal}
      onOpenFile={handleOpenFile}
      onAnalyseFile={handleAnalyseFile}
      onToggleExpand={handleToggleExpand}
    />
  </div>
</main>
