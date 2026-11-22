import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const guide = readFileSync(resolve(root, 'apps/docs/src/content/docs/guides/plugins.md'), 'utf8');

/** Prettier may wrap lines differently in the guide and the source, so compare without layout. */
const squash = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
    .replace(/, \]/g, ' ]')
    .replace(/\[ /g, '[')
    .replace(/ \]/g, ']')
    .trim();

/** Code fences with a `title="path"`: their text must be an exact excerpt of that file. */
function titledBlocks(markdown: string): Array<{ path: string; code: string }> {
  const blocks: Array<{ path: string; code: string }> = [];
  const pattern = /^```[a-z]*\s+title="([^"]+)"\n([\s\S]*?)\n```$/gm;
  for (const match of markdown.matchAll(pattern)) {
    blocks.push({ path: match[1]!, code: match[2]! });
  }
  return blocks;
}

describe('plugin guide code blocks', () => {
  const blocks = titledBlocks(guide);

  it('has blocks from the example plugin', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const block of blocks) expect(block.path.startsWith('plugins/example-notes/')).toBe(true);
  });

  it.each(blocks.map((b) => [b.path, b] as const))('%s matches the source', (_path, block) => {
    const source = readFileSync(resolve(root, block.path), 'utf8');
    expect(squash(source)).toContain(squash(block.code));
  });
});
