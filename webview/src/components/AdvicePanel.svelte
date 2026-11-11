<script lang="ts">
  import { Markdown } from '@comark/svelte';

  interface Props {
    isAnalyzing: boolean;
    aiAdvice: string;
    mode: 'structure' | 'symbol' | null;
    focalName: string | null;
    stats?: { directories: number; files: number } | null;
    onRunAnalysis: () => void;
    onAbortAnalysis: () => void;
  }

  let {
    isAnalyzing,
    aiAdvice,
    mode,
    focalName,
    stats,
    onRunAnalysis,
    onAbortAnalysis
  }: Props = $props();

  let copied = $state(false);

  function handleCopy() {
    if (!aiAdvice) return;
    navigator.clipboard.writeText(aiAdvice);
    copied = true;
    setTimeout(() => {
      copied = false;
    }, 1500);
  }
</script>

<div class="flex-1 flex flex-col min-h-0 bg-[var(--vscode-sideBar-background)] p-2.5 overflow-hidden">
  <!-- Header Bar -->
  <div class="flex items-center justify-between pb-2 mb-2 border-b border-[var(--vscode-widget-border)] shrink-0">
    <div class="flex items-center gap-1.5 overflow-hidden">
      <span class="inline-block w-2 h-2 rounded-full {isAnalyzing ? 'bg-amber-400 animate-ping' : 'bg-emerald-500'}"></span>
      <h3 class="text-xs font-bold uppercase tracking-wider text-[var(--vscode-descriptionForeground)] truncate">
        {mode === 'structure' ? 'Project Structure & Architecture Audit' : 'Architectural Insights'}
      </h3>
      {#if stats}
        <span class="text-[10px] px-1.5 py-0.5 rounded bg-[var(--vscode-badge-background)] text-[var(--vscode-badge-foreground)] font-mono">
          {stats.directories} dirs, {stats.files} files
        </span>
      {/if}
    </div>

    <div class="flex items-center gap-1.5 shrink-0">
      {#if aiAdvice && !isAnalyzing}
        <button
          onclick={handleCopy}
          class="px-2 py-0.5 text-[10px] font-medium rounded border border-[var(--vscode-button-border,transparent)] bg-[var(--vscode-button-secondaryBackground,#333)] text-[var(--vscode-button-secondaryForeground,#fff)] hover:bg-[var(--vscode-button-secondaryHoverBackground,#444)] cursor-pointer"
          title="Copy Markdown output"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      {/if}

      {#if isAnalyzing}
        <button
          onclick={onAbortAnalysis}
          class="px-2.5 py-0.5 text-[10px] font-semibold rounded bg-rose-700 hover:bg-rose-800 text-white cursor-pointer"
          title="Cancel AI generation"
        >
          Stop
        </button>
      {/if}
    </div>
  </div>

  <!-- Markdown Content Render Area with Comark -->
  <div class="flex-1 overflow-y-auto pr-1 text-xs select-text">
    {#if isAnalyzing && !aiAdvice}
      <div class="flex flex-col items-center justify-center p-8 text-[var(--vscode-descriptionForeground)] gap-2 text-center">
        <span class="inline-block w-3 h-3 rounded-full bg-blue-400 animate-ping"></span>
        <div class="text-xs font-medium">Scanning file tree & querying OpenRouter...</div>
        <div class="text-[10px] text-[var(--vscode-descriptionForeground)] opacity-70">
          Streaming architecture and best practice recommendations
        </div>
      </div>
    {:else if aiAdvice}
      <div class="comark-rendered-container prose dark:prose-invert max-w-none text-xs leading-relaxed">
        <Markdown value={aiAdvice} streaming={isAnalyzing} />
      </div>
    {:else}
      <div class="flex flex-col items-center justify-center h-full p-6 text-center text-xs text-[var(--vscode-descriptionForeground)] gap-2">
        <p class="font-medium text-[var(--vscode-foreground)]">Ready to audit project architecture</p>
        <p class="text-[11px] leading-relaxed max-w-sm">
          Click <b>"Analyse project structure"</b> above to examine your folder hierarchy, separation of concerns, and receive SOLID / Clean Architecture advice.
        </p>
      </div>
    {/if}
  </div>
</div>

<style>
  :global(.comark-rendered-container) {
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
  }

  :global(.comark-rendered-container h1),
  :global(.comark-rendered-container h2),
  :global(.comark-rendered-container h3) {
    color: var(--vscode-foreground);
    font-weight: 700;
    margin-top: 1rem;
    margin-bottom: 0.4rem;
  }

  :global(.comark-rendered-container h1) { font-size: 1.15rem; }
  :global(.comark-rendered-container h2) { font-size: 1.05rem; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 0.25rem; }
  :global(.comark-rendered-container h3) { font-size: 0.95rem; }

  :global(.comark-rendered-container p) {
    margin-bottom: 0.6rem;
    line-height: 1.5;
  }

  :global(.comark-rendered-container ul),
  :global(.comark-rendered-container ol) {
    padding-left: 1.25rem;
    margin-bottom: 0.6rem;
  }

  :global(.comark-rendered-container li) {
    margin-bottom: 0.25rem;
  }

  :global(.comark-rendered-container code) {
    font-family: var(--vscode-editor-font-family, monospace);
    background-color: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.15));
    padding: 0.1rem 0.25rem;
    border-radius: 3px;
    font-size: 0.9em;
  }

  :global(.comark-rendered-container pre) {
    background-color: var(--vscode-textCodeBlock-background, rgba(0, 0, 0, 0.3));
    padding: 0.75rem;
    border-radius: 4px;
    overflow-x: auto;
    margin-bottom: 0.75rem;
    border: 1px solid var(--vscode-widget-border, transparent);
  }

  :global(.comark-rendered-container pre code) {
    background: transparent;
    padding: 0;
  }

  :global(.comark-rendered-container blockquote) {
    border-left: 3px solid var(--vscode-textBlockQuote-border, #007acc);
    padding-left: 0.75rem;
    margin: 0.5rem 0;
    color: var(--vscode-textBlockQuote-foreground, var(--vscode-descriptionForeground));
  }
</style>
