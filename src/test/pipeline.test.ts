import test from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { initSqliteDb } from '../storage/db.js';
import { syncFileAst, searchSymbols } from '../storage/sync.js';
import { CodeGraphCache } from '../graph/graph-manager.js';
import { detectCyclesInSubgraph, computeNodeCoupling } from '../graph/metrics.js';
import { initTreeSitter, parseFileAst } from '../parser/treesitter.js';
import { OpenRouterClient } from '../ai/openrouter.js';
import { generateProjectFileTree, extractProjectMetadata } from '../ai/structure-scanner.js';
import { buildProjectStructurePrompt } from '../ai/prompts.js';
import { buildFileGraph, runTier0Assertions } from '../graph/assertions.js';
import { LocalGGUFModelManager } from '../models/model-manager.js';
import { SymbolRoleClassifier } from '../ai/symbol-classifier.js';
import {
  DEFAULT_RULES,
  runRuleEngine,
  GodFileRule,
  CircularCouplingRule,
  LayerBypassRule,
  MixedConcernsRule,
  UnstableFoundationRule,
  FeatureEnvyRule,
  DeadAbstractionRule,
  ApiDecompositionRule
} from '../rules/index.js';
import { DirectedGraph } from 'graphology';

test('1. SQLite & Kysely initialization and FTS5 triggers', async () => {
  const tmpDir = path.resolve('dist/test_storage');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const dbPath = path.join(tmpDir, 'test.sqlite');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const { db, rawDb } = initSqliteDb(dbPath);

  // Sync sample file AST
  const testFile = 'src/service/auth.ts';
  const symbols = [
    {
      id: `${testFile}::loginUser`,
      name: 'loginUser',
      kind: 'function' as const,
      signature: 'loginUser(username: string): Promise<string>',
      startLine: 10,
      endLine: 25
    },
    {
      id: `${testFile}::AuthService`,
      name: 'AuthService',
      kind: 'class' as const,
      signature: 'class AuthService',
      startLine: 1,
      endLine: 35
    }
  ];

  const edges = [
    {
      sourceId: `${testFile}::loginUser`,
      targetId: 'src/db/user.ts::findUserByEmail',
      relation: 'CALLS' as const
    }
  ];

  await syncFileAst(db, testFile, 'hash_123', symbols, edges);

  // Test FTS5 search
  const results = await searchSymbols(db, 'loginUser');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].name, 'loginUser');
  assert.strictEqual(results[0].file_path, testFile);

  // Test cascade delete
  await db.deleteFrom('file_meta').where('file_path', '=', testFile).execute();
  const nodesAfter = await db.selectFrom('nodes').selectAll().execute();
  assert.strictEqual(nodesAfter.length, 0, 'Nodes should cascade delete on file_meta deletion');

  rawDb.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

test('2. Graphology In-Memory Cache & Metric Traversal', async () => {
  const cache = new CodeGraphCache();

  cache.updateFileNodes(
    'a.ts',
    [
      { id: 'a.ts::fnA', name: 'fnA', kind: 'function', startLine: 1, endLine: 5 },
      { id: 'a.ts::fnB', name: 'fnB', kind: 'function', startLine: 6, endLine: 10 }
    ],
    [
      { sourceId: 'a.ts::fnA', targetId: 'a.ts::fnB', relation: 'CALLS' },
      { sourceId: 'a.ts::fnB', targetId: 'a.ts::fnA', relation: 'CALLS' } // intentional cycle
    ]
  );

  const couplingA = computeNodeCoupling(cache.graph, 'a.ts::fnA');
  assert.strictEqual(couplingA.fanIn, 1);
  assert.strictEqual(couplingA.fanOut, 1);
  assert.strictEqual(couplingA.instability, 0.5);

  const cycles = detectCyclesInSubgraph(cache.graph, ['a.ts::fnA', 'a.ts::fnB']);
  assert.strictEqual(cycles.length > 0, true, 'Cycle detection should detect circular dependency');

  const subgraph = cache.getSubgraph('a.ts::fnA', 2);
  assert.strictEqual(subgraph.nodes.length, 2);
  assert.strictEqual(subgraph.edges.length, 2);

  const contextText = cache.extractSubgraphContext('a.ts::fnA', 2);
  assert.ok(contextText.includes('fnA'));
  assert.ok(contextText.includes('fnB'));
});

