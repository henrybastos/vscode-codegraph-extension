import * as vscode from 'vscode';
import * as path from 'node:path';
import { initSqliteDb } from './storage/db.js';
import { CodeGraphCache } from './graph/graph-manager.js';
import { initTreeSitter } from './parser/treesitter.js';
import { WorkspaceIndexer, isIgnoredPath, purgeIgnoredFiles } from './parser/watcher.js';
import { OpenRouterClient } from './ai/openrouter.js';
import { SymbolRoleClassifier } from './ai/symbol-classifier.js';
import { CodeGraphWebviewProvider } from './webview/provider.js';

let indexer: WorkspaceIndexer | null = null;
let provider: CodeGraphWebviewProvider | null = null;

export async function activate(context: vscode.ExtensionContext) {
  console.log('[CodeGraph] Activating extension...');

  // 1. Setup SQLite path in extension storage
  const storageDir = context.storageUri?.fsPath || context.globalStorageUri.fsPath;
  const dbPath = path.join(storageDir, 'codegraph.sqlite');

  console.log('[CodeGraph] Initializing SQLite database at:', dbPath);
  const { db, rawDb } = initSqliteDb(dbPath);

  // 2. Initialize in-memory Graphology cache
  console.log('[CodeGraph] Hydrating Graphology cache...');
  const graphCache = new CodeGraphCache();
  await graphCache.hydrate(db);
  await purgeIgnoredFiles(db, graphCache);

  // 3. Initialize Tree-sitter WASM
  console.log('[CodeGraph] Initializing Tree-sitter WASM...');
  await initTreeSitter(context.extensionPath);
  console.log('[CodeGraph] Tree-sitter initialized successfully');

  // 4. Initialize OpenRouter client & restore secret key
  const aiClient = new OpenRouterClient();
  const savedKey = await context.secrets.get('codegraph.openRouterApiKey');
  if (savedKey) {
    aiClient.setApiKey(savedKey);
  }

  // 5. Initialize MiniLM int8 ONNX Symbol Role Classifier
  const roleClassifier = new SymbolRoleClassifier();
  const minilmDir = path.join(context.globalStorageUri.fsPath, 'models', 'minilm');
  roleClassifier.init(minilmDir).catch((err) => {
    console.warn('[CodeGraph] MiniLM role classifier background init warning:', err);
  });

  // 6. Indexer instance
  indexer = new WorkspaceIndexer(db, graphCache);

  const reindexWorkspace = async (force: boolean = false) => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'CodeGraph: Indexing workspace...',
        cancellable: false
      },
      async (progress) => {
        const root = folders[0].uri.fsPath;
        const files = await vscode.workspace.findFiles(
          '**/*.{ts,tsx,js,jsx,mjs,cjs}',
          '**/{node_modules,dist,build,out,.next,.nuxt,.turbo,.output,.svelte-kit,.git,coverage,.cache,tmp,temp}/**'
        );

        console.log(`[CodeGraph] Found ${files.length} candidate files in workspace ${root}`);
        let indexedCount = 0;
        let totalSymbols = 0;

        for (let i = 0; i < files.length; i++) {
          const fileUri = files[i];
          if (isIgnoredPath(fileUri.fsPath)) continue;

          progress.report({
            message: `${path.basename(fileUri.fsPath)} (${i + 1}/${files.length})`,
            increment: (1 / files.length) * 100
          });

          const res = await indexer!.processFile(fileUri.fsPath, root, force);
          if (res.indexed) {
            indexedCount++;
            totalSymbols += res.symbolCount;
          }
        }

        console.log(`[CodeGraph] Indexing complete: ${indexedCount} files processed, ${totalSymbols} symbols discovered.`);
        // Re-hydrate the full in-memory graph from SQLite to resolve all cross-file forward reference edges!
        await graphCache.hydrate(db);
        await purgeIgnoredFiles(db, graphCache);

        vscode.window.showInformationMessage(
          `CodeGraph: Indexed ${indexedCount} files (${totalSymbols} symbols).`
        );
        provider?.notifyIndexComplete(indexedCount, totalSymbols, files.length);
        provider?.notifyGraphUpdated();
      }
    );
  };

  // 7. Register Webview View Provider
  provider = new CodeGraphWebviewProvider(
    context.extensionUri,
    context.globalStorageUri.fsPath,
    db,
    graphCache,
    aiClient,
    reindexWorkspace,
    roleClassifier
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CodeGraphWebviewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // 7. Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('codegraph.indexWorkspace', async () => {
      await reindexWorkspace(true);
    }),

    vscode.commands.registerCommand('codegraph.openPanel', () => {
      const panel = vscode.window.createWebviewPanel(
        'codegraph.editorPanel',
        'CodeGraph Explorer',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [context.extensionUri]
        }
      );

      provider!.registerWebview(panel.webview);
      panel.webview.html = provider!.getHtmlForWebview(panel.webview);
      panel.webview.onDidReceiveMessage(async (message) => {
        await provider!.handleMessage(message, panel.webview);
      });
      panel.onDidDispose(() => {
        provider!.unregisterWebview(panel.webview);
      });
    }),

    vscode.commands.registerCommand('codegraph.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your OpenRouter API Key (sk-or-v1-...)',
        password: true,
        placeHolder: 'sk-or-v1-...'
      });
      if (key !== undefined) {
        await context.secrets.store('codegraph.openRouterApiKey', key.trim());
        aiClient.setApiKey(key.trim());
        vscode.window.showInformationMessage('OpenRouter API key saved securely.');
      }
    })
  );

  // 8. Incremental File Watcher
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx,mjs,cjs}');

  watcher.onDidChange((uri) => {
    if (isIgnoredPath(uri.fsPath)) return;
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      indexer!.scheduleFileUpdate(uri.fsPath, folders[0].uri.fsPath, () => {
        provider?.notifyGraphUpdated();
      });
    }
  });

  watcher.onDidCreate((uri) => {
    if (isIgnoredPath(uri.fsPath)) return;
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      indexer!.scheduleFileUpdate(uri.fsPath, folders[0].uri.fsPath, () => {
        provider?.notifyGraphUpdated();
      });
    }
  });

  watcher.onDidDelete((uri) => {
    if (isIgnoredPath(uri.fsPath)) return;
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      indexer!.scheduleFileUpdate(uri.fsPath, folders[0].uri.fsPath, () => {
        provider?.notifyGraphUpdated();
      });
    }
  });

  context.subscriptions.push(watcher);

  // Re-index whenever workspace folders change (e.g. user opens a folder after launch)
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await reindexWorkspace();
    })
  );

  // Run initial workspace scan on background
  setTimeout(() => {
    reindexWorkspace().catch((err) => {
      console.error('Initial CodeGraph indexing error:', err);
    });
  }, 1000);
}

export function deactivate() {
  indexer?.dispose();
}
