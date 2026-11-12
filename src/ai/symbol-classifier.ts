import * as ort from 'onnxruntime-node';
import type { PreTrainedTokenizer } from '@huggingface/transformers';
import * as path from 'node:path';
import * as fs from 'node:fs';

export type SymbolRole =
  | 'event_router_webhook'
  | 'mapper_serializer'
  | 'factory_builder'
  | 'core_logic';

export interface ClassificationResult {
  role: SymbolRole;
  score: number;
  shouldIgnore: boolean;
}

// Rich natural-language + code-cue descriptions give MiniLM strong semantic anchors
export const ROLE_ANCHORS: Record<SymbolRole, string> = {
  event_router_webhook:
    'Event handler, webhook processor, process event, message listener, queue consumer, event dispatcher, router endpoint',
  mapper_serializer:
    'Data mapper, DTO converter, entity transformer, JSON serializer, deserializer, format adapter',
  factory_builder:
    'Factory pattern, object builder, payload builder, build payload, create instance, factory method, module initializer, setup helper',
  core_logic:
    'Core business logic, domain calculation, data validation, repository query, service workflow',
};

const MINILM_ONNX_URL =
  'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx';

export class SymbolRoleClassifier {
  private session!: ort.InferenceSession;
  private tokenizer!: PreTrainedTokenizer;
  private roleEmbeddings = new Map<SymbolRole, Float32Array>();
  private initialized = false;

  public isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 1. STARTUP: Load ONNX model once and pre-compute role embeddings
   */
  async init(modelDir = path.resolve(__dirname, './models/minilm')): Promise<void> {
    if (this.initialized) return;

    if (!fs.existsSync(modelDir)) {
      fs.mkdirSync(modelDir, { recursive: true });
    }

    const modelPath = path.join(modelDir, 'model_int8.onnx');

    // Ensure model binary exists; download if missing
    if (!fs.existsSync(modelPath) || fs.statSync(modelPath).size < 10000000) {
      await this.downloadModel(modelPath);
    }

    // Load ONNX session
    this.session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
    });

    // Load AutoTokenizer via dynamic import to preserve ESM compatibility in CJS bundle
    const transformers = (await new Function('return import("@huggingface/transformers")')()) as typeof import('@huggingface/transformers');
    const AutoTokenizer = transformers.AutoTokenizer;

    // Try loading local tokenizer; fall back to Hugging Face cache
    try {
      this.tokenizer = (await AutoTokenizer.from_pretrained(modelDir, {
        local_files_only: true,
      })) as PreTrainedTokenizer;
    } catch {
      this.tokenizer = (await AutoTokenizer.from_pretrained('Xenova/all-MiniLM-L6-v2')) as PreTrainedTokenizer;
    }

    // Pre-compute and cache L2-normalized embeddings for each role
    for (const [role, description] of Object.entries(ROLE_ANCHORS) as [SymbolRole, string][]) {
      const vec = await this.embed(description);
      this.roleEmbeddings.set(role, vec);
    }

    this.initialized = true;
  }

  /**
   * 2. RUNTIME: Classify a symbol in ~2-4ms using dot product against cached role vectors
   */
  async classify(fnName: string, filePath: string, threshold = 0.18): Promise<ClassificationResult> {
    if (!this.initialized) {
      return { role: 'core_logic', score: 0, shouldIgnore: false };
    }

    // Format camelCase/snake_case into readable words + file path context
    const readableName = fnName.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
    const queryText = `Function: ${readableName} | File path: ${filePath}`;

    const queryVec = await this.embed(queryText);

    let bestRole: SymbolRole = 'core_logic';
    let bestScore = -1;

    // Because vectors are L2-normalized, dot product === cosine similarity
    for (const [role, anchorVec] of this.roleEmbeddings.entries()) {
      const score = this.dotProduct(queryVec, anchorVec);
      if (score > bestScore) {
        bestScore = score;
        bestRole = role;
      }
    }

    // Fall back to core_logic if confidence is below threshold
    if (bestScore < threshold) {
      bestRole = 'core_logic';
    }

    return {
      role: bestRole,
      score: Number(bestScore.toFixed(4)),
      shouldIgnore: bestRole !== 'core_logic',
    };
  }

  /**
   * Tokenizes text, runs ONNX inference, applies mean pooling, and normalizes vector
   */
  private async embed(text: string): Promise<Float32Array> {
    const encoded = await this.tokenizer(text, {
      padding: true,
      truncation: true,
      max_length: 128,
    });

    const inputIds = (encoded.input_ids.data || (encoded.input_ids as any).cpuData) as BigInt64Array;
    const attentionMask = (encoded.attention_mask.data || (encoded.attention_mask as any).cpuData) as BigInt64Array;
    const dims = encoded.input_ids.dims;

    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor('int64', inputIds, dims),
      attention_mask: new ort.Tensor('int64', attentionMask, dims),
    };

    // Some MiniLM exports also expect token_type_ids
    if (this.session.inputNames.includes('token_type_ids')) {
      const len = inputIds.length;
      feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(len), dims);
    }

    const outputs = await this.session.run(feeds);
    const lastHiddenState = outputs.last_hidden_state; // Shape: [1, seq_len, 384]

    return this.meanPoolAndNormalize(
      lastHiddenState.data as Float32Array,
      attentionMask,
      lastHiddenState.dims[1],
      lastHiddenState.dims[2]
    );
  }

  private meanPoolAndNormalize(
    tokenEmbeddings: Float32Array,
    attentionMask: BigInt64Array,
    seqLen: number,
    hiddenSize: number
  ): Float32Array {
    const pooled = new Float32Array(hiddenSize);
    let maskSum = 0;

    for (let t = 0; t < seqLen; t++) {
      const maskVal = Number(attentionMask[t]);
      if (maskVal === 0) continue;
      maskSum += maskVal;

      const offset = t * hiddenSize;
      for (let h = 0; h < hiddenSize; h++) {
        pooled[h] += tokenEmbeddings[offset + h] * maskVal;
      }
    }

    // Average and L2-normalize in a single pass
    let normSq = 0;
    const invMask = maskSum > 0 ? 1 / maskSum : 0;
    for (let h = 0; h < hiddenSize; h++) {
      pooled[h] *= invMask;
      normSq += pooled[h] * pooled[h];
    }

    const invNorm = normSq > 0 ? 1 / Math.sqrt(normSq) : 0;
    for (let h = 0; h < hiddenSize; h++) {
      pooled[h] *= invNorm;
    }

    return pooled;
  }

  private dotProduct(a: Float32Array, b: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      sum += a[i] * b[i];
    }
    return sum;
  }

  private async downloadModel(destinationPath: string): Promise<void> {
    const tempPath = destinationPath + '.part';
    const response = await fetch(MINILM_ONNX_URL, {
      headers: { 'User-Agent': 'VSCode-CodeGraph-Extension/1.0' },
    });

    if (!response.ok || !response.body) {
      throw new Error(`Failed to download MiniLM ONNX model: HTTP ${response.status}`);
    }

    const fileStream = fs.createWriteStream(tempPath);
    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(Buffer.from(value));
    }

    fileStream.end();
    await new Promise<void>((resolve, reject) => {
      fileStream.on('finish', () => {
        fs.renameSync(tempPath, destinationPath);
        resolve();
      });
      fileStream.on('error', reject);
    });
  }
}
