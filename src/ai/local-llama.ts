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

const SLM_VALIDATION_SCHEMA = {
  type: 'object',
  properties: {
    isViolation: { type: 'boolean' },
    reason: { type: 'string' },
    suggestedFiles: {
      type: 'array',
      items: { type: 'string' }
    }
  },
  required: ['isViolation', 'reason']
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

export async function validateCandidatesWithLlama(
  modelPath: string,
  candidatesWithPrompts: Array<{ candidate: any; prompt: string }>,
  onStatus?: (msg: string) => void
): Promise<Map<string, { isViolation: boolean; reason?: string; suggestedFiles?: string[] }>> {
  const results = new Map<string, { isViolation: boolean; reason?: string; suggestedFiles?: string[] }>();
  if (candidatesWithPrompts.length === 0) return results;

  const { getLlama, LlamaChatSession, LlamaJsonSchemaGrammar } = await getLlamaModule();

  if (!llamaInstance) {
    if (onStatus) onStatus('Step 3/3: Initializing native llama.cpp runtime...');
    llamaInstance = await getLlama();
  }

  if (!loadedModel || currentModelPath !== modelPath) {
    if (onStatus) onStatus('Step 3/3: Memory-mapping Qwen 2.5 Coder GGUF...');
    if (loadedModel) {
      try {
        await loadedModel.dispose();
      } catch {}
      loadedModel = null;
    }
    loadedModel = await llamaInstance.loadModel({ modelPath });
    currentModelPath = modelPath;
  }

  const context = await loadedModel.createContext({ contextSize: 2048 });

  try {
    const grammar = new LlamaJsonSchemaGrammar(llamaInstance, SLM_VALIDATION_SCHEMA as any);

    const systemPrompt = `You are a strict, senior software architect reviewing candidate architecture violations and decomposition recommendations.
Carefully decide if the situation is a true architectural violation or a valid design choice.
When decomposition is warranted, propose concise target file paths (e.g. "usecases/create-order.usecase.ts").
Respond strictly in JSON matching the schema: {"isViolation": boolean, "reason": string, "suggestedFiles": string[]}.`;

    const batch = candidatesWithPrompts.slice(0, 5);
    let index = 0;

    for (const item of batch) {
      index++;
      const baseName = item.candidate.path ? item.candidate.path.split(/[/\\\\]/).pop() : 'candidate';
      if (onStatus) {
        onStatus(`Step 3/3: Validating candidate ${index}/${batch.length} (${baseName})...`);
      }

      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
        systemPrompt
      });

      const userPrompt = `${item.prompt}\n\nIs this a real architectural violation? Output JSON with isViolation, reason, and optional suggestedFiles.`;

      try {
        const rawResponse = await session.prompt(userPrompt, {
          grammar,
          maxTokens: 150,
          temperature: 0.1
        });
        const parsed = JSON.parse(rawResponse);
        results.set(item.candidate.id, {
          isViolation: Boolean(parsed.isViolation),
          reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
          suggestedFiles: Array.isArray(parsed.suggestedFiles) ? parsed.suggestedFiles : undefined
        });
      } catch (err) {
        console.warn('[validateCandidatesWithLlama] Failed to validate item:', item.candidate.id, err);
        results.set(item.candidate.id, { isViolation: true });
      }
    }
  } finally {
    try {
      await context.dispose();
    } catch {}
  }

  return results;
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

export interface FileAnalysisContext {
  path: string;
  isFolder?: boolean;
  fileList?: string[];
  category?: string;
  description?: string;
  loc?: number;
  fanIn?: number;
  fanOut?: number;
  instability?: number;
  symbols?: string[];
  dependencies?: string[];
  dependents?: string[];
  sourceCodeSnippet?: string;
}

