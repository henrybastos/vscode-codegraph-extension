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
    client.ensureFreeModel('meta-llama/llama-3.3-70b-instruct:free'),
    'meta-llama/llama-3.3-70b-instruct:free'
  );
  assert.strictEqual(
    client.ensureFreeModel('google/gemini-2.0-flash-exp:free'),
    'google/gemini-2.0-flash-exp:free'
  );
  // Non-free model should fallback to default free model
  assert.strictEqual(
    client.ensureFreeModel('openai/gpt-4o'),
    'meta-llama/llama-3.3-70b-instruct:free'
  );
});
