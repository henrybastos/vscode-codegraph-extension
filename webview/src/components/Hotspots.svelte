<script lang="ts">
  import { Markdown } from '@comark/svelte';

  export interface HotspotItem {
    id: string;
    type: 'file' | 'folder';
    path: string;
    category:
      | 'God File'
      | 'Circular Dependency'
      | 'Layer Bypass'
      | 'Unstable Foundation'
      | 'Bottleneck Hub'
      | 'Domain Tangling'
      | 'Feature Envy'
      | 'Architecture Tip';
    severity: 'critical' | 'high' | 'medium' | 'info';
    title: string;
    description: string;
    metrics?: {
      loc?: number;
      fanIn?: number;
      fanOut?: number;
      instability?: number;
      pagerank?: number;
      betweenness?: number;
    };
  }

  export interface AnalysisStats {
    fileCount: number;
    folderCount: number;
    symbolCount: number;
    durationMs: number;
  }

  export interface ProgressInfo {
    pct: number;
    loadedMb: number;
    totalMb: number;
    phase?: string;
  }

  export interface FileAnalysisState {
    isAnalyzing: boolean;
    content: string;
    error?: string;
    expanded: boolean;
  }

  let {
    hotspots = [],
    isAnalyzing = false,
    stats = null,
    statusMessage = '',
    modelStatus = { isDownloaded: false, sizeMb: 0 },
    downloadProgress = null,
    analysisError = '',
    isDownloadingModel = false,
    fileAnalyses = {},
    onDownloadModel,
    onDeleteModel,
    onRetry,
    onOpenFile,
    onAnalyseFile,
    onToggleExpand
  }: {
    hotspots?: HotspotItem[];
    isAnalyzing?: boolean;
    stats?: AnalysisStats | null;
    statusMessage?: string;
    modelStatus?: { isDownloaded: boolean; sizeMb: number };
    downloadProgress?: ProgressInfo | null;
    analysisError?: string;
    isDownloadingModel?: boolean;
    fileAnalyses?: Record<string, FileAnalysisState>;
    onDownloadModel?: () => void;
    onDeleteModel?: () => void;
    onRetry?: () => void;
    onOpenFile?: (path: string) => void;
    onAnalyseFile?: (item: HotspotItem) => void;
    onToggleExpand?: (id: string) => void;
  } = $props();

  function getCardTheme(category: string) {
    switch (category) {
      case 'God File':
      case 'Circular Dependency':
      case 'Layer Bypass':
      case 'Unstable Foundation':
        return {
          container: 'border-red-400/50 bg-red-200/5',
          title: 'text-red-400',
          sub: 'text-red-400/50',
          btn: 'text-red-400 bg-red-400/5 hover:bg-red-400/10'
        };
      case 'Bottleneck Hub':
      case 'Domain Tangling':
        return {
          container: 'border-amber-400/50 bg-amber-200/5',
          title: 'text-amber-400',
          sub: 'text-amber-400/50',
          btn: 'text-amber-400 bg-amber-400/5 hover:bg-amber-400/10'
        };
      case 'Architecture Tip':
      case 'Feature Envy':
      default:
        return {
          container: 'border-blue-400/50 bg-blue-200/5',
          title: 'text-blue-400',
          sub: 'text-blue-400/50',
          btn: 'text-blue-400 bg-blue-400/5 hover:bg-blue-400/10'
        };
    }
  }
</script>

