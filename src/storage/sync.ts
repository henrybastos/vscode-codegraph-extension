import { Kysely, sql } from 'kysely';
import type { DatabaseSchema } from './types.js';

export interface ParsedSymbol {
  id: string;
  name: string;
  kind: 'function' | 'class' | 'interface' | 'endpoint' | 'variable' | 'type';
  signature?: string;
  summary?: string;
  startLine: number;
  endLine: number;
}

export interface ParsedEdge {
  sourceId: string;
  targetId: string;
  relation: 'CALLS' | 'IMPORTS' | 'EXTENDS' | 'DEPENDS_ON';
}

export async function syncFileAst(
  db: Kysely<DatabaseSchema>,
  filePath: string,
  fileHash: string,
  symbols: ParsedSymbol[],
  edges: ParsedEdge[]
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    // 1. Upsert file metadata
    await trx
      .insertInto('file_meta')
      .values({
        file_path: filePath,
        hash: fileHash,
        last_indexed: Date.now()
      })
      .onConflict((oc) =>
        oc.column('file_path').doUpdateSet({
          hash: fileHash,
          last_indexed: Date.now()
        })
      )
      .execute();

    // 2. Cascade delete existing nodes for this file (edges cascade from source_id)
    await trx
      .deleteFrom('nodes')
      .where('file_path', '=', filePath)
      .execute();

    // 3. Batch insert new symbols
    if (symbols.length > 0) {
      await trx
        .insertInto('nodes')
        .values(
          symbols.map((s) => ({
            id: s.id,
            file_path: filePath,
            name: s.name,
            kind: s.kind,
            signature: s.signature || null,
            summary: s.summary || null,
            start_line: s.startLine,
            end_line: s.endLine
          }))
        )
        .execute();
    }

    // 4. Batch insert new edges (ignoring duplicate relations)
    if (edges.length > 0) {
      await trx
        .insertInto('edges')
        .values(
          edges.map((e) => ({
            source_id: e.sourceId,
            target_id: e.targetId,
            relation: e.relation
          }))
        )
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
  });
}

export async function removeFileFromDb(
  db: Kysely<DatabaseSchema>,
  filePath: string
): Promise<void> {
  await db
    .deleteFrom('file_meta')
    .where('file_path', '=', filePath)
    .execute();
}

export async function searchSymbols(
  db: Kysely<DatabaseSchema>,
  searchTerm: string,
  limit: number = 20
) {
  const trimmed = searchTerm.trim();
  if (!trimmed) {
    return await db
      .selectFrom('nodes')
      .select([
        'id',
        'file_path',
        'name',
        'kind',
        'signature',
        'summary',
        'start_line',
        'end_line'
      ])
      .limit(limit)
      .execute();
  }

  // Sanitize search term for FTS5 prefix match: e.g. "auth*"
  const sanitized = trimmed.replace(/["*]/g, '');
  const ftsQuery = `"${sanitized}"*`;

  try {
    const results = await db
      .selectFrom('nodes')
      .innerJoin('nodes_fts', 'nodes_fts.id', 'nodes.id')
      .select([
        'nodes.id',
        'nodes.file_path',
        'nodes.name',
        'nodes.kind',
        'nodes.signature',
        'nodes.summary',
        'nodes.start_line',
        'nodes.end_line'
      ])
      .where(sql`nodes_fts`, 'match', ftsQuery)
      .limit(limit)
      .execute();

    return results;
  } catch (err) {
    // Fallback to LIKE if FTS syntax error
    return await db
      .selectFrom('nodes')
      .select([
        'id',
        'file_path',
        'name',
        'kind',
        'signature',
        'summary',
        'start_line',
        'end_line'
      ])
      .where((eb) =>
        eb.or([
          eb('name', 'like', `%${trimmed}%`),
          eb('file_path', 'like', `%${trimmed}%`)
        ])
      )
      .limit(limit)
      .execute();
  }
}
