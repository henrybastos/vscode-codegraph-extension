import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../storage/types.js';
import { syncFileAst, removeFileFromDb } from '../storage/sync.js';
import { parseFileAst } from './treesitter.js';
import type { CodeGraphCache } from '../graph/graph-manager.js';

export function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export class WorkspaceIndexer {
  private db: Kysely<DatabaseSchema>;
  private graphCache: CodeGraphCache;
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(db: Kysely<DatabaseSchema>, graphCache: CodeGraphCache) {
    this.db = db;
    this.graphCache = graphCache;
  }

  /**
   * Process a single file: compute hash, compare with DB, parse AST, sync DB and graph cache
   */
  async processFile(
    filePath: string,
    workspaceRoot: string,
    force: boolean = false
  ): Promise<{ indexed: boolean; symbolCount: number }> {
    const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');

    if (!fs.existsSync(filePath)) {
      await removeFileFromDb(this.db, relativePath);
      this.graphCache.removeFileNodes(relativePath);
      return { indexed: true, symbolCount: 0 };
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const hash = computeSha256(content);

    if (!force) {
      const existing = await this.db
        .selectFrom('file_meta')
        .select(['hash'])
        .where('file_path', '=', relativePath)
        .executeTakeFirst();

      if (existing && existing.hash === hash) {
        return { indexed: false, symbolCount: 0 };
      }
    }

    const { symbols, edges } = parseFileAst(relativePath, content);

    // Sync to SQLite
    await syncFileAst(this.db, relativePath, hash, symbols, edges);

    // Sync in-memory Graphology graph
    this.graphCache.updateFileNodes(relativePath, symbols, edges);

    return { indexed: true, symbolCount: symbols.length };
  }

  /**
   * Schedule a debounced file index (300ms debounce)
   */
  scheduleFileUpdate(
    filePath: string,
    workspaceRoot: string,
    onComplete?: (res: { indexed: boolean; symbolCount: number }) => void
  ): void {
    const existing = this.debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(filePath);
      try {
        const res = await this.processFile(filePath, workspaceRoot, true);
        if (onComplete) onComplete(res);
      } catch (err) {
        console.error(`Error indexing file ${filePath}:`, err);
      }
    }, 300);

    this.debounceTimers.set(filePath, timer);
  }

  dispose(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
