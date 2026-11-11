export interface StreamCallbacks {
  onChunk: (chunk: string) => void;
  onComplete: () => void;
  onError: (error: string) => void;
}

export class OpenRouterClient {
  private apiKey: string | null = null;
  private defaultModel = 'nvidia/nemotron-3.5-lightning:free';

  // Free fallback cascade if one provider is temporarily rate-limited
  private fallbackModels = [
    'nvidia/nemotron-3.5-lightning:free',
    'cohere/north-mini-code:free',
    'google/gemma-4-26b-a4b-it:free',
    'baidu/ernie-5.5-flash-preview:free',
    'google/gemma-4-31b-it:free'
  ];

  setApiKey(key: string): void {
    this.apiKey = key.trim();
  }

  getApiKey(): string | null {
    return this.apiKey;
  }

  ensureFreeModel(model: string): string {
    const trimmed = model.trim();
    if (trimmed.endsWith(':free') || trimmed === 'openrouter/free') {
      return trimmed;
    }
    return this.defaultModel;
  }

  async streamCompletion(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    requestedModel: string,
    callbacks: StreamCallbacks,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (!this.apiKey) {
      callbacks.onError('OpenRouter API key is missing. Run command "CodeGraph: Set OpenRouter API Key" first.');
      return;
    }

    const primaryModel = this.ensureFreeModel(requestedModel);
    const modelsToTry = [
      primaryModel,
      ...this.fallbackModels.filter((m) => m !== primaryModel)
    ];

    let lastError = '';

    for (const model of modelsToTry) {
      try {
        console.log(`[CodeGraph] Trying OpenRouter model: ${model}...`);
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
            'HTTP-Referer': 'https://github.com/antigravity/vscode-codegraph-rag',
            'X-Title': 'VS Code CodeGraph RAG'
          },
          body: JSON.stringify({
            model,
            messages,
            stream: true,
            temperature: 0.2
          }),
          signal: abortSignal
        });

        if (response.status === 429 || response.status === 404 || response.status === 503) {
          const errText = await response.text();
          console.warn(`[CodeGraph] Model ${model} returned ${response.status}. Trying next fallback...`);
          lastError = `(${response.status}): ${errText}`;
          continue; // Try next free model in cascade
        }

        if (!response.ok) {
          const errorText = await response.text();
          callbacks.onError(`OpenRouter API error (${response.status}): ${errorText}`);
          return;
        }

        if (!response.body) {
          callbacks.onError('OpenRouter returned empty response body');
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;

            if (trimmed.startsWith('data: ')) {
              const dataStr = trimmed.slice(6);
              if (dataStr === '[DONE]') {
                callbacks.onComplete();
                return;
              }

              try {
                const parsed = JSON.parse(dataStr);
                const content = parsed.choices?.[0]?.delta?.content;
                if (content) {
                  callbacks.onChunk(content);
                }
              } catch (err) {
                // ignore unparseable chunks
              }
            }
          }
        }

        callbacks.onComplete();
        return; // Success!
      } catch (err: any) {
        if (err.name === 'AbortError') {
          callbacks.onComplete();
          return;
        }
        lastError = err.message || String(err);
      }
    }

    callbacks.onError(`All free models are currently busy or rate-limited. Last error: ${lastError}`);
  }
}
