import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../storage/types.js';
import { searchSymbols } from '../storage/sync.js';
import type { CodeGraphCache } from '../graph/graph-manager.js';
import { buildFileGraph, runTier0Assertions } from '../graph/assertions.js';
import { LocalGGUFModelManager } from '../models/model-manager.js';
import type { SymbolRoleClassifier } from '../ai/symbol-classifier.js';
import { runLocalFileAnalysis, validateCandidatesWithLlama, disposeLocalLlama } from '../ai/local-llama.js';
import { DEFAULT_RULES, ApiDecompositionRule, runRuleEngine } from '../rules/index.js';
// @ts-ignore
import louvain from 'graphology-communities-louvain';
import { purgeIgnoredFiles, isIgnoredPath } from '../parser/watcher.js';

export class CodeGraphWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codegraph.sidebarView';
  private _view?: vscode.WebviewView;
  private activeWebviews = new Set<vscode.Webview>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalStoragePath: string,
    private readonly db: Kysely<DatabaseSchema>,
    private readonly graphCache: CodeGraphCache,
    private readonly onReindex: (force?: boolean) => Promise<void>,
    private readonly roleClassifier?: SymbolRoleClassifier
  ) {}

  registerWebview(webview: vscode.Webview): void {
    this.activeWebviews.add(webview);
  }

  unregisterWebview(webview: vscode.Webview): void {
    this.activeWebviews.delete(webview);
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    this.registerWebview(webviewView.webview);

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.extensionUri,
        vscode.Uri.file(this.globalStoragePath)
      ]
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      await this.handleMessage(message, webviewView.webview);
    });

    webviewView.onDidDispose(() => {
      this.unregisterWebview(webviewView.webview);
    });
  }

  public notifyGraphUpdated(): void {
    for (const webview of this.activeWebviews) {
      try {
        webview.postMessage({ type: 'graph_updated' });
      } catch (e) {}
    }
  }

  public notifyIndexComplete(indexedCount: number, totalSymbols: number, totalFiles: number): void {
    for (const webview of this.activeWebviews) {
      try {
        webview.postMessage({
          type: 'index_complete',
          payload: { indexedCount, totalSymbols, totalFiles }
        });
      } catch (e) {}
    }
  }

  async handleMessage(message: any, webview: vscode.Webview): Promise<void> {
    switch (message.command) {
      case 'search': {
        const query = message.query || '';
        try {
          const results = await searchSymbols(this.db, query, 30);
          webview.postMessage({ type: 'search_results', payload: results });
        } catch (err: any) {
          vscode.window.showErrorMessage(`Search error: ${err.message}`);
        }
        break;
      }

      case 'select_node': {
        const nodeId = message.nodeId;
        const config = vscode.workspace.getConfiguration('codegraph');
        const depth = config.get<number>('maxTraversalDepth', 2);
        const subgraph = this.graphCache.getSubgraph(nodeId, depth);
        webview.postMessage({ type: 'subgraph_data', payload: subgraph });
        break;
      }

      case 'open_location': {
        const { filePath, startLine } = message;
        if (!filePath) return;
        try {
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (!workspaceFolders || workspaceFolders.length === 0) return;
          const cleanRelPath = filePath.replace(/^[/\\]+/, '');
          const fullPath = path.resolve(workspaceFolders[0].uri.fsPath, cleanRelPath);
          const doc = await vscode.workspace.openTextDocument(fullPath);
          const line = Math.max(0, (startLine || 1) - 1);
          const pos = new vscode.Position(line, 0);
          await vscode.window.showTextDocument(doc, {
            selection: new vscode.Range(pos, pos),
            preview: true
          });
        } catch (err: any) {
          vscode.window.showWarningMessage(`Could not open file ${filePath}: ${err.message}`);
        }
        break;
      }

      case 'get_model_status': {
        const isDownloaded = LocalGGUFModelManager.isModelDownloaded(this.globalStoragePath);
        const sizeMb = LocalGGUFModelManager.getModelSizeMb(this.globalStoragePath);
        webview.postMessage({
          type: 'model_status',
          payload: { isDownloaded, sizeMb }
        });
        break;
      }

      case 'download_model': {
        try {
          webview.postMessage({
            type: 'model_download_progress',
            payload: { pct: 0, loadedMb: 0, totalMb: 398 }
          });
          await LocalGGUFModelManager.downloadModel(
            this.globalStoragePath,
            (info) => {
              webview.postMessage({
                type: 'model_download_progress',
                payload: info
              });
            }
          );
          const sizeMb = LocalGGUFModelManager.getModelSizeMb(this.globalStoragePath);
          webview.postMessage({
            type: 'model_status',
            payload: { isDownloaded: true, sizeMb }
          });
          vscode.window.showInformationMessage('CodeGraph: Qwen 2.5 Coder 0.5B model downloaded successfully.');
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to download model: ${err.message}`);
          webview.postMessage({
            type: 'model_download_error',
            payload: err.message
          });
        }
        break;
      }

      case 'delete_model': {
        try {
          await disposeLocalLlama();
          await LocalGGUFModelManager.deleteModel(this.globalStoragePath);
          webview.postMessage({
            type: 'model_status',
            payload: { isDownloaded: false, sizeMb: 0 }
          });
          vscode.window.showInformationMessage('CodeGraph: Model deleted successfully.');
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to delete model: ${err.message}`);
        }
        break;
      }

      case 'analyse_project_local': {
        await this.runProjectAnalysis(
          webview,
          DEFAULT_RULES,
          'Extracting graph metrics & preparing local model...'
        );
        break;
      }

      case 'check_api_patterns': {
        await this.runProjectAnalysis(
          webview,
          [new ApiDecompositionRule()],
          'Checking controllers & use case method topology...'
        );
        break;
      }

      case 'analyse_file_local': {
        const { item } = message;
        if (!item || !item.path) return;

        const isDownloaded = LocalGGUFModelManager.isModelDownloaded(this.globalStoragePath);
        if (!isDownloaded) {
          vscode.window.showWarningMessage('CodeGraph: Local Qwen 2.5 Coder model is not downloaded yet.');
          webview.postMessage({
            type: 'file_analysis_error',
            payload: { id: item.id, filePath: item.path, error: 'Model not downloaded. Download it first from the header badge.' }
          });
          return;
        }

        const modelPath = LocalGGUFModelManager.getModelPath(this.globalStoragePath);
        const folders = vscode.workspace.workspaceFolders;
        let sourceCodeSnippet = '';
        let isDirectory = item.type === 'folder';
        let fileList: string[] = [];

        if (folders && folders.length > 0) {
          try {
            const cleanRelPath = item.path.replace(/^[/\\]+/, '');
            const fullPath = path.resolve(folders[0].uri.fsPath, cleanRelPath);
            if (fs.existsSync(fullPath)) {
              const stat = fs.statSync(fullPath);
              if (stat.isFile()) {
                const content = fs.readFileSync(fullPath, 'utf8');
                const lines = content.split('\n');

                const startLine = item.evidence?.startLine;
                const endLine = item.evidence?.endLine;

                if (startLine && endLine && startLine <= endLine && startLine <= lines.length) {
                  const sliceStart = Math.max(0, startLine - 1);
                  const sliceEnd = Math.min(lines.length, endLine);
                  const fnLines = lines.slice(sliceStart, sliceEnd);
                  sourceCodeSnippet = `// Focal method excerpt: ${item.evidence.functionName || 'target'} (lines ${startLine}-${endLine} of ${lines.length}):\n` + fnLines.join('\n');
                } else {
                  sourceCodeSnippet = lines.slice(0, 180).join('\n');
                  if (lines.length > 180) {
                    sourceCodeSnippet += `\n// ... [remaining ${lines.length - 180} lines truncated for prompt context]`;
                  }
                }
              } else if (stat.isDirectory()) {
                isDirectory = true;
                const entries = fs.readdirSync(fullPath, { withFileTypes: true });
                const codeFiles = entries
                  .filter((e) => e.isFile() && /\.(ts|tsx|js|jsx|svelte|vue)$/.test(e.name))
                  .map((e) => e.name);
                fileList = codeFiles;

                const manifestLines: string[] = [
                  `Directory contains ${codeFiles.length} file(s):`
                ];

                for (const cf of codeFiles.slice(0, 8)) {
                  const subFilePath = path.join(fullPath, cf);
                  try {
                    const subContent = fs.readFileSync(subFilePath, 'utf8');
                    const signatures = subContent
                      .split('\n')
                      .slice(0, 30)
                      .filter((l) => /^\s*(export\s+(class|interface|type|function|const)|@)/.test(l))
                      .map((l) => l.trim().replace(/\{.*$/, ''))
                      .join('; ');
                    manifestLines.push(`- ${cf}${signatures ? ` (Exports: ${signatures.slice(0, 120)})` : ''}`);
                  } catch {
                    manifestLines.push(`- ${cf}`);
                  }
                }
                sourceCodeSnippet = manifestLines.join('\n');
              }
            }
          } catch {}
        }

        // Collect symbol and coupling topology from graph cache
        const symbols: string[] = [];
        const dependencies: string[] = [];
        const dependents: string[] = [];
        const normTarget = item.path.replace(/\\/g, '/').replace(/^[/\\]+/, '').toLowerCase();
        const targetIsFolder = isDirectory || item.type === 'folder';

        this.graphCache.graph.forEachNode((nodeId, attrs: any) => {
          const nodePath = (attrs.filePath || '').replace(/\\/g, '/').replace(/^[/\\]+/, '').toLowerCase();
          const matches = targetIsFolder
            ? nodePath === normTarget || nodePath.startsWith(normTarget + '/')
            : nodePath === normTarget;

          if (matches) {
            symbols.push(`${attrs.name} (${attrs.kind})`);
            for (const outNeighbor of this.graphCache.graph.outNeighbors(nodeId)) {
              dependencies.push(outNeighbor);
            }
            for (const inNeighbor of this.graphCache.graph.inNeighbors(nodeId)) {
              dependents.push(inNeighbor);
            }
          }
        });

        const metrics = item.metrics || {};
        const workspaceRoot = folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;

        const CATEGORY_TO_RULE_ID: Record<string, string> = {
          'Circular Dependency': 'circular-coupling',
          'Layer Bypass': 'layer-bypass',
          'God File': 'god-file',
          'Mixed Concerns': 'mixed-concerns',
          'Unstable Foundation': 'unstable-foundation',
          'Feature Envy': 'feature-envy',
          'Dead Abstraction': 'dead-abstraction',
          'API Decomposition': 'api-decomposition'
        };
        const resolvedRuleId = item.ruleId || CATEGORY_TO_RULE_ID[item.category];
        const matchedRule = DEFAULT_RULES.find((r) => r.id === resolvedRuleId);

        let customSystemPrompt: string | undefined;
        let customUserPrompt: string | undefined;
        if (matchedRule?.buildTargetedAnalysis) {
          try {
            const fileGraph = buildFileGraph(this.graphCache.graph);
            const targeted = await matchedRule.buildTargetedAnalysis({
              item,
              fileGraph,
              symbolGraph: this.graphCache.graph,
              db: this.db,
              workspaceRoot
            });
            customSystemPrompt = targeted.systemPrompt;
            customUserPrompt = targeted.userPrompt;
          } catch (err) {
            console.warn(`[CodeGraph] Targeted analysis failed for rule '${resolvedRuleId}', using generic prompt:`, err);
          }
        }

        webview.postMessage({
          type: 'file_analysis_start',
          payload: { id: item.id, filePath: item.path }
        });

        try {
          await runLocalFileAnalysis(
            modelPath,
            {
              path: item.path,
              isFolder: targetIsFolder,
              fileList,
              category: item.category,
              description: item.description,
              loc: metrics.loc,
              fanIn: metrics.fanIn,
              fanOut: metrics.fanOut,
              instability: metrics.instability,
              symbols: symbols.slice(0, 20),
              dependencies: Array.from(new Set(dependencies)).slice(0, 10),
              dependents: Array.from(new Set(dependents)).slice(0, 10),
              sourceCodeSnippet,
              customSystemPrompt,
              customUserPrompt
            },
            (chunk) => {
              webview.postMessage({
                type: 'file_analysis_chunk',
                payload: { id: item.id, filePath: item.path, chunk }
              });
            }
          );

          webview.postMessage({
            type: 'file_analysis_complete',
            payload: { id: item.id, filePath: item.path }
          });
        } catch (err: any) {
          vscode.window.showErrorMessage(`Analysis of ${item.path} failed: ${err.message}`);
          webview.postMessage({
            type: 'file_analysis_error',
            payload: { id: item.id, filePath: item.path, error: err.message }
          });
        }
        break;
      }

      case 'reindex_workspace': {
        await this.onReindex(true);
        break;
      }
    }
  }

  private async runProjectAnalysis(
    webview: vscode.Webview,
    rules: any[],
    initialStatus: string
  ): Promise<void> {
    try {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage('No active workspace folder to analyze.');
        return;
      }

      // If graph cache is empty, trigger an index first
      if (this.graphCache.graph.order === 0) {
        webview.postMessage({
          type: 'analysis_status',
          payload: { status: 'indexing', message: 'Indexing project files...' }
        });
        await this.onReindex(false);
      }

      // Ensure model is downloaded
      let modelPath = LocalGGUFModelManager.getModelPath(this.globalStoragePath);
      if (!LocalGGUFModelManager.isModelDownloaded(this.globalStoragePath)) {
        webview.postMessage({
          type: 'analysis_status',
          payload: { status: 'downloading_model', message: 'Downloading Qwen 2.5 Coder 0.5B model (~398MB)...' }
        });
        modelPath = await LocalGGUFModelManager.downloadModel(
          this.globalStoragePath,
          (info) => {
            webview.postMessage({
              type: 'model_download_progress',
              payload: info
            });
          }
        );
        const sizeMb = LocalGGUFModelManager.getModelSizeMb(this.globalStoragePath);
        webview.postMessage({
          type: 'model_status',
          payload: { isDownloaded: true, sizeMb }
        });
      }

      webview.postMessage({
        type: 'analysis_status',
        payload: { status: 'analyzing', message: initialStatus }
      });

      const startTime = performance.now();

      // Purge any stale ignored files from DB and in-memory graph
      await purgeIgnoredFiles(this.db, this.graphCache);

      // 1. Build FileGraph from in-memory graph
      const fileGraph = buildFileGraph(this.graphCache.graph);

      // 2. Run Tier 0 Graphology Assertions
      const tier0 = runTier0Assertions(fileGraph);

      let communities: Record<string, number> = {};
      try {
        communities = typeof louvain === 'function' ? louvain(fileGraph) : {};
      } catch {
        for (const f of fileGraph.nodes()) communities[f] = 0;
      }

      let totalSymbols = 0;
      fileGraph.forEachNode((_, attrs: any) => {
        totalSymbols += attrs.symbolCount || 0;
      });

      // 3. Run the modular 3-Step Architecture Rule Engine
      const hotspots = await runRuleEngine(
        fileGraph,
        this.graphCache.graph,
        communities,
        tier0.fileMetrics,
        {
          rules,
          roleClassifier: this.roleClassifier,
          validateWithSlm: async (candidatesWithPrompts) => {
            return await validateCandidatesWithLlama(
              modelPath,
              candidatesWithPrompts,
              (msg) => {
                webview.postMessage({
                  type: 'analysis_status',
                  payload: { status: 'analyzing', message: msg }
                });
              }
            );
          },
          onStatus: (msg) => {
            webview.postMessage({
              type: 'analysis_status',
              payload: { status: 'analyzing', message: msg }
            });
          }
        }
      );

      const elapsedMs = Math.round(performance.now() - startTime);

      webview.postMessage({
        type: 'hotspots_result',
        payload: {
          hotspots,
          stats: {
            fileCount: fileGraph.order,
            folderCount: tier0.folderFeatureVectors.size,
            symbolCount: totalSymbols,
            durationMs: elapsedMs
          }
        }
      });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Analysis failed: ${err.message}`);
      webview.postMessage({
        type: 'hotspots_error',
        payload: err?.message || String(err)
      });
    }
  }

  getHtmlForWebview(webview: vscode.Webview): string {
    const bundleJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'bundle.js')
    );
    const bundleCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'bundle.css')
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'unsafe-eval' 'wasm-unsafe-eval' blob: ${webview.cspSource}; worker-src blob: ${webview.cspSource}; connect-src ${webview.cspSource} blob: data: https:; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
  <link rel="stylesheet" href="${bundleCssUri}">
  <title>CodeGraph RAG</title>
</head>
<body class="p-0 m-0 overflow-hidden select-none">
  <div id="app"></div>
  <script nonce="${nonce}" src="${bundleJsUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