test('3. Tree-sitter WASM Parser for TypeScript / TSX / JS', async () => {
  await initTreeSitter(process.cwd());

  const tsCode = `
    import { validateSession } from './session';

    export interface UserProfile {
      id: string;
      email: string;
    }

    export class AccountController {
      async handleRequest(token: string) {
        validateSession(token);
        return this.serialize();
      }

      serialize() {
        return { ok: true };
      }
    }
  `;

  const parsed = parseFileAst('src/account.ts', tsCode);
  const names = parsed.symbols.map((s) => s.name);

  assert.ok(names.includes('UserProfile'), 'Should extract interface UserProfile');
  assert.ok(names.includes('AccountController'), 'Should extract class AccountController');
  assert.ok(
    names.includes('AccountController.handleRequest'),
    'Should extract method AccountController.handleRequest'
  );

  const hasCallsEdge = parsed.edges.some(
    (e) => e.relation === 'CALLS' && e.targetId.includes('validateSession')
  );
  assert.ok(hasCallsEdge, 'Should extract CALLS edge to validateSession');
});

test('4. OpenRouter Free Model Validation', () => {
  const client = new OpenRouterClient();
  assert.strictEqual(
    client.ensureFreeModel('nvidia/nemotron-3.5-lightning:free'),
    'nvidia/nemotron-3.5-lightning:free'
  );
  assert.strictEqual(
    client.ensureFreeModel('google/gemma-4-31b-it:free'),
    'google/gemma-4-31b-it:free'
  );
  // Non-free model should fallback to default free model
  assert.strictEqual(
    client.ensureFreeModel('openai/gpt-4o'),
    'nvidia/nemotron-3.5-lightning:free'
  );
});

test('5. Project File Structure Scanner & Prompt Generation', () => {
  const { tree, stats } = generateProjectFileTree(process.cwd());
  assert.ok(stats.files > 0);
  assert.ok(stats.directories > 0);
  assert.ok(!tree.includes('node_modules/'), 'Should exclude node_modules');
  assert.ok(!tree.includes('.git/'), 'Should exclude .git');
  assert.ok(tree.includes('package.json'), 'Should include root package.json');

  const meta = extractProjectMetadata(process.cwd());
  assert.ok(meta.includes('vscode-codegraph-rag'));

  const prompt = buildProjectStructurePrompt(tree, meta);
  assert.ok(prompt.system.includes('Software Architect'));
  assert.ok(prompt.user.includes(meta));
});

test('6. Tier 0 Graphology Assertions (Cycles, Layer Bypass, SDP)', () => {
  const g = new DirectedGraph();

  // Create mock files
  g.addNode('src/components/View.tsx', { filePath: 'src/components/View.tsx', endLine: 120, kind: 'file' });
  g.addNode('src/storage/db.ts', { filePath: 'src/storage/db.ts', endLine: 80, kind: 'file' });
  g.addNode('src/core/stable.ts', { filePath: 'src/core/stable.ts', endLine: 200, kind: 'file' });
  g.addNode('src/volatile.ts', { filePath: 'src/volatile.ts', endLine: 50, kind: 'file' });
  g.addNode('a.ts', { filePath: 'a.ts', endLine: 50, kind: 'file' });
  g.addNode('b.ts', { filePath: 'b.ts', endLine: 50, kind: 'file' });

  // 1. Layer bypass edge: presentation -> infrastructure
  g.addEdge('src/components/View.tsx', 'src/storage/db.ts', { relation: 'IMPORTS' });

  // 2. Circular dependency: a -> b -> a
  g.addEdge('a.ts', 'b.ts', { relation: 'IMPORTS' });
  g.addEdge('b.ts', 'a.ts', { relation: 'IMPORTS' });

  const fileGraph = buildFileGraph(g);
  const tier0 = runTier0Assertions(fileGraph);

  const categories = tier0.deterministicHotspots.map(h => h.category);
  assert.ok(categories.includes('Circular Dependency'), 'Should detect Circular Dependency');
  assert.ok(categories.includes('Layer Bypass'), 'Should detect Layer Bypass');
  assert.ok(tier0.fileFeatureVectors.size > 0, 'Should generate file feature vectors');
  assert.ok(tier0.folderFeatureVectors.size > 0, 'Should generate folder feature vectors');
});

