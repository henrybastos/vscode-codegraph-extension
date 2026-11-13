import * as ort from 'onnxruntime-node';
import type { PreTrainedTokenizer } from '@huggingface/transformers';
import * as path from 'node:path';
import * as fs from 'node:fs';

export type SymbolRole =
  | 'event_router_webhook'
  | 'mapper_serializer'
  | 'factory_builder'
  | 'core_logic';

export type AbstractionRole =
  | 'dto_contract_schema'
  | 'domain_entity_model'
  | 'framework_entrypoint'
  | 'unused_code';

export type ModuleRole =
  | 'composition_root_wiring'
  | 'cli_seed_migration'
  | 'schema_type_contract'
  | 'domain_module';

export type FolderConcernRole =
  | 'single_concern_folder'
  | 'vertical_feature_slice'
  | 'mixed_unstructured_folder';

export interface GenericClassificationResult<T extends string> {
  role: T;
  score: number;
  shouldIgnore: boolean;
}

export type ClassificationResult = GenericClassificationResult<SymbolRole>;

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

export const ABSTRACTION_ANCHORS: Record<AbstractionRole, string> = {
  dto_contract_schema:
    'Data transfer object, DTO, view model, VO, event payload, validation schema, API contract, request response type, interface definition',
  domain_entity_model:
    'Domain entity, database model, ORM record, persistence entity, aggregate root, data model',
  framework_entrypoint:
    'Application entry point, main bootstrap, VS Code extension activate deactivate, HTTP route handler, Next.js page, barrel index export',
  unused_code:
    'Unused helper function, dead utility, orphaned business service, unreferenced class',
};

export const MODULE_ANCHORS: Record<ModuleRole, string> = {
  composition_root_wiring:
    'Application bootstrap entry point, dependency injection container, NestJS app module wiring, IoC registry, router configuration, extension activation, barrel index export',
  cli_seed_migration:
    'Database migration script, seed data loader, CLI command tool, build script, developer setup utility',
  schema_type_contract:
    'Database SQL or Prisma schema, TypeScript type definitions, shared interfaces, data contracts',
  domain_module:
    'User service, business domain logic, usecase handler, data repository, API controller, React UI component',
};

export const FOLDER_CONCERN_ANCHORS: Record<FolderConcernRole, string> = {
  single_concern_folder:
    'Standard single-concern architectural folder such as usecases, controllers, services, repositories, entities, models, dtos, routes, handlers, ports, adapters, components, hooks, utils, helpers',
  vertical_feature_slice:
    'Cohesive vertical feature slice or NestJS feature module containing module definition, processor, worker, queue, route, or page files',
  mixed_unstructured_folder:
    'Unstructured directory mixing unrelated domain logic, UI components, and database persistence',
};

const MINILM_ONNX_URL =
  'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx';

function splitIdentifierWords(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[._/\\-]+/g, ' ').trim();
}

export class SymbolRoleClassifier {
  private session!: ort.InferenceSession;
  private tokenizer!: PreTrainedTokenizer;
  private roleEmbeddings = new Map<SymbolRole, Float32Array>();
  private abstractionEmbeddings = new Map<AbstractionRole, Float32Array>();
  private moduleEmbeddings = new Map<ModuleRole, Float32Array>();
  private folderEmbeddings = new Map<FolderConcernRole, Float32Array>();
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

    // Pre-compute and cache L2-normalized embeddings for all anchor sets
    await this.precomputeAnchors(ROLE_ANCHORS, this.roleEmbeddings);
    await this.precomputeAnchors(ABSTRACTION_ANCHORS, this.abstractionEmbeddings);
    await this.precomputeAnchors(MODULE_ANCHORS, this.moduleEmbeddings);
    await this.precomputeAnchors(FOLDER_CONCERN_ANCHORS, this.folderEmbeddings);

    this.initialized = true;
  }

  private async precomputeAnchors<T extends string>(
    anchors: Record<T, string>,
    targetMap: Map<T, Float32Array>
  ): Promise<void> {
    for (const [role, description] of Object.entries(anchors) as [T, string][]) {
      const vec = await this.embed(description);
      targetMap.set(role, vec);
    }
  }

  /**
   * 2. RUNTIME: Generic dot-product scorer against cached anchor vectors
   */
  private async classifyAgainst<T extends string>(
    queryText: string,
    anchorMap: Map<T, Float32Array>,
    fallbackRole: T,
    threshold: number
  ): Promise<GenericClassificationResult<T>> {
    if (!this.initialized) {
      return { role: fallbackRole, score: 0, shouldIgnore: false };
    }

    const queryVec = await this.embed(queryText);

    let bestRole: T = fallbackRole;
    let bestScore = -1;

    // Because vectors are L2-normalized, dot product === cosine similarity
    for (const [role, anchorVec] of anchorMap.entries()) {
      const score = this.dotProduct(queryVec, anchorVec);
      if (score > bestScore) {
        bestScore = score;
        bestRole = role;
      }
    }

    if (bestScore < threshold) {
      bestRole = fallbackRole;
    }

    return {
      role: bestRole,
      score: Number(bestScore.toFixed(4)),
      shouldIgnore: bestRole !== fallbackRole,
    };
  }

  /**
   * Classify a function/method role (Feature Envy filter)
   */
  async classify(fnName: string, filePath: string, threshold = 0.18): Promise<ClassificationResult> {
    const readableName = splitIdentifierWords(fnName);
    const queryText = `Function: ${readableName} | File path: ${filePath}`;
    return this.classifyAgainst(queryText, this.roleEmbeddings, 'core_logic', threshold);
  }

  /**
   * Classify an exported symbol abstraction (Dead Abstraction filter)
   */
  async classifyAbstraction(
    symbolName: string,
    kind: string,
    filePath: string,
    threshold = 0.20
  ): Promise<GenericClassificationResult<AbstractionRole>> {
    const readableName = splitIdentifierWords(symbolName);
    const readablePath = splitIdentifierWords(filePath);
    const queryText = `Exported ${kind}: ${readableName} | File: ${readablePath} (${filePath})`;
    return this.classifyAgainst(queryText, this.abstractionEmbeddings, 'unused_code', threshold);
  }

  /**
   * Classify a module/file wiring role (Unstable Foundation, Layer Bypass, God File filters)
   */
  async classifyModuleRole(
    filePath: string,
    threshold = 0.20
  ): Promise<GenericClassificationResult<ModuleRole>> {
    const readablePath = splitIdentifierWords(filePath);
    const queryText = `Source file: ${readablePath} | Path: ${filePath}`;
    return this.classifyAgainst(queryText, this.moduleEmbeddings, 'domain_module', threshold);
  }

  /**
   * Classify a directory's architectural concern (Mixed Concerns filter)
   */
  async classifyFolderConcern(
    folderPath: string,
    fileNames: string[],
    threshold = 0.20
  ): Promise<GenericClassificationResult<FolderConcernRole>> {
    const readableFolder = splitIdentifierWords(folderPath);
    const sampleFiles = fileNames.slice(0, 8).map(splitIdentifierWords).join(', ');
    const queryText = `Folder: ${readableFolder} (${folderPath}) | Files: ${sampleFiles}`;
    return this.classifyAgainst(queryText, this.folderEmbeddings, 'mixed_unstructured_folder', threshold);
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
