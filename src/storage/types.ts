import { Generated } from 'kysely';

export interface FileMetaTable {
  file_path: string;
  hash: string;
  last_indexed: number;
}

export interface NodesTable {
  id: string; // e.g. "src/auth/service.ts::validateToken"
  file_path: string;
  name: string;
  kind: 'function' | 'class' | 'interface' | 'endpoint' | 'variable' | 'type' | 'file';
  signature: string | null;
  summary: string | null;
  start_line: number;
  end_line: number;
}

export interface EdgesTable {
  source_id: string;
  target_id: string;
  relation: 'CALLS' | 'IMPORTS' | 'EXTENDS' | 'DEPENDS_ON';
}

export interface NodesFtsTable {
  rowid: Generated<number>;
  id: string;
  name: string;
  kind: string;
  signature: string;
  summary: string;
}

export interface DatabaseSchema {
  file_meta: FileMetaTable;
  nodes: NodesTable;
  edges: EdgesTable;
  nodes_fts: NodesFtsTable;
}