export async function runLocalFileAnalysis(
  modelPath: string,
  contextData: FileAnalysisContext,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const { getLlama, LlamaChatSession } = await getLlamaModule();

  if (!llamaInstance) {
    llamaInstance = await getLlama();
  }

  if (!loadedModel || currentModelPath !== modelPath) {
    if (loadedModel) {
      try {
        await loadedModel.dispose();
      } catch {}
      loadedModel = null;
    }
    loadedModel = await llamaInstance.loadModel({ modelPath });
    currentModelPath = modelPath;
  }

  const context = await loadedModel.createContext({
    contextSize: 2048
  });

  try {
    const systemPrompt = `You are a Principal Software Architect and Refactoring Specialist.
You analyze architectural code metrics and structural concerns in TypeScript/JavaScript projects, providing sharp, concrete refactoring guidance.

CRITICAL INSTRUCTIONS:
- Analyze the real files, classes, functions, and architectural layers described in the context.
- Domain Realism: If a module handles webhooks, payments, or third-party integrations (e.g. Stripe, BullMQ queues, notifications), depending on external SDKs, queues, and database repositories is EXPECTED and correct. Do NOT claim that a payment or webhook service shouldn't depend on payment SDKs or databases.
- Event Routers / Dispatchers: Functions that dispatch incoming events via switch/if statements (e.g. processEvent) to sub-handlers are legitimate routing patterns, not Feature Envy.
- Static analysis metrics (e.g. "dependency clusters", "graph communities", "fan-in/fan-out", "instability") are mathematical measurements of the dependency graph; they are NOT domain classes. Never invent classes named "GraphCommunity" or graph data structures.
- Focus strictly on practical, non-destructive refactorings tailored to the real code provided. Avoid repetitive boilerplate or circular steps.

Format your review in clean Markdown with:
1. 🔍 **Diagnosis & Smells** (Identify the primary architectural liability)
2. 🛠️ **Step-by-Step Refactoring Plan** (How to decouple, extract, or simplify)
3. 💡 **Target Architecture Proposal** (Suggested interfaces, split modules, or design patterns)`;

    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt
    });

    const targetType = contextData.isFolder ? 'Directory / Module' : 'File';
    const userPrompt = `Conduct an architectural code review and refactoring proposal for this ${targetType.toLowerCase()}:

Target: ${contextData.path} (${targetType})
${contextData.isFolder && contextData.fileList && contextData.fileList.length > 0 ? `Files in Directory (${contextData.fileList.length}): ${contextData.fileList.join(', ')}\n` : ''}Identified Concern: ${contextData.category || 'Architectural Hotspot'}
Description: ${contextData.description || 'N/A'}
Metrics: ${contextData.isFolder ? `File Count: ${contextData.loc ?? 'N/A'}` : `LOC: ${contextData.loc ?? 'N/A'}`}, Fan-In: ${contextData.fanIn ?? 'N/A'}, Fan-Out: ${contextData.fanOut ?? 'N/A'}, Instability: ${contextData.instability ?? 'N/A'}
Key Symbols: ${contextData.symbols && contextData.symbols.length > 0 ? contextData.symbols.slice(0, 15).join(', ') : 'None'}
Dependencies (Callees): ${contextData.dependencies && contextData.dependencies.length > 0 ? contextData.dependencies.slice(0, 8).join(', ') : 'None'}
Dependents (Callers): ${contextData.dependents && contextData.dependents.length > 0 ? contextData.dependents.slice(0, 8).join(', ') : 'None'}

${contextData.sourceCodeSnippet ? `${contextData.isFolder ? 'Directory Manifest & File Overview' : 'Source Code Preview'}:\n\`\`\`${contextData.isFolder ? 'text' : 'typescript'}\n${contextData.sourceCodeSnippet}\n\`\`\`` : ''}

Provide your concrete evaluation and refactoring guide.`;

    let fullText = '';
    await session.prompt(userPrompt, {
      maxTokens: 800,
      temperature: 0.2,
      signal,
      onTextChunk(chunk: any) {
        fullText += chunk;
        onChunk(chunk);
      }
    });

    return fullText;
  } finally {
    try {
      await context.dispose();
    } catch {}
  }
}
