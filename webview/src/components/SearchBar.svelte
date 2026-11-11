<script lang="ts">
  interface Props {
    query: string;
    onSearch: (q: string) => void;
    onReindex: () => void;
    onSetApiKey: () => void;
  }

  let { query = $bindable(''), onSearch, onReindex, onSetApiKey }: Props = $props();

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function handleInput(e: Event) {
    const val = (e.target as HTMLInputElement).value;
    query = val;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      onSearch(val);
    }, 200);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      if (debounceTimer) clearTimeout(debounceTimer);
      onSearch(query);
    }
  }
</script>

<div class="flex flex-col gap-2 p-2 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-background)]">
  <div class="flex items-center gap-1.5">
    <div class="relative flex-1">
      <input
        type="text"
        value={query}
        oninput={handleInput}
        onkeydown={handleKeyDown}
        placeholder="Search symbols (FTS5 indexed)..."
        class="w-full pl-2.5 pr-6 py-1 text-xs rounded border border-[var(--vscode-input-border)] bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] placeholder-[var(--vscode-input-placeholderForeground)] focus:outline-none focus:border-[var(--vscode-focusBorder)]"
      />
      {#if query}
        <button
          onclick={() => { query = ''; onSearch(''); }}
          class="absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] cursor-pointer"
          title="Clear search"
        >
          ✕
        </button>
      {/if}
    </div>

    <button
      onclick={() => onSearch(query)}
      class="px-2.5 py-1 text-xs font-medium rounded bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] cursor-pointer"
      title="Search"
    >
      Find
    </button>
  </div>

  <div class="flex items-center justify-between text-xs text-[var(--vscode-descriptionForeground)] px-0.5">
    <span class="flex items-center gap-1 font-mono text-xs">
      <span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
      RAM Graph + FTS5
    </span>
    <div class="flex items-center gap-2">
      <button
        onclick={onReindex}
        class="hover:text-[var(--vscode-foreground)] underline cursor-pointer"
        title="Re-index workspace files"
      >
        Re-index
      </button>
      <span>•</span>
      <button
        onclick={onSetApiKey}
        class="hover:text-[var(--vscode-foreground)] underline cursor-pointer"
        title="Configure OpenRouter API Key"
      >
        API Key
      </button>
    </div>
  </div>
</div>
