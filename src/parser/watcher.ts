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

export const IGNORED_FOLDERS = new Set([
  'node_modules',
  '.pnpm',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.output',
  '.svelte-kit',
  '.git',
  '.github',
  'coverage',
  '.cache',
  'tmp',
  'temp',
  '.idea',
  '.vscode'
]);

export function isIgnoredPath(filePath: string): boolean {
  if (!filePath) return false;
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  const segments = norm.split('/').filter(Boolean);
  return segments.some((seg) => IGNORED_FOLDERS.has(seg) || seg.startsWith('.next') || seg.startsWith('.turbo') || seg.startsWith('.nuxt'));
}

export async function purgeIgnoredFiles(db: Kysely<DatabaseSchema>, graphCache: CodeGraphCache): Promise<number> {
  let purgedCount = 0;

  // 1. Purge from in-memory Graphology graph directly
  const nodesToDrop: string[] = [];
  graphCache.graph.forEachNode((nodeId, attrs: any) => {
    const p = attrs.filePath || (attrs.kind === 'file' ? nodeId : null);
    if (p && isIgnoredPath(p)) {
      nodesToDrop.push(nodeId);
    }
  });
  for (const id of nodesToDrop) {
    graphCache.graph.dropNode(id);
  }

  // 2. Purge from DB file_meta
  const fileMetas = await db.selectFrom('file_meta').select(['file_path']).execute();
  for (const fm of fileMetas) {
    if (isIgnoredPath(fm.file_path)) {
      await removeFileFromDb(db, fm.file_path);
      purgedCount++;
    }
  }

  // 3. Purge any orphan/stale nodes from DB
  const dbNodes = await db.selectFrom('nodes').select(['file_path']).distinct().execute();
  for (const n of dbNodes) {
    if (n.file_path && isIgnoredPath(n.file_path)) {
      await removeFileFromDb(db, n.file_path);
    }
  }

  return purgedCount;
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

    if (isIgnoredPath(relativePath)) {
      return { indexed: false, symbolCount: 0 };
    }

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
    if (isIgnoredPath(filePath)) {
      return;
    }

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
