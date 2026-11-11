import Parser from 'web-tree-sitter';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ParsedSymbol, ParsedEdge } from '../storage/sync.js';

let isInitialized = false;
let tsLanguage: Parser.Language | null = null;
let tsxLanguage: Parser.Language | null = null;
let jsLanguage: Parser.Language | null = null;
let parser: Parser | null = null;

export async function initTreeSitter(extensionPath: string): Promise<void> {
  if (isInitialized && parser) return;

  // Search locations for tree-sitter.wasm
  const wasmCandidates = [
    path.join(extensionPath, 'dist', 'grammars', 'tree-sitter.wasm'),
    path.join(extensionPath, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm'),
    path.join(extensionPath, 'dist', 'tree-sitter.wasm')
  ];

  let wasmBinaryPath = wasmCandidates.find((p) => fs.existsSync(p));
  await Parser.init({
    locateFile(scriptName: string) {
      if (wasmBinaryPath && scriptName === 'tree-sitter.wasm') {
        return wasmBinaryPath;
      }
      return path.join(extensionPath, 'dist', 'grammars', scriptName);
    }
  });

  parser = new Parser();

  const loadLang = async (langName: string): Promise<Parser.Language | null> => {
    const candidates = [
      path.join(extensionPath, 'dist', 'grammars', `${langName}.wasm`),
      path.join(extensionPath, 'node_modules', 'tree-sitter-typescript', `${langName}.wasm`),
      path.join(extensionPath, 'node_modules', 'tree-sitter-javascript', `${langName}.wasm`)
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        try {
          return await Parser.Language.load(c);
        } catch (e) {
          console.warn(`Failed to load grammar ${c}:`, e);
        }
      }
    }
    return null;
  };

  tsLanguage = await loadLang('tree-sitter-typescript');
  tsxLanguage = await loadLang('tree-sitter-tsx');
  jsLanguage = await loadLang('tree-sitter-javascript');
  isInitialized = true;
}

