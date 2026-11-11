import {
  CompiledQuery,
  DatabaseConnection,
  Driver,
  Kysely,
  QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  Dialect
} from 'kysely';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSchema } from './types.js';

class NodeSqliteConnection implements DatabaseConnection {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters } = compiledQuery;
    let stmt: StatementSync;
    try {
      stmt = this.db.prepare(sql);
    } catch (err) {
      throw new Error(`Failed to prepare SQL: "${sql}". Cause: ${err}`);
    }

    const isSelect = /^\s*(SELECT|PRAGMA|WITH)/i.test(sql);

    if (isSelect) {
      const rows = stmt.all(...(parameters as any[])) as R[];
      return { rows };
    } else {
      const info = stmt.run(...(parameters as any[]));
      return {
        rows: [],
        numAffectedRows: BigInt(info.changes),
        insertId: info.lastInsertRowid !== undefined ? BigInt(info.lastInsertRowid) : undefined
      };
    }
  }

  async *streamQuery<R>(_compiledQuery: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('Streaming is not supported for node:sqlite connection');
  }
}

class NodeSqliteDriver implements Driver {
  private db: DatabaseSync;
  private connection: NodeSqliteConnection;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.connection = new NodeSqliteConnection(db);
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('BEGIN TRANSACTION'));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('COMMIT'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('ROLLBACK'));
  }

  async releaseConnection(_connection: DatabaseConnection): Promise<void> {}

  async destroy(): Promise<void> {
    this.db.close();
  }
}

export class NodeSqliteDialect implements Dialect {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  createDriver(): Driver {
    return new NodeSqliteDriver(this.db);
  }

  createQueryCompiler(): SqliteQueryCompiler {
    return new SqliteQueryCompiler();
  }

  createAdapter(): SqliteAdapter {
    return new SqliteAdapter();
  }

  createIntrospector(db: Kysely<any>): SqliteIntrospector {
    return new SqliteIntrospector(db);
  }
}

export function initSqliteDb(dbPath: string): { db: Kysely<DatabaseSchema>; rawDb: DatabaseSync } {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const rawDb = new DatabaseSync(dbPath);
  rawDb.exec('PRAGMA foreign_keys = ON;');
  rawDb.exec('PRAGMA journal_mode = WAL;');

  // Read and apply schema
  const schemaPath = path.resolve(__dirname, 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
    rawDb.exec(schemaSql);
  } else {
    // Fallback embedded schema DDL
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS file_meta (
        file_path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        last_indexed INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        signature TEXT,
        summary TEXT,
        start_line INTEGER NOT NULL DEFAULT 0,
        end_line INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (file_path) REFERENCES file_meta(file_path) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS edges (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        PRIMARY KEY (source_id, target_id, relation),
        FOREIGN KEY (source_id) REFERENCES nodes(id) ON DELETE CASCADE
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
        id UNINDEXED,
        name,
        kind,
        signature,
        summary,
        content='nodes',
        content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
        INSERT INTO nodes_fts(rowid, id, name, kind, signature, summary) 
        VALUES (new.rowid, new.id, new.name, new.kind, coalesce(new.signature, ''), coalesce(new.summary, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
        INSERT INTO nodes_fts(nodes_fts, rowid, id, name, kind, signature, summary) 
        VALUES ('delete', old.rowid, old.id, old.name, old.kind, coalesce(old.signature, ''), coalesce(old.summary, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
        INSERT INTO nodes_fts(nodes_fts, rowid, id, name, kind, signature, summary) 
        VALUES ('delete', old.rowid, old.id, old.name, old.kind, coalesce(old.signature, ''), coalesce(old.summary, ''));
        INSERT INTO nodes_fts(rowid, id, name, kind, signature, summary) 
        VALUES (new.rowid, new.id, new.name, new.kind, coalesce(new.signature, ''), coalesce(new.summary, ''));
      END;
    `);
  }

  const db = new Kysely<DatabaseSchema>({
    dialect: new NodeSqliteDialect(rawDb)
  });

  return { db, rawDb };
}