<div class="flex flex-col gap-2 p-2 bg-[var(--vscode-sideBar-background)] h-full overflow-y-auto">
  <div class="flex flex-col items-center gap-2">
    <!-- Model Management Bar -->
    <div class="flex flex-col gap-2 p-2.5 rounded-md bg-[var(--vscode-sideBarSectionHeader-background)]/50 border border-[var(--vscode-panel-border)]/40 w-full text-xs">
      <div class="flex items-center justify-between gap-1">
        <div class="flex items-center gap-1.5 min-w-0">
          <span class="text-sm shrink-0">🧠</span>
          <div class="flex flex-col min-w-0">
            <span class="font-medium text-[var(--vscode-foreground)] truncate">Qwen 2.5 Coder 0.5B</span>
            <span class="text-[10px] text-[var(--vscode-descriptionForeground)]">Local Native (node-llama-cpp)</span>
          </div>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          {#if modelStatus.isDownloaded}
            <span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-mono">
              Ready ({modelStatus.sizeMb} MB)
            </span>
            <button
              onclick={onDeleteModel}
              disabled={isAnalyzing || isDownloadingModel}
              class="text-xs px-2 py-1 rounded bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 transition-colors cursor-pointer disabled:opacity-50"
              title="Delete GGUF model file to free disk space"
            >
              Delete
            </button>
          {:else if isDownloadingModel}
            <span class="text-xs text-amber-400 animate-pulse font-mono">Downloading...</span>
          {:else}
            <button
              onclick={onDownloadModel}
              disabled={isAnalyzing}
              class="text-xs px-2.5 py-1 rounded bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 border border-blue-500/30 transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1"
              title="Download Qwen 2.5 Coder 0.5B Q4_K_M (~398 MB)"
            >
              <span>⬇️</span>
              <span>Download Model</span>
            </button>
          {/if}
        </div>
      </div>

      <!-- Download Progress Bar (From HuggingFace to Disk) -->
      {#if downloadProgress}
        <div class="flex flex-col gap-1 mt-1">
          <div class="flex items-center justify-between text-[11px] text-[var(--vscode-descriptionForeground)] font-mono">
            <span>Downloading GGUF to disk...</span>
            <span>{downloadProgress.loadedMb} / {downloadProgress.totalMb} MB ({downloadProgress.pct}%)</span>
          </div>
          <div class="w-full bg-[var(--vscode-editor-background)] rounded-full h-1.5 overflow-hidden">
            <div
              class="bg-blue-500 h-1.5 rounded-full transition-all duration-200"
              style="width: {downloadProgress.pct}%"
            ></div>
          </div>
        </div>
      {/if}
    </div>

    <!-- Error Banner -->
    {#if analysisError}
      <div class="flex flex-col gap-2 p-3 rounded-md bg-red-500/15 border border-red-500/30 text-red-200 text-xs w-full">
        <div class="flex items-center justify-between">
          <span class="font-semibold flex items-center gap-1.5 text-red-400">
            <span>⚠️</span>
            <span>Model Error</span>
          </span>
          {#if onRetry}
            <button
              onclick={onRetry}
              class="text-[11px] px-2 py-0.5 rounded bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/40 cursor-pointer transition-colors"
            >
              Retry
            </button>
          {/if}
        </div>
        <p class="font-mono text-[11px] text-red-300/90 break-words leading-relaxed">{analysisError}</p>
      </div>
    {/if}

    <!-- Hotspots Header -->
    <div class="flex items-center justify-between w-full mt-1">
      <h2 class="text-xs text-left font-medium uppercase tracking-wider text-[var(--vscode-descriptionForeground)]">
        Hotspots {hotspots.length > 0 ? `(${hotspots.length})` : ''}
      </h2>
      {#if isAnalyzing}
        <span class="text-xs text-amber-400 animate-pulse truncate" title={statusMessage}>
          {statusMessage || 'Running inference...'}
        </span>
      {/if}
    </div>

    <!-- Visual Feedback: Workspace Stats Pill -->
    {#if stats}
      <div class="flex items-center justify-between text-xs px-2.5 py-1.5 rounded-md bg-[var(--vscode-badge-background)]/10 border border-[var(--vscode-badge-background)]/20 text-[var(--vscode-foreground)] w-full">
        <div class="flex items-center gap-3 text-[11px]">
          {#if stats.folderCount > 0}
            <span class="flex items-center gap-1" title="Analyzed folders (excluding .next, dist, node_modules)">
              <span class="text-[var(--vscode-descriptionForeground)]">📁</span>
              <span><strong>{stats.folderCount}</strong> folders</span>
            </span>
          {/if}
          <span class="flex items-center gap-1" title="Analyzed source files">
            <span class="text-[var(--vscode-descriptionForeground)]">📄</span>
            <span><strong>{stats.fileCount}</strong> files</span>
          </span>
          <span class="flex items-center gap-1" title="AST symbols parsed">
            <span class="text-[var(--vscode-descriptionForeground)]">⚡</span>
            <span><strong>{stats.symbolCount}</strong> symbols</span>
          </span>
        </div>
        {#if stats.durationMs > 0}
          <span class="text-[var(--vscode-descriptionForeground)] font-mono text-[10px]">{stats.durationMs}ms</span>
        {/if}
      </div>
    {/if}

    {#if hotspots.length > 0}
      {#each hotspots as item (item.id)}
        {@const theme = getCardTheme(item.category)}
        {@const analysis = fileAnalyses[item.id]}
        <div class="flex flex-col w-full border {theme.container} p-3 rounded-md transition-all">
          <div class="inline-flex justify-between items-start mb-1 gap-2">
            <div class="flex flex-col min-w-0">
              <div class="inline-flex items-center *:leading-none gap-1 mb-1">
                <span class="{theme.title} font-medium">{item.category}</span>
                <span class="{theme.sub} text-xs uppercase">•</span>
                <span class="{theme.sub} text-xs uppercase">{item.type === 'file' ? 'File' : 'Folder'}</span>
              </div>
              <span class="font-mono text-xs text-[var(--vscode-descriptionForeground)] truncate" title={item.path}>
                {item.path.startsWith('/') ? item.path : `/${item.path}`}
              </span>
            </div>

            <!-- Action Buttons: Open & Analyse -->
            <div class="flex items-center gap-1.5 shrink-0">
              {#if item.type === 'file'}
                <button
                  type="button"
                  onclick={() => onOpenFile?.(item.path)}
                  class="text-xs px-2.5 py-1.5 h-fit rounded border border-[var(--vscode-button-border,transparent)] bg-[var(--vscode-button-secondaryBackground,#2a2d2e)] text-[var(--vscode-button-secondaryForeground,#cccccc)] hover:bg-[var(--vscode-button-secondaryHoverBackground,#37373d)] transition-colors leading-none cursor-pointer flex items-center gap-1"
                  title="Open file in editor"
                >
                  <span>Open</span>
                </button>
              {/if}

              <button
                type="button"
                onclick={() => onAnalyseFile?.(item)}
                disabled={analysis?.isAnalyzing}
                class="{theme.btn} text-xs px-3 py-1.5 h-fit rounded transition-colors leading-none cursor-pointer flex items-center gap-1 disabled:opacity-50"
                title="Analyse this {item.type}"
              >
                {#if analysis?.isAnalyzing}
                  <span class="inline-block animate-spin">⚙️</span>
                  <span>Analysing...</span>
                {:else if analysis?.content}
                  <span>Re-analyse</span>
                {:else}
                  <span>Analyse</span>
                {/if}
              </button>
            </div>
          </div>

          <p class="text-xs text-[var(--vscode-foreground)] leading-relaxed mt-1">{item.description}</p>

          <!-- Inline Analysis Expansion Section -->
          {#if analysis}
            <div class="mt-3 pt-2.5 border-t border-[var(--vscode-widget-border,#333)] text-xs">
              <div class="flex items-center justify-between mb-1.5">
                <div class="flex items-center gap-1.5 text-[11px] font-medium text-[var(--vscode-descriptionForeground)]">
                  <span class="inline-block w-2 h-2 rounded-full {analysis.isAnalyzing ? 'bg-amber-400 animate-ping' : 'bg-emerald-400'}"></span>
                  <span>Qwen 2.5 Coder Architectural Diagnosis</span>
                </div>
                {#if analysis.content}
                  <button
                    type="button"
                    onclick={() => onToggleExpand?.(item.id)}
                    class="text-[10px] text-[var(--vscode-textLink-foreground,#3794ff)] hover:underline cursor-pointer"
                  >
                    {analysis.expanded ? 'Collapse' : 'Expand'}
                  </button>
                {/if}
              </div>

              {#if analysis.error}
                <div class="p-2 rounded bg-rose-950/30 border border-rose-800/40 text-rose-300 text-[11px]">
                  ⚠️ {analysis.error}
                </div>
              {:else if analysis.expanded}
                {#if analysis.isAnalyzing && !analysis.content}
                  <div class="flex items-center gap-2 p-3 text-[var(--vscode-descriptionForeground)] text-[11px]">
                    <span class="animate-spin">⚙️</span>
                    <span>Reasoning about code topology & refactoring strategies...</span>
                  </div>
                {:else if analysis.content}
                  <div class="comark-rendered-container prose dark:prose-invert max-w-none text-xs leading-relaxed max-h-96 overflow-y-auto select-text p-2 rounded bg-[var(--vscode-editor-background)] border border-[var(--vscode-widget-border,#252526)]">
                    <Markdown value={analysis.content} streaming={analysis.isAnalyzing} />
                  </div>
                {/if}
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    {:else if isAnalyzing}
      <div class="flex flex-col items-center justify-center p-8 gap-3 text-center text-xs text-[var(--vscode-descriptionForeground)]">
        <div class="text-lg animate-spin">⚙️</div>
        <p>{statusMessage || 'Extracting in-memory graph metrics & running Qwen 2.5 Coder classification...'}</p>
        <span class="text-[10px] text-[var(--vscode-descriptionForeground)] opacity-75">Excluded: .next, dist, node_modules, build</span>
      </div>
    {:else if stats}
      <div class="flex flex-col items-center justify-center p-8 gap-2 text-center text-xs text-[var(--vscode-descriptionForeground)]">
        <div class="text-base text-emerald-400">✅</div>
        <p class="font-medium text-[var(--vscode-foreground)]">Clean Architecture</p>
        <p class="text-[11px] max-w-[240px] text-[var(--vscode-descriptionForeground)]">No critical architectural hotspots detected by Qwen 2.5 Coder or graph assertions.</p>
      </div>
    {:else}
      <p class="text-xs text-[var(--vscode-descriptionForeground)] leading-relaxed">Nothing to show here. Click "Analyse Project" above to inspect architecture.</p>
    {/if}
  </div>
</div>
