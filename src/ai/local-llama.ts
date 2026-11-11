import type { HotspotItem } from '../graph/assertions.js';

// Native dynamic import to safely load ESM node-llama-cpp in CJS extension bundle
const dynamicImport = new Function('specifier', 'return import(specifier)');

let llamaModule: any = null;
let llamaInstance: any = null;
let loadedModel: any = null;
let currentModelPath: string | null = null;

async function getLlamaModule() {
  if (!llamaModule) {
    llamaModule = await dynamicImport('node-llama-cpp');
  }
  return llamaModule;
}

const HOTSPOT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    classifications: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          type: { type: 'string', enum: ['file', 'folder'] },
          category: {
            type: 'string',
            enum: [
              'God File',
              'Layer Bypass',
              'Unstable Foundation',
              'Bottleneck Hub',
              'Domain Tangling',
              'Feature Envy',
              'Architecture Tip'
            ]
          },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'info'] },
          title: { type: 'string' },
          description: { type: 'string' }
        },
        required: ['path', 'type', 'category', 'severity', 'title', 'description']
      }
    }
  },
  required: ['classifications']
} as const;

export async function runLocalLlamaInference(
  modelPath: string,
  deterministicHotspots: HotspotItem[],
  fileCandidates: any[],
  folderCandidates: any[],
  onStatus?: (msg: string) => void
): Promise<HotspotItem[]> {
  const hotspots: HotspotItem[] = [...deterministicHotspots];

  if (fileCandidates.length === 0 && folderCandidates.length === 0) {
    return hotspots;
  }

  const { getLlama, LlamaChatSession, LlamaJsonSchemaGrammar } = await getLlamaModule();

  // 1. Initialize llama.cpp engine
  if (!llamaInstance) {
    if (onStatus) onStatus('Step 1/3: Initializing native llama.cpp runtime...');
    llamaInstance = await getLlama();
  }

  // 2. Load model via OS mmap (instant)
  if (!loadedModel || currentModelPath !== modelPath) {
    if (onStatus) onStatus('Step 2/3: Memory-mapping Qwen 2.5 Coder GGUF...');
    if (loadedModel) {
      try {
        await loadedModel.dispose();
      } catch {}
      loadedModel = null;
    }
    loadedModel = await llamaInstance.loadModel({
      modelPath
    });
    currentModelPath = modelPath;
  }

  // 3. Create context and execute structured reasoning
  if (onStatus) onStatus('Step 3/3: Evaluating prompt context & graph metrics...');
  const context = await loadedModel.createContext({
    contextSize: 2048
  });

  try {
    const grammar = new LlamaJsonSchemaGrammar(llamaInstance, HOTSPOT_JSON_SCHEMA as any);

    const systemPrompt = `You are an expert software architect analyzing code graph metrics.
Review the provided candidate files and folders and classify the most notable items into architectural hotspots or tips.
Categories: 'God File', 'Layer Bypass', 'Unstable Foundation', 'Bottleneck Hub', 'Domain Tangling', 'Feature Envy', 'Architecture Tip'.
Provide actionable, clear titles and descriptions.`;

    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt
    });

    const userPrompt = `Select between 1 to 5 highest priority architectural concerns or recommendations for these candidate files and folders. Keep descriptions concise.

Files:
${JSON.stringify(fileCandidates.slice(0, 15), null, 2)}

Folders:
${JSON.stringify(folderCandidates.slice(0, 8), null, 2)}

Output the classifications array adhering to the schema.`;

    const inferStartTime = Date.now();
    let tokenCount = 0;

    const rawResponse = await session.prompt(userPrompt, {
      grammar,
      maxTokens: 1200,
      temperature: 0.2,
      onTextChunk() {
        tokenCount++;
        const elapsedSec = (Date.now() - inferStartTime) / 1000;
        const tokPerSec = elapsedSec > 0.3 ? (tokenCount / elapsedSec).toFixed(1) : '...';
        if (onStatus) {
          onStatus(`Step 3/3: Reasoning with Qwen (${tokenCount} tokens, ${tokPerSec} tok/s)...`);
        }
      }
    });

    try {
      let classifications: any[] = [];
      try {
        const parsed = JSON.parse(rawResponse);
        if (Array.isArray(parsed.classifications)) {
          classifications = parsed.classifications;
        }
      } catch {
        // Fallback: extract valid JSON objects if response was truncated
        const matches = rawResponse.matchAll(/\{[^{}]*"path"\s*:\s*"[^"]+"[^{}]*\}/g);
        for (const m of matches) {
          try {
            classifications.push(JSON.parse(m[0]));
          } catch {}
        }
      }

      for (const item of classifications) {
        if (!item.path) continue;
        const normPath = item.path.replace(/\\/g, '/');
        const isFile = /\.[a-zA-Z0-9]+$/.test(normPath);

        hotspots.push({
          id: `qwen-${isFile ? 'file' : 'folder'}-${normPath.replace(/[^a-zA-Z0-9]/g, '_')}-${Math.random().toString(36).substring(2, 6)}`,
          type: isFile ? 'file' : (item.type === 'folder' ? 'folder' : 'file'),
          path: normPath,
          category: item.category as any,
          severity: item.severity || 'medium',
          title: item.title || `${item.category}: ${normPath.split('/').pop()}`,
          description: item.description || ''
        });
      }
    } catch (parseErr) {
      console.error('[local-llama] Failed to parse model output:', rawResponse, parseErr);
    }
  } finally {
    // Release context sequence
    try {
      await context.dispose();
    } catch {}
  }

  // Deduplicate hotspots by path + category
  const seen = new Set<string>();
  const deduplicated: HotspotItem[] = [];
  for (const h of hotspots) {
    const key = `${h.path}::${h.category}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(h);
    }
  }

  return deduplicated;
}

export async function disposeLocalLlama(): Promise<void> {
  if (loadedModel) {
    try {
      await loadedModel.dispose();
    } catch {}
    loadedModel = null;
    currentModelPath = null;
  }
}
