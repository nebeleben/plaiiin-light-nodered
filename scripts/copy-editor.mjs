// Copies editor/*.html (Node-RED editor panels) into dist/ after tsc.
// No-ops gracefully if editor/ doesn't exist or has no .html files yet.
import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const editorDir = join(root, 'editor');
const distDir = join(root, 'dist');

if (!existsSync(editorDir)) {
  process.exit(0);
}

const htmlFiles = readdirSync(editorDir).filter((f) => f.endsWith('.html'));
if (htmlFiles.length === 0) {
  process.exit(0);
}

mkdirSync(distDir, { recursive: true });
for (const file of htmlFiles) {
  copyFileSync(join(editorDir, file), join(distDir, file));
}
console.log(`copy-editor: copied ${htmlFiles.length} file(s) to dist/`);
