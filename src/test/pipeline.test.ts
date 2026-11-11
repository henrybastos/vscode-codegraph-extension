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
import {
  DEFAULT_RULES,
  runRuleEngine,
  GodFileRule,
  CircularCouplingRule,
  LayerBypassRule,
  MixedConcernsRule,
  UnstableFoundationRule,
  FeatureEnvyRule,
  DeadAbstractionRule
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

test('8. Modular 7-Rule Plugin Catalog & Deterministic Ignore Filters', () => {
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
  const mapperCand: any = { path: 'src/mapper.ts', evidence: { functionName: 'toDto' } };
  assert.strictEqual(envyRule.shouldIgnore(mapperCand, fileGraph, ctx), true, 'Mapper/toDto functions must be ignored');

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

