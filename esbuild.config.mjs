import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const isWatch = process.argv.includes('--watch');

// Ensure dist and grammars directories exist
const distDir = path.resolve('dist');
const grammarsDir = path.resolve('dist/grammars');
if (!fs.existsSync(grammarsDir)) {
  fs.mkdirSync(grammarsDir, { recursive: true });
}

// Copy schema.sql to dist
if (fs.existsSync('src/storage/schema.sql')) {
  fs.copyFileSync('src/storage/schema.sql', path.join(distDir, 'schema.sql'));
  console.log('Copied schema.sql to dist');
}

// Copy wasm grammars directly
const wasmFiles = [
  { src: 'node_modules/web-tree-sitter/tree-sitter.wasm', dest: 'tree-sitter.wasm' },
  { src: 'node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm', dest: 'tree-sitter-typescript.wasm' },
  { src: 'node_modules/tree-sitter-typescript/tree-sitter-tsx.wasm', dest: 'tree-sitter-tsx.wasm' },
  { src: 'node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm', dest: 'tree-sitter-javascript.wasm' }
];

for (const { src, dest } of wasmFiles) {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(grammarsDir, dest));
    console.log(`Copied ${dest} to dist/grammars/`);
  } else {
    console.warn(`Warning: WASM not found at ${src}`);
  }
}

// Build extension bundle
const buildOpts = {
  entryPoints: [
    { in: 'src/extension.ts', out: 'extension' }
  ],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile: 'dist/extension.js',
  external: ['vscode', 'node:sqlite'],
  sourcemap: true,
  logLevel: 'info'
};

// Also build test file if present
if (fs.existsSync('src/test/pipeline.test.ts')) {
  await esbuild.build({
    entryPoints: ['src/test/pipeline.test.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    outfile: 'dist/test/pipeline.test.js',
    external: ['vscode', 'node:sqlite'],
    sourcemap: true
  });
  console.log('Built dist/test/pipeline.test.js');
}

if (isWatch) {
  const ctx = await esbuild.context(buildOpts);
  await ctx.watch();
  console.log('Watching extension host for changes...');
} else {
  await esbuild.build(buildOpts);
}