test('7. Local GGUF Model Manager & Path Resolution', async () => {
  const tmpDir = path.resolve('dist/test_storage');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const modelPath = LocalGGUFModelManager.getModelPath(tmpDir);
  assert.ok(modelPath.endsWith('qwen2.5-coder-0.5b-instruct-q4_k_m.gguf'), 'Should match expected GGUF filename');

  const isDownloaded = LocalGGUFModelManager.isModelDownloaded(tmpDir);
  assert.strictEqual(isDownloaded, false, 'Model should not be marked as downloaded initially');

  const sizeMb = LocalGGUFModelManager.getModelSizeMb(tmpDir);
  assert.strictEqual(sizeMb, 0);

  // Test deletion of non-existent model (graceful)
  const deleted = await LocalGGUFModelManager.deleteModel(tmpDir);
  assert.strictEqual(deleted, false);
});

test('8. Modular 7-Rule Plugin Catalog & Deterministic Ignore Filters', async () => {
  const fileGraph = new DirectedGraph();
  const symbolGraph = new DirectedGraph();

  // Setup graphs
  fileGraph.addNode('src/god.ts', { filePath: 'src/god.ts', loc: 500, symbolCount: 20, layer: 'domain' });
  fileGraph.addNode('src/constants.ts', { filePath: 'src/constants.ts', loc: 450, symbolCount: 25, layer: 'shared' });
  fileGraph.addNode('src/presentation/view.ts', { filePath: 'src/presentation/view.ts', loc: 80, symbolCount: 2, layer: 'presentation' });
  fileGraph.addNode('src/infra/repo.ts', { filePath: 'src/infra/repo.ts', loc: 80, symbolCount: 2, layer: 'infrastructure' });
  fileGraph.addNode('src/presentation/view.spec.ts', { filePath: 'src/presentation/view.spec.ts', loc: 50, symbolCount: 2, layer: 'presentation' });

  // Add edge for god.ts (outDegree > 0)
  fileGraph.addEdge('src/god.ts', 'src/infra/repo.ts', { weight: 1 });
  // constants.ts has outDegree === 0

  const ctx: any = {
    fileGraph,
    symbolGraph,
    communities: {},
    fileMetrics: new Map([
      ['src/god.ts', { loc: 500, symbolCount: 20, fanIn: 1, fanOut: 1, instability: 0.5 }],
      ['src/constants.ts', { loc: 450, symbolCount: 25, fanIn: 5, fanOut: 0, instability: 0 }],
      ['src/presentation/view.ts', { loc: 80, symbolCount: 2, fanIn: 0, fanOut: 1, instability: 1 }],
      ['src/infra/repo.ts', { loc: 80, symbolCount: 2, fanIn: 2, fanOut: 0, instability: 0 }]
    ])
  };

  // Rule 1: GodFileRule
  const godRule = new GodFileRule();
  const godCandidates = godRule.detect(fileGraph, ctx);
  assert.ok(godCandidates.some(c => c.path === 'src/god.ts'));
  assert.ok(godCandidates.some(c => c.path === 'src/constants.ts'));
  // constants.ts has outDegree === 0 and must be ignored deterministically
  const constCandidate = godCandidates.find(c => c.path === 'src/constants.ts')!;
  assert.strictEqual(godRule.shouldIgnore(constCandidate, fileGraph, ctx), true, 'Pure constants with outDegree === 0 must be ignored');
  const realGodCandidate = godCandidates.find(c => c.path === 'src/god.ts')!;
  assert.strictEqual(godRule.shouldIgnore(realGodCandidate, fileGraph, ctx), false);

  // Rule 3: LayerBypassRule
  fileGraph.addEdge('src/presentation/view.ts', 'src/infra/repo.ts', { weight: 1 });
  fileGraph.addEdge('src/presentation/view.spec.ts', 'src/infra/repo.ts', { weight: 1 });
  const bypassRule = new LayerBypassRule();
  const bypassCandidates = bypassRule.detect(fileGraph, ctx);
  assert.ok(bypassCandidates.some(c => c.path === 'src/presentation/view.ts'));
  const testCandidate = bypassCandidates.find(c => c.path === 'src/presentation/view.spec.ts');
  if (testCandidate) {
    assert.strictEqual(bypassRule.shouldIgnore(testCandidate, fileGraph, ctx), true, 'Test files must be ignored');
  }

  // Rule 4: MixedConcernsRule
  const mixedRule = new MixedConcernsRule();
  const dummyVerticalSliceCand: any = {
    path: 'src/feature',
    evidence: { files: ['order.controller.ts', 'order.module.ts', 'order.processor.ts'] }
  };
  assert.strictEqual(mixedRule.shouldIgnore(dummyVerticalSliceCand, fileGraph, ctx), true, 'Vertical slice folders must be ignored');

  const usecasesCand: any = {
    path: 'apps/users-service/src/usecases',
    evidence: { files: ['create-user.usecase.ts', 'find-user.usecase.ts'], layers: ['application'] }
  };
  assert.strictEqual(mixedRule.shouldIgnore(usecasesCand, fileGraph, ctx), true, 'Standard usecases/application-layer folder must be ignored');

  // Rule 6: FeatureEnvyRule
  symbolGraph.addNode('src/user.ts::calculateTax', { filePath: 'src/user.ts', name: 'calculateTax', kind: 'function' });
  for (let i = 0; i < 4; i++) {
    const target = `src/tax.ts::helper${i}`;
    symbolGraph.addNode(target, { filePath: 'src/tax.ts', name: `helper${i}`, kind: 'function' });
    symbolGraph.addEdge('src/user.ts::calculateTax', target, { relation: 'CALLS' });
  }
  const envyRule = new FeatureEnvyRule();
  const envyCandidates = envyRule.detect(fileGraph, ctx);
  assert.ok(envyCandidates.length > 0, 'Should detect Feature Envy when method makes >= 4 external calls');
  const testFileCand: any = { path: 'src/user.test.ts', evidence: { functionName: 'testCalculateTax' } };
  assert.strictEqual(await envyRule.shouldIgnore(testFileCand, fileGraph, ctx), true, 'Test/spec files must be ignored');

  // Rule 7: DeadAbstractionRule
  symbolGraph.addNode('src/orphan.ts::unusedHelper', {
    filePath: 'src/orphan.ts',
    name: 'unusedHelper',
    kind: 'function',
    summary: '[exported]'
  });
  const deadRule = new DeadAbstractionRule();
  const deadCandidates = deadRule.detect(fileGraph, ctx);
  assert.ok(deadCandidates.some(c => c.title.includes('unusedHelper')), 'Should detect unused exported function');
  const cronCandidate: any = {
    path: 'src/tasks.ts',
    evidence: { summary: '[exported] @Cron()', symbolName: 'handleCron' }
  };
  assert.strictEqual(deadRule.shouldIgnore(cronCandidate, fileGraph, ctx), true, '@Cron() functions must be ignored');

  const dtoCandidate: any = {
    path: 'apps/users-service/src/dtos/user.dto.ts',
    evidence: { summary: '[exported]', symbolName: 'RegisterClinicManagerDto' }
  };
  assert.strictEqual(deadRule.shouldIgnore(dtoCandidate, fileGraph, ctx), true, 'DTO classes must be ignored');
});

