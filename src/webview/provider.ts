import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../storage/types.js';
import { searchSymbols } from '../storage/sync.js';
import type { CodeGraphCache } from '../graph/graph-manager.js';
import type { OpenRouterClient } from '../ai/openrouter.js';
import { buildArchitecturalAuditPrompt, buildProjectStructurePrompt } from '../ai/prompts.js';
import { generateProjectFileTree, extractProjectMetadata } from '../ai/structure-scanner.js';
import { buildFileGraph, runTier0Assertions } from '../graph/assertions.js';
import { LocalGGUFModelManager } from '../models/model-manager.js';
import { runLocalLlamaInference, disposeLocalLlama } from '../ai/local-llama.js';
import { purgeIgnoredFiles, isIgnoredPath } from '../parser/watcher.js';

export class CodeGraphWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codegraph.sidebarView';
  private _view?: vscode.WebviewView;
  private activeWebviews = new Set<vscode.Webview>();
  private currentAbortController: AbortController | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalStoragePath: string,
    private readonly db: Kysely<DatabaseSchema>,
    private readonly graphCache: CodeGraphCache,
    private readonly aiClient: OpenRouterClient,
    private readonly onReindex: (force?: boolean) => Promise<void>
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
          const fullPath = path.resolve(workspaceFolders[0].uri.fsPath, filePath);
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

      case 'analyze_architecture': {
        const nodeId = message.nodeId;
        if (this.currentAbortController) {
          this.currentAbortController.abort();
        }
        this.currentAbortController = new AbortController();

        const config = vscode.workspace.getConfiguration('codegraph');
        const depth = config.get<number>('maxTraversalDepth', 2);
        const model = config.get<string>('openRouterModel', 'google/gemma-4-31b-it:free');

        const subgraphContext = this.graphCache.extractSubgraphContext(nodeId, depth);
        const { system, user } = buildArchitecturalAuditPrompt(subgraphContext);

        webview.postMessage({ type: 'ai_start', payload: { mode: 'symbol', nodeId } });

        await this.aiClient.streamCompletion(
          [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ],
          model,
          {
            onChunk: (chunk) => {
              webview.postMessage({ type: 'ai_chunk', payload: chunk });
            },
            onComplete: () => {
              webview.postMessage({ type: 'ai_complete' });
            },
            onError: (error) => {
              webview.postMessage({ type: 'ai_error', payload: error });
              vscode.window.showErrorMessage(`AI Audit failed: ${error}`);
            }
          },
          this.currentAbortController.signal
        );
        break;
      }

      case 'analyze_project_structure': {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
          vscode.window.showWarningMessage('No active workspace folder to analyze.');
          return;
        }

        if (this.currentAbortController) {
          this.currentAbortController.abort();
        }
        this.currentAbortController = new AbortController();

        const rootPath = folders[0].uri.fsPath;
        const config = vscode.workspace.getConfiguration('codegraph');
        const model = config.get<string>('openRouterModel', 'google/gemma-4-31b-it:free');

        const { tree, stats } = generateProjectFileTree(rootPath);
        const meta = extractProjectMetadata(rootPath);
        const { system, user } = buildProjectStructurePrompt(tree, meta);

        webview.postMessage({
          type: 'ai_start',
          payload: {
            mode: 'structure',
            projectName: path.basename(rootPath),
            stats
          }
        });

        await this.aiClient.streamCompletion(
          [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ],
          model,
          {
            onChunk: (chunk) => {
              webview.postMessage({ type: 'ai_chunk', payload: chunk });
            },
            onComplete: () => {
              webview.postMessage({ type: 'ai_complete' });
            },
            onError: (error) => {
              webview.postMessage({ type: 'ai_error', payload: error });
              vscode.window.showErrorMessage(`Structure audit failed: ${error}`);
            }
          },
          this.currentAbortController.signal
        );
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
            payload: { status: 'analyzing', message: 'Extracting graph metrics & preparing local model...' }
          });

          const startTime = performance.now();

          // Purge any stale ignored files from DB and in-memory graph
          await purgeIgnoredFiles(this.db, this.graphCache);

          // 1. Build FileGraph from in-memory graph
          const fileGraph = buildFileGraph(this.graphCache.graph);

          // 2. Run Tier 0 Graphology Assertions
          const tier0 = runTier0Assertions(fileGraph);

          // 3. Collect candidates for Qwen 2.5 Coder
          const fileCandidates: any[] = [];
          for (const [filePath, m] of tier0.fileMetrics.entries()) {
            if (isIgnoredPath(filePath)) continue;
            const isCandidate =
              m.loc > 150 ||
              m.fanIn > 3 ||
              m.fanOut > 4 ||
              m.instability > 0.7 ||
              m.pagerank > 0.05 ||
              m.betweenness > 0.05 ||
              m.symbolCount > 8;

            if (isCandidate) {
              fileCandidates.push({
                path: filePath,
                loc: m.loc,
                fanIn: m.fanIn,
                fanOut: m.fanOut,
                instability: Math.round(m.instability * 100) / 100,
                pagerank: Math.round(m.pagerank * 1000) / 1000,
                betweenness: Math.round(m.betweenness * 1000) / 1000,
                symbols: m.symbolCount
              });
            }
          }

          const folderCandidates: any[] = [];
          for (const [folderPath, data] of tier0.folderFeatureVectors.entries()) {
            if (isIgnoredPath(folderPath) || folderPath === '.' || folderPath === '') continue;
            folderCandidates.push({
              path: folderPath,
              fileCount: data.files.length
            });
          }

          let totalSymbols = 0;
          fileGraph.forEachNode((_, attrs: any) => {
            totalSymbols += attrs.symbolCount || 0;
          });

          // Run native llama inference directly in Extension Host
          const hotspots = await runLocalLlamaInference(
            modelPath,
            tier0.deterministicHotspots,
            fileCandidates,
            folderCandidates,
            (msg) => {
              webview.postMessage({
                type: 'analysis_status',
                payload: { status: 'analyzing', message: msg }
              });
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
          vscode.window.showErrorMessage(`Local architecture analysis failed: ${err.message}`);
          webview.postMessage({
            type: 'hotspots_error',
            payload: err?.message || String(err)
          });
        }
        break;
      }

      case 'abort_ai': {
        if (this.currentAbortController) {
          this.currentAbortController.abort();
          this.currentAbortController = null;
        }
        break;
      }

      case 'reindex_workspace': {
        await this.onReindex(true);
        break;
      }

      case 'set_api_key': {
        await vscode.commands.executeCommand('codegraph.setApiKey');
        break;
      }
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