export function parseFileAst(
  filePath: string,
  sourceCode: string
): { symbols: ParsedSymbol[]; edges: ParsedEdge[] } {
  if (!parser) {
    throw new Error('Tree-sitter parser not initialized. Call initTreeSitter() first.');
  }

  const ext = path.extname(filePath).toLowerCase();
  let lang: Parser.Language | null = null;

  if (ext === '.ts') {
    lang = tsLanguage;
  } else if (ext === '.tsx') {
    lang = tsxLanguage || tsLanguage;
  } else if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
    lang = jsLanguage || tsLanguage;
  }

  if (!lang) {
    return { symbols: [], edges: [] };
  }

  parser.setLanguage(lang);
  const tree = parser.parse(sourceCode);
  const rootNode = tree.rootNode;

  const symbols: ParsedSymbol[] = [];
  const edges: ParsedEdge[] = [];
  const symbolMap = new Map<string, ParsedSymbol>();
  const importMap = new Map<string, string>(); // imported identifier -> module / source specifier

  // Add file-level module symbol
  const lineCount = sourceCode.split('\n').length;
  symbols.push({
    id: filePath,
    name: path.basename(filePath),
    kind: 'file',
    signature: filePath,
    startLine: 1,
    endLine: lineCount
  });

  // First pass: Traverse AST and extract imports, functions, classes, interfaces, types
  function traverse(node: Parser.SyntaxNode, currentParentSymbol?: ParsedSymbol) {
    const type = node.type;

    // Handle imports: import { a, b } from './module'
    if (type === 'import_statement') {
      const sourceNode = node.childForFieldName('source');
      const moduleSpecifier = sourceNode ? sourceNode.text.replace(/['"]/g, '') : '';
      const isTypeOnly = node.text.startsWith('import type') || node.children.some(c => c.type === 'type');
      if (moduleSpecifier) {
        const resolvedModule = resolveImportPath(moduleSpecifier, filePath);
        if (resolvedModule && !resolvedModule.startsWith('package:')) {
          edges.push({
            sourceId: filePath,
            targetId: resolvedModule,
            relation: isTypeOnly ? 'IMPORTS_TYPE' : 'IMPORTS'
          });
        }
      }
      for (const child of node.namedChildren) {
        if (child.type === 'import_clause') {
          for (const spec of child.namedChildren) {
            if (spec.type === 'named_imports') {
              for (const item of spec.namedChildren) {
                if (item.type === 'import_specifier') {
                  const importedName = item.childForFieldName('name')?.text;
                  if (importedName) {
                    importMap.set(importedName, moduleSpecifier);
                  }
                }
              }
            } else if (spec.type === 'identifier') {
              importMap.set(spec.text, moduleSpecifier);
            }
          }
        }
      }
      return;
    }

    // Handle re-exports: export { x } from './module'
    if (type === 'export_statement') {
      const sourceNode = node.childForFieldName('source');
      if (sourceNode) {
        const moduleSpecifier = sourceNode.text.replace(/['"]/g, '');
        const resolvedModule = resolveImportPath(moduleSpecifier, filePath);
        if (resolvedModule && !resolvedModule.startsWith('package:')) {
          const isBarrel = path.basename(filePath).startsWith('index.');
          edges.push({
            sourceId: filePath,
            targetId: resolvedModule,
            relation: isBarrel ? 'RE_EXPORTS' : 'IMPORTS'
          });
        }
        return;
      }
    }

    let detectedSymbol: ParsedSymbol | null = null;
    const meta = extractSymbolMetadata(node);
    const metaTag = [meta.isExported ? '[exported]' : '', ...meta.decorators].filter(Boolean).join(' ') || undefined;

    if (type === 'function_declaration' || type === 'generator_function_declaration') {
      const nameNode = node.childForFieldName('name');
      const name = nameNode ? nameNode.text : 'anonymous';
      const id = `${filePath}::${name}`;
      detectedSymbol = {
        id,
        name,
        kind: 'function',
        signature: extractSignature(node, sourceCode),
        summary: metaTag,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1
      };
    } else if (type === 'class_declaration') {
      const nameNode = node.childForFieldName('name');
      const name = nameNode ? nameNode.text : 'AnonymousClass';
      const id = `${filePath}::${name}`;
      detectedSymbol = {
        id,
        name,
        kind: 'class',
        signature: `class ${name}`,
        summary: metaTag,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1
      };

      // Check class heritage (extends / implements)
      for (const child of node.namedChildren) {
        if (child.type === 'class_heritage') {
          for (const heritageChild of child.namedChildren) {
            if (heritageChild.type === 'extends_clause' || heritageChild.type === 'implements_clause') {
              for (const typeRef of heritageChild.namedChildren) {
                const targetName = typeRef.text.trim();
                const targetId = resolveTargetId(targetName, filePath, importMap);
                edges.push({
                  sourceId: id,
                  targetId,
                  relation: heritageChild.type === 'extends_clause' ? 'EXTENDS' : 'DEPENDS_ON'
                });
              }
            }
          }
        }
      }
    } else if (type === 'method_definition') {
      const nameNode = node.childForFieldName('name');
      const name = nameNode ? nameNode.text : 'method';
      const parentName = currentParentSymbol ? currentParentSymbol.name : 'Unknown';
      const id = `${filePath}::${parentName}.${name}`;
      detectedSymbol = {
        id,
        name: `${parentName}.${name}`,
        kind: 'function',
        signature: extractSignature(node, sourceCode),
        summary: metaTag,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1
      };
      if (currentParentSymbol) {
        edges.push({
          sourceId: currentParentSymbol.id,
          targetId: id,
          relation: 'DEPENDS_ON'
        });
      }
    } else if (type === 'interface_declaration') {
      const nameNode = node.childForFieldName('name');
      const name = nameNode ? nameNode.text : 'Interface';
      const id = `${filePath}::${name}`;
      detectedSymbol = {
        id,
        name,
        kind: 'interface',
        signature: `interface ${name}`,
        summary: metaTag,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1
      };
    } else if (type === 'type_alias_declaration') {
      const nameNode = node.childForFieldName('name');
      const name = nameNode ? nameNode.text : 'Type';
      const id = `${filePath}::${name}`;
      detectedSymbol = {
        id,
        name,
        kind: 'type',
        signature: `type ${name}`,
        summary: metaTag,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1
      };
    } else if (type === 'lexical_declaration' || type === 'variable_declaration') {
      // Check for arrow function or const fn = () => {}
      for (const declarator of node.namedChildren) {
        if (declarator.type === 'variable_declarator') {
          const nameNode = declarator.childForFieldName('name');
          const valueNode = declarator.childForFieldName('value');
          if (nameNode && valueNode) {
            const name = nameNode.text;
            const isArrow = valueNode.type === 'arrow_function' || valueNode.type === 'function_expression';
            if (isArrow) {
              const id = `${filePath}::${name}`;
              detectedSymbol = {
                id,
                name,
                kind: 'function',
                signature: extractSignature(valueNode, sourceCode, name),
                summary: metaTag,
                startLine: declarator.startPosition.row + 1,
                endLine: declarator.endPosition.row + 1
              };
            }
          }
        }
      }
    }

    if (detectedSymbol) {
      symbols.push(detectedSymbol);
      symbolMap.set(detectedSymbol.id, detectedSymbol);
    }

    const activeSymbol = detectedSymbol || currentParentSymbol;

    // Second pass inside function/method bodies: extract CALLS edges
    if (activeSymbol && (type === 'call_expression')) {
      const functionNode = node.childForFieldName('function');
      if (functionNode) {
        const fullCallee = functionNode.text;
        const isThis = fullCallee.startsWith('this.');
        let calleeName = fullCallee;
        if (calleeName.includes('.')) {
          const parts = calleeName.split('.');
          calleeName = parts[parts.length - 1];
        }
        if (calleeName && calleeName.length > 1 && !isJsBuiltin(calleeName)) {
          if (isThis) {
            edges.push({
              sourceId: activeSymbol.id,
              targetId: `${filePath}::${calleeName}`,
              relation: 'CALLS_LOCAL'
            });
          } else {
            const targetId = resolveTargetId(calleeName, filePath, importMap);
            edges.push({
              sourceId: activeSymbol.id,
              targetId,
              relation: 'CALLS'
            });
          }
        }
      }
    }

    for (const child of node.children) {
      traverse(child, activeSymbol);
    }
  }

  traverse(rootNode);

  return { symbols, edges };
}

function extractSymbolMetadata(node: Parser.SyntaxNode): { isExported: boolean; decorators: string[] } {
  let isExported = false;
  let curr: Parser.SyntaxNode | null = node;
  while (curr) {
    if (curr.type === 'export_statement') {
      isExported = true;
      break;
    }
    curr = curr.parent;
  }
  const decorators: string[] = [];
  const candidates = [node, node.parent].filter(Boolean) as Parser.SyntaxNode[];
  for (const c of candidates) {
    for (const child of c.namedChildren) {
      if (child.type === 'decorator') {
        decorators.push(child.text.trim());
      }
    }
  }
  return { isExported, decorators };
}

function extractSignature(node: Parser.SyntaxNode, sourceCode: string, fallbackName?: string): string {
  const params = node.childForFieldName('parameters');
  const returnType = node.childForFieldName('return_type');
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : (fallbackName || 'function');

  let paramText = params ? params.text : '()';
  let retText = returnType ? `: ${returnType.text}` : '';
  return `${name}${paramText}${retText}`;
}

export function resolveImportPath(moduleSpecifier: string, currentFilePath: string): string {
  let spec = moduleSpecifier.trim().replace(/^['"]|['"]$/g, '');
  if (spec.startsWith('.')) {
    const dir = path.posix.dirname(currentFilePath.replace(/\\/g, '/'));
    let combined = path.posix.normalize(path.posix.join(dir, spec));
    combined = combined.replace(/\.(js|jsx)$/, '');
    return combined;
  }
  if (spec.startsWith('@/')) {
    let combined = 'src/' + spec.slice(2);
    combined = combined.replace(/\.(js|jsx)$/, '');
    return combined;
  }
  return `package:${spec}`;
}

function resolveTargetId(
  targetName: string,
  currentFilePath: string,
  importMap: Map<string, string>
): string {
  const importedModule = importMap.get(targetName);
  if (importedModule) {
    const resolvedModule = resolveImportPath(importedModule, currentFilePath);
    return `${resolvedModule}::${targetName}`;
  }
  return `${currentFilePath}::${targetName}`;
}

const JS_BUILTINS = new Set([
  'log', 'warn', 'error', 'info', 'debug', 'push', 'pop', 'shift', 'unshift',
  'slice', 'splice', 'map', 'filter', 'reduce', 'forEach', 'includes', 'indexOf',
  'join', 'split', 'replace', 'trim', 'toLowerCase', 'toUpperCase', 'keys', 'values',
  'entries', 'assign', 'resolve', 'reject', 'then', 'catch', 'finally', 'json',
  'stringify', 'parse', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'
]);

function isJsBuiltin(name: string): boolean {
  return JS_BUILTINS.has(name);
}