test('9. 3-Step Execution Loop in runRuleEngine', async () => {
  const fileGraph = new DirectedGraph();
  const symbolGraph = new DirectedGraph();

  fileGraph.addNode('src/a.ts', { filePath: 'src/a.ts', loc: 450, symbolCount: 18, layer: 'presentation' });
  fileGraph.addNode('src/db.ts', { filePath: 'src/db.ts', loc: 100, symbolCount: 5, layer: 'infrastructure' });
  fileGraph.addEdge('src/a.ts', 'src/db.ts', { weight: 1 });

  const fileMetrics = new Map([
    ['src/a.ts', { loc: 450, symbolCount: 18, fanIn: 1, fanOut: 1, instability: 0.5 }],
    ['src/db.ts', { loc: 100, symbolCount: 5, fanIn: 1, fanOut: 0, instability: 0 }]
  ]);

  let slmCalled = false;
  const hotspots = await runRuleEngine(fileGraph, symbolGraph, {}, fileMetrics, {
    rules: DEFAULT_RULES,
    validateWithSlm: async (candidates) => {
      slmCalled = true;
      const res = new Map();
      for (const c of candidates) {
        res.set(c.candidate.id, { isViolation: true, reason: 'Confirmed by test validator' });
      }
      return res;
    }
  });

  assert.ok(hotspots.length > 0, 'Should return hotspots from rules');
  assert.ok(slmCalled, 'SLM validator should be invoked for ambiguous candidates with prompts');
  assert.ok(hotspots.some(h => h.category === 'Layer Bypass'));
});

