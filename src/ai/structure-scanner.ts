import * as fs from 'node:fs';
import * as path from 'node:path';

// Blacklisted directories that contain heavy vendor or build code
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.pnpm',
  '.git',
  '.github',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.source',
  'coverage',
  '.cache',
  '.vscode',
  '.idea',
  'target',
  'vendor',
  '.temp',
  'tmp'
]);

// Ignored file extensions / patterns
const IGNORED_EXTENSIONS = new Set([
  '.lock',
  '.tsbuildinfo',
  '.map',
  '.log',
  '.sqlite',
  '.db',
  '.db-wal',
  '.db-shm',
  '.DS_Store'
]);

export interface FileTreeOptions {
  maxDepth?: number;
  maxFilesPerDir?: number;
}

/**
 * Recursively scans directory and builds an ASCII tree representing
 * the workspace architecture without giant vendor/dist folders.
 */
export function generateProjectFileTree(
  dirPath: string,
  options: FileTreeOptions = {}
): { tree: string; stats: { directories: number; files: number } } {
  const maxDepth = options.maxDepth ?? 5;
  const maxFilesPerDir = options.maxFilesPerDir ?? 40;

  let dirCount = 0;
  let fileCount = 0;

  function walk(currentDir: string, prefix: string, depth: number): string[] {
    if (depth > maxDepth) {
      return [`${prefix}... (max depth reached)`];
    }

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (err) {
      return [`${prefix}[unreadable]`];
    }

    // Filter out ignored dirs and noise files
    const validDirs: fs.Dirent[] = [];
    const validFiles: fs.Dirent[] = [];

    for (const entry of entries) {
      const name = entry.name;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(name) && !name.startsWith('.next')) {
          validDirs.push(entry);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(name);
        if (!IGNORED_EXTENSIONS.has(ext) && !name.endsWith('.lock') && !name.endsWith('.log')) {
          validFiles.push(entry);
        }
      }
    }

    // Sort alphabetically: directories first, then files
    validDirs.sort((a, b) => a.name.localeCompare(b.name));
    validFiles.sort((a, b) => a.name.localeCompare(b.name));

    const lines: string[] = [];
    const totalEntries = validDirs.length + validFiles.length;

    // Process directories
    for (let i = 0; i < validDirs.length; i++) {
      const d = validDirs[i];
      dirCount++;
      const isLast = i === validDirs.length - 1 && validFiles.length === 0;
      const pointer = isLast ? '└── ' : '├── ';
      lines.push(`${prefix}${pointer}${d.name}/`);

      const nextPrefix = prefix + (isLast ? '    ' : '│   ');
      const subLines = walk(path.join(currentDir, d.name), nextPrefix, depth + 1);
      lines.push(...subLines);
    }

    // Process files (with truncation limit if directory has huge numbers of files)
    const displayedFiles = validFiles.slice(0, maxFilesPerDir);
    for (let i = 0; i < displayedFiles.length; i++) {
      const f = displayedFiles[i];
      fileCount++;
      const isLast = i === displayedFiles.length - 1 && validFiles.length <= maxFilesPerDir;
      const pointer = isLast ? '└── ' : '├── ';
      lines.push(`${prefix}${pointer}${f.name}`);
    }

    if (validFiles.length > maxFilesPerDir) {
      const remaining = validFiles.length - maxFilesPerDir;
      lines.push(`${prefix}└── ... (${remaining} more files)`);
    }

    return lines;
  }

  const rootName = path.basename(dirPath);
  const treeLines = [`${rootName}/`, ...walk(dirPath, '', 1)];

  return {
    tree: treeLines.join('\n'),
    stats: {
      directories: dirCount,
      files: fileCount
    }
  };
}

/**
 * Extracts key package.json / framework signals to include as context for the prompt
 */
export function extractProjectMetadata(rootPath: string): string {
  const meta: string[] = [];

  const pkgPath = path.join(rootPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.name) meta.push(`Project Name: ${pkg.name}`);
      if (pkg.dependencies) {
        const deps = Object.keys(pkg.dependencies);
        meta.push(`Dependencies: ${deps.slice(0, 15).join(', ')}${deps.length > 15 ? '...' : ''}`);
      }
      if (pkg.workspaces) {
        meta.push(`Monorepo Workspaces: ${JSON.stringify(pkg.workspaces)}`);
      }
    } catch (e) {}
  }

  const pnpmWorkspace = path.join(rootPath, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmWorkspace)) {
    meta.push('Monorepo: pnpm workspace detected');
  }

  const turboJson = path.join(rootPath, 'turbo.json');
  if (fs.existsSync(turboJson)) {
    meta.push('Build System: Turborepo detected');
  }

  return meta.length > 0 ? meta.join('\n') : 'Standard workspace project';
}
