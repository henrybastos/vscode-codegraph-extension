<script lang="ts">
  interface Props {
    isAnalyzing: boolean;
    aiAdvice: string;
    focalSymbolName: string | null;
    cycles: string[][];
    onRunAudit: () => void;
    onAbortAudit: () => void;
  }

  let {
    isAnalyzing,
    aiAdvice,
    focalSymbolName,
    cycles,
    onRunAudit,
    onAbortAudit
  }: Props = $props();
</script>

<div class="h-48 flex flex-col bg-[var(--vscode-sideBar-background)] p-2 overflow-hidden border-t border-[var(--vscode-panel-border)]">
  <div class="flex items-center justify-between pb-1 mb-1 border-b border-[var(--vscode-widget-border)]">
    <div class="flex items-center gap-1.5">
      <h3 class="text-[11px] font-bold uppercase tracking-wider text-[var(--vscode-descriptionForeground)]">
        Architectural Audit
      </h3>
      {#if cycles.length > 0}
        <span class="text-[9px] px-1.5 py-0.2 rounded bg-rose-950 text-rose-300 border border-rose-700/60 font-semibold" title="Cycle detected in dependencies">
          ⚠️ {cycles.length} Cycle{cycles.length > 1 ? 's' : ''}
        </span>
      {/if}
    </div>

    <div class="flex items-center gap-1.5">
      {#if isAnalyzing}
        <button
          onclick={onAbortAudit}
          class="px-2 py-0.5 text-[10px] font-semibold rounded bg-rose-700 hover:bg-rose-800 text-white cursor-pointer"
        >
          Stop
        </button>
      {:else}
        <button
          onclick={onRunAudit}
          disabled={!focalSymbolName}
          class="px-2.5 py-0.5 text-[10px] font-semibold rounded bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          Run AI Audit
        </button>
      {/if}
    </div>
  </div>

  <div class="flex-1 overflow-y-auto text-xs pr-1">
    {#if isAnalyzing && !aiAdvice}
      <div class="flex items-center gap-2 p-3 text-[var(--vscode-descriptionForeground)] text-xs animate-pulse">
        <span class="inline-block w-2 h-2 rounded-full bg-blue-400 animate-ping"></span>
        Streaming architectural audit from OpenRouter...
      </div>
    {:else if aiAdvice}
      <div class="whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-[var(--vscode-foreground)] selection:bg-[var(--vscode-editor-selectionBackground)]">
        {aiAdvice}
      </div>
    {:else}
      <div class="p-3 text-center text-xs text-[var(--vscode-descriptionForeground)] italic">
        Select a symbol and click "Run AI Audit" to review anti-patterns, coupling, and SOLID recommendations using free OpenRouter models.
      </div>
    {/if}
  </div>
</div>