test('10. API & Granularity Decomposition Rule', () => {
  const fileGraph = new DirectedGraph();
  const symbolGraph = new DirectedGraph();

  fileGraph.addNode('src/billing.controller.ts', { filePath: 'src/billing.controller.ts', loc: 220, symbolCount: 5 });
  fileGraph.addNode('src/subscription.usecase.ts', { filePath: 'src/subscription.usecase.ts', loc: 310, symbolCount: 7 });

  // Add 4 heavy methods to billing.controller.ts
  for (let i = 0; i < 4; i++) {
    const methodId = `src/billing.controller.ts::BillingController.route${i}`;
    symbolGraph.addNode(methodId, {
      filePath: 'src/billing.controller.ts',
      name: `route${i}`,
      kind: 'method',
      summary: '@Post()',
      startLine: i * 35 + 1,
      endLine: (i + 1) * 35
    });
    // Add external calls
    for (let c = 0; c < 5; c++) {
      const extTarget = `src/db.ts::repo${i}_${c}`;
      if (!symbolGraph.hasNode(extTarget)) {
        symbolGraph.addNode(extTarget, { filePath: 'src/db.ts', name: `repo${i}_${c}`, kind: 'function' });
      }
      symbolGraph.addEdge(methodId, extTarget, { relation: 'CALLS' });
    }
  }

  // Add 6 methods to subscription.usecase.ts
  for (let i = 0; i < 6; i++) {
    const methodId = `src/subscription.usecase.ts::SubscriptionUseCase.cmd${i}`;
    symbolGraph.addNode(methodId, {
      filePath: 'src/subscription.usecase.ts',
      name: `cmd${i}`,
      kind: 'method',
      startLine: i * 50 + 1,
      endLine: (i + 1) * 50
    });
    const target = `src/service${i}.ts::call`;
    if (!symbolGraph.hasNode(target)) {
      symbolGraph.addNode(target, { filePath: `src/service${i}.ts`, name: 'call', kind: 'function' });
    }
    symbolGraph.addEdge(methodId, target, { relation: 'CALLS' });
  }

  const ctx: any = {
    fileGraph,
    symbolGraph,
    communities: {},
    fileMetrics: new Map([
      ['src/billing.controller.ts', { loc: 220, symbolCount: 5, fanIn: 1, fanOut: 20, instability: 0.95 }],
      ['src/subscription.usecase.ts', { loc: 310, symbolCount: 7, fanIn: 1, fanOut: 6, instability: 0.85 }]
    ])
  };

  const apiRule = new ApiDecompositionRule();
  const candidates = apiRule.detect(fileGraph, ctx);

  assert.ok(candidates.length >= 2, 'Should detect both fat controller and bloated usecase');
  const ctrlCand = candidates.find(c => c.path === 'src/billing.controller.ts');
  assert.ok(ctrlCand, 'Should detect fat controller candidate');
  assert.strictEqual(ctrlCand.category, 'API Decomposition');
  assert.strictEqual(ctrlCand.evidence?.pattern, 'EXTRACT_USECASES');
  assert.ok(ctrlCand.suggestedFiles && ctrlCand.suggestedFiles.length > 0, 'Should suggest extraction files');

  const usecaseCand = candidates.find(c => c.path === 'src/subscription.usecase.ts');
  assert.ok(usecaseCand, 'Should detect bloated usecase candidate');
  assert.strictEqual(usecaseCand.evidence?.pattern, 'SPLIT_HANDLERS');

  // Verify shouldIgnore
  const thinControllerCand: any = {
    path: 'src/user.controller.ts',
    evidence: {
      pattern: 'EXTRACT_USECASES',
      methods: [
        { name: 'getUser', loc: 8, externalCalls: 1 },
        { name: 'listUsers', loc: 10, externalCalls: 1 }
      ]
    }
  };
  assert.strictEqual(apiRule.shouldIgnore(thinControllerCand, fileGraph, ctx), true, 'Thin proxy controller should be ignored');

  const singleExecuteCand: any = {
    path: 'src/create-user.usecase.ts',
    evidence: {
      pattern: 'SPLIT_HANDLERS',
      methods: [
        { name: 'execute', loc: 45 },
        { name: '_validate', loc: 12 }
      ]
    }
  };
  assert.strictEqual(apiRule.shouldIgnore(singleExecuteCand, fileGraph, ctx), true, 'Single-execute use case should be ignored');

  // Verify prompt generation
  const prompt = apiRule.buildSlmValidationPrompt(ctrlCand, ctx);
  assert.ok(prompt.includes('EXTRACT_USECASES'));
  assert.ok(prompt.includes('suggestedFiles'));
});

