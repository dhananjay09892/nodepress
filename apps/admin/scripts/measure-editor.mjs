// Measures the block editor for docs/adr/0001-editor.md. Run in CI by
// .github/workflows/measure-editor.yml after `pnpm build`:
//   node apps/admin/scripts/measure-editor.mjs
// 1. Editor chunk size: bundles a probe that imports the editor, and a baseline with only
//    React, then reports the gzip difference (what the editor adds to the admin).
// 2. Server render round trip: envelope -> Tiptap JSON -> envelope -> HTML in plain Node,
//    with no DOM global present.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(here, '..');

async function bundle(name, source) {
  const dir = mkdtempSync(join(adminRoot, '.measure-'));
  const entry = join(dir, `${name}.tsx`);
  writeFileSync(entry, source);
  const out = join(dir, 'out');
  await build({
    root: adminRoot,
    configFile: false,
    logLevel: 'error',
    plugins: [(await import('@vitejs/plugin-react')).default()],
    build: {
      outDir: out,
      emptyOutDir: true,
      minify: true,
      lib: { entry, formats: ['es'], fileName: name },
    },
  });
  let raw = 0;
  let gz = 0;
  for (const file of readdirSync(out)) {
    if (!file.endsWith('.js')) continue;
    const buf = readFileSync(join(out, file));
    raw += buf.length;
    gz += gzipSync(buf, { level: 9 }).length;
  }
  rmSync(dir, { recursive: true, force: true });
  return { raw, gz };
}

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

const base = await bundle(
  'baseline',
  `import { createRoot } from 'react-dom/client';
   import { createElement } from 'react';
   createRoot(document.body).render(createElement('div'));`,
);
const withEditor = await bundle(
  'with-editor',
  `import { createRoot } from 'react-dom/client';
   import { createElement } from 'react';
   import { BlockEditor } from '@nodepress/editor/react';
   createRoot(document.body).render(
     createElement(BlockEditor, { value: { version: 1, blocks: [] }, onChange: () => {} }),
   );`,
);

console.log('## Bundle size (minified, gzip level 9, Vite production build)');
console.log(`React + ReactDOM only:      ${kb(base.raw)} raw, ${kb(base.gz)} gzip`);
console.log(`React + ReactDOM + editor:  ${kb(withEditor.raw)} raw, ${kb(withEditor.gz)} gzip`);
console.log(
  `Editor adds:                ${kb(withEditor.raw - base.raw)} raw, ${kb(withEditor.gz - base.gz)} gzip`,
);

// Whole admin build, for context.
const assets = join(adminRoot, 'dist', 'assets');
let total = 0;
for (const file of readdirSync(assets)) {
  if (!file.endsWith('.js')) continue;
  const gz = gzipSync(readFileSync(join(assets, file)), { level: 9 }).length;
  total += gz;
  console.log(`admin dist/assets/${file}: ${kb(gz)} gzip`);
}
console.log(`admin JS total: ${kb(total)} gzip`);

console.log('\n## Server-side render round trip (Node, no DOM)');
const noDom = typeof globalThis.document === 'undefined' && typeof globalThis.window === 'undefined';
console.log(`No document/window global: ${noDom}`);
const editor = await import(
  pathToFileURL(resolve(adminRoot, '../../packages/editor/dist/index.js')).href
);
const { createBlockRegistry, envelopeToTiptap, tiptapToEnvelope, renderBlocks, validateDocument } =
  editor;
const registry = createBlockRegistry();
const blocks = [
  { type: 'core/paragraph', content: [{ text: 'Hi ' }, { text: 'there', marks: [{ type: 'bold' }] }] },
  { type: 'core/heading', attrs: { level: 2 }, content: [{ text: 'Title' }] },
  { type: 'core/image', attrs: { src: '/uploads/a.png', alt: 'A' } },
  {
    type: 'core/list',
    attrs: { ordered: false },
    children: [{ type: 'core/list-item', content: [{ text: 'one' }] }],
  },
  { type: 'core/quote', attrs: { citation: 'Me' }, content: [{ text: 'Quote' }] },
  { type: 'core/code', attrs: { language: 'ts' }, content: [{ text: 'const a = 1;' }] },
  { type: 'core/embed', attrs: { url: 'https://youtu.be/dQw4w9WgXcQ' } },
  {
    type: 'core/columns',
    children: [
      { type: 'core/column', children: [{ type: 'core/paragraph', content: [{ text: 'L' }] }] },
      { type: 'core/column', children: [{ type: 'core/paragraph', content: [{ text: 'R' }] }] },
    ],
  },
  { type: 'core/button', attrs: { text: 'Go', href: 'https://example.com' } },
];
let failures = 0;
for (const block of blocks) {
  const doc = { version: 1, blocks: [block] };
  const back = tiptapToEnvelope(envelopeToTiptap(doc));
  const same = JSON.stringify(back) === JSON.stringify(doc);
  const issues = validateDocument(back, registry);
  const html = renderBlocks(back, registry);
  const ok = same && issues.length === 0 && html.length > 0;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${block.type}: round trip equal=${same}, issues=${issues.length}`);
  console.log(`     ${html.replace(/\n/g, ' ')}`);
}
console.log(`Round-trip failures: ${failures}`);
if (failures > 0 || !noDom) process.exit(1);
