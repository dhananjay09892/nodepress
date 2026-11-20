import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractHooks, renderHooksReference, type HookEntry } from './hooks-reference.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const roots = ['packages', 'plugins', 'apps/server'];

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) yield path;
  }
}

const entries: HookEntry[] = [];
for (const base of roots) {
  for (const path of sources(join(root, base))) {
    const text = readFileSync(path, 'utf8');
    if (!/interface (ActionMap|FilterMap)/.test(text)) continue;
    entries.push(...extractHooks(text, relative(root, path)));
  }
}

const out = join(root, 'apps/docs/src/content/docs/reference/hooks.md');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, renderHooksReference(entries));
console.log(`Wrote ${entries.length} hooks to ${relative(root, out)}`);