test('11. SymbolRoleClassifier & MiniLM ONNX Semantic Role Classification', async () => {
  const modelDir = path.resolve('dist/test_storage/minilm');
  const classifier = new SymbolRoleClassifier();

  await classifier.init(modelDir);
  assert.strictEqual(classifier.isInitialized(), true, 'Classifier must be marked initialized');

  // Test 1: Event router / webhook
  const webhookRes = await classifier.classify(
    'processEvent',
    'apps/payment-service/src/usecases/handle-stripe-webhook/handle-stripe-webhook.usecase.ts'
  );
  assert.strictEqual(webhookRes.role, 'event_router_webhook');
  assert.strictEqual(webhookRes.shouldIgnore, true);

  // Test 2: Mapper / serializer
  const mapperRes = await classifier.classify('toUserResponseDto', 'src/mappers/user.mapper.ts');
  assert.strictEqual(mapperRes.role, 'mapper_serializer');
  assert.strictEqual(mapperRes.shouldIgnore, true);

  // Test 3: Factory / builder
  const builderRes = await classifier.classify('buildPaymentPayload', 'src/builders/payment.builder.ts');
  assert.strictEqual(builderRes.role, 'factory_builder');
  assert.strictEqual(builderRes.shouldIgnore, true);

  // Test 4: Core business logic
  const logicRes = await classifier.classify('calculateQuarterlyTax', 'src/services/tax-calculator.ts');
  assert.strictEqual(logicRes.role, 'core_logic');
  assert.strictEqual(logicRes.shouldIgnore, false);

  // Test 5: Verify FeatureEnvyRule.shouldIgnore with classifier
  const envyRule = new FeatureEnvyRule();
  const webhookCandidate: any = {
    path: 'apps/payment-service/src/usecases/handle-stripe-webhook/handle-stripe-webhook.usecase.ts',
    evidence: { functionName: 'processEvent' }
  };
  const ctxWithClassifier: any = { roleClassifier: classifier };
  const shouldIgnoreWebhook = await envyRule.shouldIgnore(webhookCandidate, new DirectedGraph(), ctxWithClassifier);
  assert.strictEqual(shouldIgnoreWebhook, true);
  assert.strictEqual(webhookCandidate.evidence.inferredRole, 'event_router_webhook');

  const logicCandidate: any = {
    path: 'src/services/tax-calculator.ts',
    evidence: { functionName: 'calculateQuarterlyTax' }
  };
  const shouldIgnoreLogic = await envyRule.shouldIgnore(logicCandidate, new DirectedGraph(), ctxWithClassifier);
  assert.strictEqual(shouldIgnoreLogic, false);
  assert.strictEqual(logicCandidate.evidence.inferredRole, 'core_logic');
});


